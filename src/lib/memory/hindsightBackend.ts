/**
 * HindsightBackend — `MemoryBackend` adapter for a self-hosted Hindsight server.
 *
 * Hindsight (https://github.com/vectorize-io/hindsight) is a durable,
 * extraction-based memory service. It is NOT a vector store and NOT a
 * CRUD-over-REST document store, so it cannot be adapted by
 * `GenericMemoryBackend` without silently discarding its semantics. The
 * translation implemented here is explicit and one-directional per operation:
 *
 *   OmniRoute operation   →  Hindsight call
 *   ─────────────────────────────────────────────────────────────────────────
 *   initialize()          →  GET  /health                        (probe only)
 *   health()              →  GET  /health
 *   create(input)         →  POST /v1/default/banks/{bank}/memories
 *                            (retain, one item, `document_id` = stable id,
 *                             which gives Hindsight's documented upsert)
 *   get(id)               →  GET  /v1/default/banks/{bank}/documents/{id}
 *                            fallback: GET .../memories/{id}     (fact id)
 *   update(id, updates)   →  GET  .../documents/{id} then re-retain with the
 *                            same document_id (Hindsight replace semantics),
 *                            or PATCH .../memories/{id} for a fact id
 *   delete(id)            →  DELETE .../documents/{id}
 *                            fallback: PATCH .../memories/{id} {state:invalidated}
 *   list(filter)          →  GET  .../documents  (+ client-side scoping)
 *   search(config)        →  POST .../memories/recall  → one Memory per fact
 *   reflect(query)        →  POST .../reflect  (extra capability, not part of
 *                            the MemoryBackend contract)
 *
 * Semantics that deliberately do NOT map 1:1 (see docs/frameworks/MEMORY.md):
 *
 *  - Hindsight assigns memory ids itself; a caller cannot supply one. OmniRoute's
 *    stable handle is therefore the *document id*, which we derive
 *    deterministically from (apiKeyId, key) so `create` is a true upsert and
 *    `get`/`update`/`delete` are stable across calls.
 *  - Hindsight extracts facts from retained text; `search` returns those facts
 *    (its actual value) rather than echoing the retained blob.
 *  - Hindsight has no per-memory TTL; `expiresAt` is preserved in metadata and
 *    enforced on read.
 *  - Hindsight's fact types (world/experience/observation) are not OmniRoute's
 *    MemoryType enum. OmniRoute's type is preserved verbatim in metadata and is
 *    the value reported back; the Hindsight fact type is surfaced read-only.
 */

import { createHash } from "node:crypto";
import { logger } from "../../../open-sse/utils/logger.ts";
import type {
  MemoryBackend,
  CreateMemoryInput,
  MemoryFilter,
  SearchConfig,
  HealthCheckResult,
} from "./backend";
import type { Memory } from "./types";
import { MemoryType } from "./types";

const log = logger("HINDSIGHT_BACKEND");

/** Metadata keys reserved by the adapter. Prefixed to avoid colliding with user keys. */
const META = {
  key: "omniroute_key",
  type: "omniroute_type",
  apiKeyId: "omniroute_api_key_id",
  sessionId: "omniroute_session_id",
  expiresAt: "omniroute_expires_at",
  category: "omniroute_category",
  userMetadata: "omniroute_metadata",
  /** Read-only echoes of Hindsight's own fields; prefixed `hindsight_` like factType/score. */
  documentId: "hindsight_document_id",
  factType: "hindsight_fact_type",
  score: "hindsight_score",
} as const;

/** Static tag applied to every retained item so the integration is identifiable. */
const OMNIROUTE_TAG = "omniroute";

/**
 * `GET /documents` returns metadata and `text_length` but NOT the stored text, so
 * a listing has to hydrate each row from `GET /documents/{id}` to recover
 * `content`. Bounded so a large page cannot fan out without limit.
 */
const HYDRATE_CONCURRENCY = 4;
const MAX_HYDRATED_ROWS = 100;

/** Map with a fixed concurrency ceiling, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Anything that is not safe inside a path segment. */
const UNSAFE_ID_CHARS = /[^A-Za-z0-9_.-]/g;

export type RecallBudget = "low" | "mid" | "high";

export interface HindsightBackendConfig {
  /** Base URL of the Hindsight API service, e.g. `http://hindsight.internal:8888`. */
  baseUrl: string;
  /**
   * Memory bank id. Hindsight partitions all data by bank; OmniRoute uses one
   * bank per deployment. Defaults to `omniroute`.
   */
  bankId?: string;
  /**
   * Bearer token. Only needed when the server enables Hindsight's
   * `ApiKeyTenantExtension` (`HINDSIGHT_API_TENANT_EXTENSION` +
   * `HINDSIGHT_API_TENANT_API_KEY`). Hindsight disables API auth by default.
   */
  apiKey?: string;
  /** Hard timeout for read calls, ms. Default 15000. */
  timeout?: number;
  /**
   * Hard timeout for recall, ms. Default 30000.
   *
   * Recall is a multi-strategy search (semantic + keyword + graph + temporal)
   * followed by reranking, and Hindsight serialises it behind any retain /
   * consolidation work already in flight — a recall issued straight after a
   * retain has been measured at ~60s on a CPU-only host, against ~1.7s when the
   * server is idle. This bounds the damage when it is slow instead of letting the
   * request hang; the retrieval seam treats a timeout as "no durable memories"
   * and degrades to the local engine.
   */
  recallTimeout?: number;
  /**
   * Hard timeout for retain. Retain runs an LLM extraction pipeline
   * synchronously, so it needs a much larger budget than reads. Default 120000.
   */
  retainTimeout?: number;
  /** Recall budget preset forwarded to Hindsight. Default `mid`. */
  recallBudget?: RecallBudget;
  /**
   * Retain asynchronously (returns an operation id immediately). Off by default:
   * `create()` must be durable when it resolves so the caller can read the
   * memory straight back.
   */
  retainAsync?: boolean;
  /** Extra tags applied to every retained item. */
  tags?: string[];
}

interface HindsightRetainItem {
  content: string;
  document_id?: string;
  context?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  timestamp?: string;
}

interface HindsightRecallResult {
  id?: string;
  text?: string;
  type?: string;
  context?: string | null;
  document_id?: string | null;
  metadata?: Record<string, string> | null;
  tags?: string[] | null;
  scores?: { final?: number; reranker?: number | null; semantic?: number | null } | null;
  mentioned_at?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
}

interface HindsightDocument {
  id?: string;
  document_id?: string;
  original_text?: string | null;
  content?: string | null;
  /**
   * Flat metadata echoed back by Hindsight (observed on both
   * `GET /documents` and `GET /documents/{id}`).
   */
  document_metadata?: Record<string, string> | null;
  /**
   * The retain parameters Hindsight stored for this document. Observed shape is
   * `{ context, metadata }`; older/alternate shapes nest `items: [...]`.
   */
  retain_params?: {
    context?: string;
    metadata?: Record<string, string>;
    items?: HindsightRetainItem[];
  } | null;
  tags?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  memory_unit_count?: number;
}

/** Metadata may arrive flat, under retain_params, or nested per retained item. */
function pickDocumentMetadata(document: HindsightDocument): Record<string, string> {
  const flat = document.document_metadata;
  if (flat && typeof flat === "object" && Object.keys(flat).length > 0) return flat;

  const params = document.retain_params;
  const fromParams = params?.metadata;
  if (fromParams && typeof fromParams === "object" && Object.keys(fromParams).length > 0) {
    return fromParams;
  }

  const firstItem = Array.isArray(params?.items) ? params.items[0] : null;
  return firstItem?.metadata ?? {};
}

/** Error carrying the HTTP status so callers can distinguish 404 from failure. */
export class HindsightHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HindsightHttpError";
    this.status = status;
  }
}

/**
 * True when the error means "this resource does not exist here".
 *
 * Hindsight returns 404 for an unknown document or memory id, but answers 400
 * "Invalid memory_id: ... is not a valid UUID" when a *document* id is looked up
 * on the memory-unit route. Both mean the same thing to a caller probing two
 * id spaces, so they are treated alike.
 */
function isMissingResource(error: unknown): boolean {
  if (!(error instanceof HindsightHttpError)) return false;
  if (error.status === 404) return true;
  return error.status === 400 && /not a valid uuid/i.test(error.message);
}

/** Deterministic, path-safe identifier for one OmniRoute memory entry. */
export function hindsightDocumentId(apiKeyId: string, key: string): string {
  const owner = (apiKeyId || "anonymous").replace(UNSAFE_ID_CHARS, "_").slice(0, 64);
  const keyHash = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `omniroute:${owner}:${keyHash}`;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** Hindsight metadata values must be strings. */
function stringifyMetadata(input: CreateMemoryInput): Record<string, string> {
  const out: Record<string, string> = {
    [META.key]: input.key,
    [META.type]: input.type,
    [META.apiKeyId]: input.apiKeyId,
    [META.sessionId]: input.sessionId ?? "",
  };
  const expiresAt = toIso(input.expiresAt);
  if (expiresAt) out[META.expiresAt] = expiresAt;

  const user = input.metadata ?? {};
  const category = user.category;
  if (typeof category === "string" && category.length > 0) out[META.category] = category;
  try {
    out[META.userMetadata] = JSON.stringify(user);
  } catch {
    out[META.userMetadata] = "{}";
  }
  return out;
}

function buildTags(input: CreateMemoryInput, extra: string[] = []): string[] {
  const tags = new Set<string>([OMNIROUTE_TAG, ...extra]);
  if (input.apiKeyId) tags.add(`apikey:${input.apiKeyId}`);
  if (input.sessionId) tags.add(`session:${input.sessionId}`);
  if (input.type) tags.add(`type:${input.type}`);
  return Array.from(tags);
}

/** Parse the JSON envelope stored in `omniroute_metadata` back into an object. */
function parseUserMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function memoryTypeOrDefault(value: unknown): MemoryType {
  return Object.values(MemoryType).includes(value as MemoryType)
    ? (value as MemoryType)
    : MemoryType.FACTUAL;
}

export class HindsightBackend implements MemoryBackend {
  readonly id = "hindsight";
  readonly displayName = "Hindsight";

  private readonly baseUrl: string;
  private readonly bankId: string;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly retainTimeout: number;
  private readonly recallTimeout: number;
  private readonly recallBudget: RecallBudget;
  private readonly retainAsync: boolean;
  private readonly extraTags: string[];
  private initialized = false;

  constructor(config: HindsightBackendConfig) {
    if (!config.baseUrl || typeof config.baseUrl !== "string") {
      throw new Error("HindsightBackend requires a baseUrl");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.bankId = config.bankId && config.bankId.trim() ? config.bankId.trim() : "omniroute";
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 15000;
    this.retainTimeout = config.retainTimeout ?? 120000;
    this.recallTimeout = config.recallTimeout ?? 30000;
    this.recallBudget = config.recallBudget ?? "mid";
    this.retainAsync = config.retainAsync ?? false;
    this.extraTags = config.tags ?? [];
  }

  // ─── Transport ───

  private bankPath(suffix = ""): string {
    return `/v1/default/banks/${encodeURIComponent(this.bankId)}${suffix}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { timeout?: number; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.append(k, String(v));
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timeoutMs = opts.timeout ?? this.timeout;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new HindsightHttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } catch (e) {
      if (e instanceof HindsightHttpError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`Hindsight request timed out after ${timeoutMs}ms: ${method} ${path}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Lifecycle ───

  async initialize(): Promise<void> {
    const health = await this.health();
    if (!health.ok) {
      throw new Error(
        `Cannot connect to Hindsight at ${this.baseUrl}: ${health.error ?? "unhealthy"}`
      );
    }
    this.initialized = true;
    log.info("hindsight.backend.initialized", { baseUrl: this.baseUrl, bankId: this.bankId });
  }

  async shutdown(): Promise<void> {
    // The backend is a stateless HTTP client; nothing to release.
    this.initialized = false;
    log.info("hindsight.backend.shutdown");
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  async health(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await this.request<{ status?: string; database?: string }>("GET", "/health", undefined, {
        timeout: Math.min(this.timeout, 10000),
      });
      const status = typeof result?.status === "string" ? result.status : "unknown";
      if (status !== "healthy") {
        return { ok: false, latencyMs: Date.now() - start, error: `Hindsight reported status "${status}"` };
      }
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: String(e) };
    }
  }

  // ─── CRUD ───

  async create(input: CreateMemoryInput): Promise<Memory> {
    await this.ensureInitialized();

    const documentId = hindsightDocumentId(input.apiKeyId, input.key);
    const metadata = stringifyMetadata(input);
    const item: HindsightRetainItem = {
      content: input.content,
      context: input.key,
      document_id: documentId,
      metadata,
      tags: buildTags(input, this.extraTags),
    };
    const timestamp = toIso(input.expiresAt) ?? undefined;
    if (timestamp) item.timestamp = new Date().toISOString();

    await this.request(
      "POST",
      this.bankPath("/memories"),
      { items: [item], async: this.retainAsync },
      { timeout: this.retainTimeout }
    );

    const now = new Date();
    log.info("hindsight.backend.retained", { documentId, bankId: this.bankId });
    return {
      id: documentId,
      apiKeyId: input.apiKeyId,
      sessionId: input.sessionId,
      type: memoryTypeOrDefault(input.type),
      key: input.key,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? null,
      accessCount: 0,
      lastAccessedAt: null,
    };
  }

  /** Reconstruct an OmniRoute Memory from a Hindsight document record. */
  private documentToMemory(document: HindsightDocument): Memory | null {
    const id = document.id ?? document.document_id;
    if (!id) return null;

    const metadata = pickDocumentMetadata(document);
    const rawText =
      (typeof document.original_text === "string" && document.original_text) ||
      (typeof document.content === "string" && document.content) ||
      "";
    if (rawText === "") return null;

    const createdAt = toIso(document.created_at) ?? new Date().toISOString();
    const updatedAt = toIso(document.updated_at) ?? createdAt;
    const expiresAt = metadata[META.expiresAt] ? new Date(metadata[META.expiresAt]) : null;

    return {
      id,
      apiKeyId: metadata[META.apiKeyId] ?? "",
      sessionId: metadata[META.sessionId] ?? "",
      type: memoryTypeOrDefault(metadata[META.type]),
      key: metadata[META.key] ?? rawText.slice(0, 64),
      content: rawText,
      metadata: parseUserMetadata(metadata[META.userMetadata]),
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
      accessCount: 0,
      lastAccessedAt: null,
    };
  }

  /** Reconstruct an OmniRoute Memory from one recalled fact. */
  private factToMemory(result: HindsightRecallResult): Memory | null {
    const id = result.id;
    const text = result.text;
    if (!id || typeof text !== "string" || text.length === 0) return null;

    const metadata = result.metadata ?? {};
    const occurred = toIso(result.occurred_start) ?? toIso(result.mentioned_at);
    const expiresAt = metadata[META.expiresAt] ? new Date(metadata[META.expiresAt]) : null;

    return {
      id,
      apiKeyId: metadata[META.apiKeyId] ?? "",
      sessionId: metadata[META.sessionId] ?? "",
      type: memoryTypeOrDefault(metadata[META.type]),
      key: metadata[META.key] ?? result.document_id ?? id,
      content: text,
      metadata: {
        ...parseUserMetadata(metadata[META.userMetadata]),
        [META.documentId]: result.document_id ?? null,
        [META.factType]: result.type ?? null,
        [META.score]: result.scores?.final ?? null,
      },
      createdAt: occurred ? new Date(occurred) : new Date(),
      updatedAt: occurred ? new Date(occurred) : new Date(),
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
      accessCount: 0,
      lastAccessedAt: null,
    };
  }

  private isExpired(memory: Memory): boolean {
    return memory.expiresAt !== null && memory.expiresAt.getTime() <= Date.now();
  }

  private async fetchDocument(id: string): Promise<HindsightDocument | null> {
    try {
      return await this.request<HindsightDocument>(
        "GET",
        this.bankPath(`/documents/${encodeURIComponent(id)}`)
      );
    } catch (e) {
      if (isMissingResource(e)) return null;
      throw e;
    }
  }

  async get(id: string): Promise<Memory | null> {
    await this.ensureInitialized();

    const document = await this.fetchDocument(id);
    if (document) {
      const memory = this.documentToMemory(document);
      if (memory) return this.isExpired(memory) ? null : memory;
    }

    // Fall back to a direct fact lookup: `search()` hands back fact ids.
    try {
      const fact = await this.request<HindsightRecallResult>(
        "GET",
        this.bankPath(`/memories/${encodeURIComponent(id)}`)
      );
      return this.factToMemory(fact);
    } catch (e) {
      if (isMissingResource(e)) return null;
      throw e;
    }
  }

  async update(id: string, updates: Partial<Omit<Memory, "id" | "createdAt">>): Promise<boolean> {
    await this.ensureInitialized();

    const document = await this.fetchDocument(id);
    if (document) {
      const current = this.documentToMemory(document);
      if (!current) return false;

      const next: CreateMemoryInput = {
        apiKeyId: updates.apiKeyId ?? current.apiKeyId,
        sessionId: updates.sessionId ?? current.sessionId,
        type: updates.type ?? current.type,
        key: updates.key ?? current.key,
        content: updates.content ?? current.content,
        metadata: updates.metadata ?? current.metadata,
        expiresAt: updates.expiresAt ?? current.expiresAt,
      };

      // Hindsight's `document_id` is an upsert key: re-retaining the same id
      // replaces the document and reprocesses it. That is the honest mapping of
      // an in-place update for an extraction-based store.
      await this.request(
        "POST",
        this.bankPath("/memories"),
        {
          items: [
            {
              content: next.content,
              context: next.key,
              document_id: id,
              metadata: stringifyMetadata(next),
              tags: buildTags(next, this.extraTags),
            },
          ],
          async: this.retainAsync,
        },
        { timeout: this.retainTimeout }
      );
      return true;
    }

    // Fact-level curation (Hindsight PATCH): text / context / state only.
    const patch: Record<string, unknown> = {};
    if (typeof updates.content === "string") patch.text = updates.content;
    if (typeof updates.key === "string") patch.context = updates.key;
    if (Object.keys(patch).length === 0) return false;

    try {
      await this.request("PATCH", this.bankPath(`/memories/${encodeURIComponent(id)}`), patch);
      return true;
    } catch (e) {
      if (isMissingResource(e)) return false;
      throw e;
    }
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    try {
      await this.request("DELETE", this.bankPath(`/documents/${encodeURIComponent(id)}`));
      return true;
    } catch (e) {
      if (!isMissingResource(e)) throw e;
    }

    // Fact deletion: Hindsight has no per-fact DELETE; invalidating is its
    // documented, reversible soft delete.
    try {
      await this.request("PATCH", this.bankPath(`/memories/${encodeURIComponent(id)}`), {
        state: "invalidated",
        reason: "deleted via OmniRoute MemoryBackend",
      });
      return true;
    } catch (e) {
      if (isMissingResource(e)) return false;
      throw e;
    }
  }

  async list(
    filter: MemoryFilter
  ): Promise<{ data: Memory[]; total: number; byType: Record<string, number> }> {
    await this.ensureInitialized();

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const response = await this.request<
      { documents?: HindsightDocument[]; items?: HindsightDocument[]; total?: number } | HindsightDocument[]
    >("GET", this.bankPath("/documents"), undefined, {
      query: { limit, offset },
    });

    const rows = Array.isArray(response)
      ? response
      : (response.documents ?? response.items ?? []);
    const total = Array.isArray(response) ? rows.length : (response.total ?? rows.length);

    // Hydrate: the list endpoint carries metadata but no stored text.
    const documents = await mapWithConcurrency(
      rows.slice(0, MAX_HYDRATED_ROWS),
      HYDRATE_CONCURRENCY,
      async (row) => {
        const id = row.id ?? row.document_id;
        if (!id) return row;
        if (typeof row.original_text === "string" && row.original_text.length > 0) return row;
        try {
          return (await this.fetchDocument(id)) ?? row;
        } catch {
          log.warn("hindsight.backend.hydrate_failed", { id });
          return row;
        }
      }
    );

    let memories = documents
      .map((row) => this.documentToMemory(row))
      .filter((m): m is Memory => m !== null && !this.isExpired(m));

    memories = this.applyFilter(memories, filter);

    const byType: Record<string, number> = {};
    for (const memory of memories) {
      byType[memory.type] = (byType[memory.type] ?? 0) + 1;
    }

    return { data: memories, total, byType };
  }

  /** Client-side scoping. Hindsight only filters server-side by tag/document/type. */
  private applyFilter(memories: Memory[], filter: MemoryFilter): Memory[] {
    let out = memories;
    if (filter.apiKeyId) out = out.filter((m) => m.apiKeyId === filter.apiKeyId);
    if (filter.sessionId) out = out.filter((m) => m.sessionId === filter.sessionId);
    if (filter.type) out = out.filter((m) => m.type === filter.type);
    if (filter.category) {
      out = out.filter((m) => {
        const category = m.metadata?.category;
        return typeof category === "string" && category === filter.category;
      });
    }
    if (filter.query) {
      const needle = filter.query.toLowerCase();
      out = out.filter(
        (m) => m.content.toLowerCase().includes(needle) || m.key.toLowerCase().includes(needle)
      );
    }
    return out;
  }

  async search(config: SearchConfig): Promise<Memory[]> {
    await this.ensureInitialized();

    const tags = [OMNIROUTE_TAG, ...this.extraTags];
    if (config.apiKeyId) tags.push(`apikey:${config.apiKeyId}`);

    const body: Record<string, unknown> = {
      query: config.query,
      budget: this.recallBudget,
      max_tokens: config.maxTokens && config.maxTokens > 0 ? config.maxTokens : 4096,
      tags,
      tags_match: "all",
    };

    const response = await this.request<{ results?: HindsightRecallResult[] }>(
      "POST",
      this.bankPath("/memories/recall"),
      body,
      { timeout: this.recallTimeout }
    );

    const results = response?.results ?? [];
    const memories = results
      .map((r) => this.factToMemory(r))
      .filter((m): m is Memory => m !== null && !this.isExpired(m));

    const limit = config.limit && config.limit > 0 ? config.limit : undefined;
    return limit ? memories.slice(0, limit) : memories;
  }

  // ─── Extra capability (not part of MemoryBackend) ───

  /**
   * Hindsight `reflect`: disposition-aware answer generation over the bank.
   * Exposed because it is Hindsight's third core verb and has no analogue in
   * OmniRoute's MemoryBackend contract; nothing calls it implicitly.
   */
  async reflect(query: string, opts: { maxTokens?: number; tags?: string[] } = {}): Promise<string> {
    await this.ensureInitialized();
    const response = await this.request<{ text?: string }>(
      "POST",
      this.bankPath("/reflect"),
      {
        query,
        max_tokens: opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 2048,
        ...(opts.tags && opts.tags.length > 0 ? { tags: opts.tags, tags_match: "all" } : {}),
      },
      { timeout: Math.max(this.timeout, 120000) }
    );
    return response?.text ?? "";
  }
}

export const createHindsightBackend = (config: HindsightBackendConfig): HindsightBackend =>
  new HindsightBackend(config);
