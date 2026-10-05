/**
 * HindsightBackend — behavioral tests for the MemoryBackend adapter.
 *
 * Complements `generic-backend.test.ts` (the harness pattern is copied from it):
 * Hindsight is not CRUD-over-REST, so these tests pin the *translation* — which
 * Hindsight endpoint each MemoryBackend operation maps to, and which OmniRoute
 * semantics (identity, scope, metadata, retention) survive the round trip.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  HindsightBackend,
  createHindsightBackend,
  hindsightDocumentId,
  type HindsightBackendConfig,
} from "../hindsightBackend";
import { MemoryType } from "../types";

const BASE_URL = "http://hindsight.test:8888";
const BANK = "omniroute";

const HEALTH_OK = { status: "healthy", database: "connected", db_acquire_ms: 1.2 };
const HEALTH_UNHEALTHY = { status: "unhealthy", database: "error", error: "connection refused" };

interface RecordedCall {
  method: string;
  url: URL;
  body: any;
  headers: Record<string, string>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, detail = "nope"): Response {
  return jsonResponse({ detail }, status);
}

/** Route by method+path; anything unmatched is a 404, so unmapped calls are visible. */
function mockFetch(route: (method: string, url: URL, body: any) => Response | undefined) {
  const calls: RecordedCall[] = [];
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: unknown, init: unknown = {}) => {
      const options = init as { method?: string; body?: string; headers?: Record<string, string> };
      const url = new URL(String(input));
      const method = (options.method ?? "GET").toUpperCase();
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method, url, body, headers: options.headers ?? {} });
      return route(method, url, body) ?? errorResponse(404);
    });
  return { mock, calls };
}

/** Default route: health is always OK. */
function mockHealthy(route?: (method: string, url: URL, body: any) => Response | undefined) {
  return mockFetch((method, url, body) => {
    if (url.pathname === "/health") return jsonResponse(HEALTH_OK);
    return route?.(method, url, body);
  });
}

function createBackend(overrides: Partial<HindsightBackendConfig> = {}): HindsightBackend {
  return createHindsightBackend({ baseUrl: BASE_URL, ...overrides });
}

const SAMPLE_INPUT = {
  apiKeyId: "key-1",
  sessionId: "sess-1",
  type: MemoryType.FACTUAL,
  key: "desk-preference",
  content: "Prefer limit orders for the first fifteen minutes of the session.",
  metadata: { category: "trading", source: "probe", nested: { a: 1 } },
  expiresAt: null,
};

/**
 * A document record shaped exactly like `GET /documents/{id}` on Hindsight
 * 0.8.6 (verified live): the metadata comes back as a flat
 * `document_metadata` object and is repeated under `retain_params.metadata`.
 */
function documentFixture(id: string, overrides: Record<string, unknown> = {}) {
  const metadata = {
    omniroute_key: SAMPLE_INPUT.key,
    omniroute_type: SAMPLE_INPUT.type,
    omniroute_api_key_id: SAMPLE_INPUT.apiKeyId,
    omniroute_session_id: SAMPLE_INPUT.sessionId,
    omniroute_metadata: JSON.stringify(SAMPLE_INPUT.metadata),
  };
  return {
    id,
    bank_id: BANK,
    original_text: SAMPLE_INPUT.content,
    content_hash: "hash",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    tags: ["omniroute"],
    document_metadata: metadata,
    retain_params: { context: SAMPLE_INPUT.key, metadata },
    memory_unit_count: 1,
    ...overrides,
  };
}

describe("HindsightBackend", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── health / lifecycle ───

  describe("health()", () => {
    test("reports ok with latency from GET /health", async () => {
      const { calls } = mockHealthy();
      const result = await createBackend().health();

      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url.toString()).toBe(`${BASE_URL}/health`);
    });

    test("reports not-ok when Hindsight reports an unhealthy status", async () => {
      mockFetch((method, url) =>
        url.pathname === "/health" ? jsonResponse(HEALTH_UNHEALTHY, 503) : undefined
      );
      const result = await createBackend().health();

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test("reports not-ok instead of throwing when Hindsight is unreachable", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await createBackend().health();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    });
  });

  describe("initialize()", () => {
    test("probes health and resolves when Hindsight is up", async () => {
      mockHealthy();
      await expect(createBackend().initialize()).resolves.toBeUndefined();
    });

    test("throws with the base URL when Hindsight is down", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND"));
      await expect(createBackend().initialize()).rejects.toThrow(/Cannot connect to Hindsight/);
    });

    test("requires a baseUrl", () => {
      expect(() => createHindsightBackend({ baseUrl: "" })).toThrow(/requires a baseUrl/);
    });
  });

  // ─── identity / scope ───

  describe("hindsightDocumentId()", () => {
    test("is deterministic for the same (apiKeyId, key)", () => {
      expect(hindsightDocumentId("k1", "some-key")).toBe(hindsightDocumentId("k1", "some-key"));
    });

    test("separates owners and keys", () => {
      const a = hindsightDocumentId("k1", "some-key");
      const b = hindsightDocumentId("k2", "some-key");
      const c = hindsightDocumentId("k1", "other-key");
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
    });

    test("is safe to use as a path segment", () => {
      const id = hindsightDocumentId("key with spaces/and:slashes", "another/unsafe key");
      expect(id).toMatch(/^omniroute:[A-Za-z0-9_.-]+:[0-9a-f]{20}$/);
    });
  });

  // ─── create ───

  describe("create()", () => {
    test("retains through POST /memories with the document upsert key", async () => {
      const { calls } = mockHealthy((method, url) =>
        method === "POST" && url.pathname.endsWith("/memories")
          ? jsonResponse({ success: true, bank_id: BANK, items_count: 1, async: false })
          : undefined
      );

      const backend = createBackend();
      const memory = await backend.create(SAMPLE_INPUT);

      const retain = calls.find((c) => c.method === "POST");
      expect(retain).toBeDefined();
      expect(retain!.url.pathname).toBe(`/v1/default/banks/${BANK}/memories`);
      expect(retain!.body.async).toBe(false);
      expect(retain!.body.items).toHaveLength(1);

      const item = retain!.body.items[0];
      expect(item.content).toBe(SAMPLE_INPUT.content);
      expect(item.document_id).toBe(hindsightDocumentId(SAMPLE_INPUT.apiKeyId, SAMPLE_INPUT.key));
      // Identity + scope travel with the record.
      expect(item.metadata.omniroute_api_key_id).toBe("key-1");
      expect(item.metadata.omniroute_session_id).toBe("sess-1");
      expect(item.metadata.omniroute_type).toBe("factual");
      expect(item.tags).toContain("apikey:key-1");
      expect(item.tags).toContain("session:sess-1");
      expect(item.tags).toContain("type:factual");
      expect(item.tags).toContain("omniroute");

      expect(memory.id).toBe(hindsightDocumentId(SAMPLE_INPUT.apiKeyId, SAMPLE_INPUT.key));
      expect(memory.content).toBe(SAMPLE_INPUT.content);
      expect(memory.type).toBe(MemoryType.FACTUAL);
      expect(memory.metadata).toEqual(SAMPLE_INPUT.metadata);
    });

    test("accepts a memory id supplied by Hindsight only via document_id", async () => {
      // Hindsight generates memory ids itself; the adapter must never send one.
      const { calls } = mockHealthy((method, url) =>
        method === "POST" && url.pathname.endsWith("/memories")
          ? jsonResponse({ success: true, bank_id: BANK, items_count: 1, async: false })
          : undefined
      );
      await createBackend().create(SAMPLE_INPUT);

      const item = calls.find((c) => c.method === "POST")!.body.items[0];
      expect(item.id).toBeUndefined();
      expect(Object.keys(item)).not.toContain("id");
    });

    test("reflects the configured bank id in the request path", async () => {
      const { calls } = mockHealthy((method, url) =>
        method === "POST" ? jsonResponse({ success: true }) : undefined
      );
      await createBackend({ bankId: "omni-prod" }).create(SAMPLE_INPUT);
      expect(calls.find((c) => c.method === "POST")!.url.pathname).toContain(
        "/v1/default/banks/omni-prod/"
      );
    });

    test("sends the bearer token only when an API key is configured", async () => {
      const withKey = mockHealthy((method, url) =>
        method === "POST" ? jsonResponse({ success: true }) : undefined
      );
      await createBackend({ apiKey: "secret-token" }).create(SAMPLE_INPUT);
      expect(withKey.calls.find((c) => c.method === "POST")!.headers.Authorization).toBe(
        "Bearer secret-token"
      );

      vi.restoreAllMocks();
      const withoutKey = mockHealthy((method, url) =>
        method === "POST" ? jsonResponse({ success: true }) : undefined
      );
      await createBackend().create(SAMPLE_INPUT);
      expect(withoutKey.calls.find((c) => c.method === "POST")!.headers.Authorization).toBeUndefined();
    });
  });

  // ─── get ───

  describe("get()", () => {
    test("reconstructs the memory from the Hindsight document", async () => {
      const id = hindsightDocumentId(SAMPLE_INPUT.apiKeyId, SAMPLE_INPUT.key);
      const { calls } = mockHealthy((method, url) =>
        method === "GET" && url.pathname.includes("/documents/")
          ? jsonResponse(documentFixture(id))
          : undefined
      );

      const memory = await createBackend().get(id);

      // The document id contains ':' separators, so the adapter percent-encodes the
      // path segment; compare on the decoded value to assert intent, not encoding.
      expect(
        calls.some((c) => decodeURIComponent(c.url.pathname).endsWith(`/documents/${id}`))
      ).toBe(true);
      expect(memory).not.toBeNull();
      expect(memory!.id).toBe(id);
      expect(memory!.content).toBe(SAMPLE_INPUT.content);
      expect(memory!.type).toBe(MemoryType.FACTUAL);
      expect(memory!.apiKeyId).toBe("key-1");
      expect(memory!.sessionId).toBe("sess-1");
      expect(memory!.key).toBe(SAMPLE_INPUT.key);
      // Arbitrary nested metadata survives the string-only Hindsight metadata type.
      expect(memory!.metadata).toEqual(SAMPLE_INPUT.metadata);
      expect(memory!.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(memory!.updatedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    });

    test("falls back to a fact lookup for ids returned by search()", async () => {
      mockHealthy((method, url) => {
        if (method === "GET" && url.pathname.includes("/documents/")) return errorResponse(404);
        if (method === "GET" && url.pathname.includes("/memories/")) {
          return jsonResponse({
            id: "fact-1",
            text: "A recalled fact",
            type: "world",
            document_id: "doc-9",
            metadata: {
              omniroute_key: "fact-key",
              omniroute_type: "episodic",
              omniroute_api_key_id: "key-1",
              omniroute_session_id: "sess-1",
            },
            scores: { final: 0.42 },
          });
        }
        return undefined;
      });

      const memory = await createBackend().get("fact-1");
      expect(memory!.id).toBe("fact-1");
      expect(memory!.content).toBe("A recalled fact");
      expect(memory!.type).toBe(MemoryType.EPISODIC);
      expect(memory!.metadata.hindsight_document_id).toBe("doc-9");
      expect(memory!.metadata.hindsight_score).toBe(0.42);
    });

    test("returns null when neither a document nor a fact exists", async () => {
      mockHealthy(() => errorResponse(404));
      expect(await createBackend().get("missing")).toBeNull();
    });

    test("treats a non-UUID id rejected by the fact route as 'not found'", async () => {
      // Live Hindsight answers 400 (not 404) when a document id is looked up on
      // the memory-unit route; that must not surface as a backend failure.
      mockHealthy((method, url) => {
        if (method === "GET" && url.pathname.includes("/documents/")) return errorResponse(404);
        if (method === "GET" && url.pathname.includes("/memories/")) {
          return errorResponse(400, "Invalid memory_id: 'x' is not a valid UUID");
        }
        return undefined;
      });
      expect(await createBackend().get("omniroute:key-1:abc")).toBeNull();
    });

    test("reads metadata from the nested retain_params.items shape too", async () => {
      mockHealthy((method, url) =>
        method === "GET" && url.pathname.includes("/documents/")
          ? jsonResponse({
              id: "doc-legacy",
              original_text: "legacy content",
              retain_params: {
                items: [
                  {
                    metadata: {
                      omniroute_key: "legacy-key",
                      omniroute_type: "procedural",
                      omniroute_api_key_id: "key-9",
                      omniroute_session_id: "",
                    },
                  },
                ],
              },
            })
          : undefined
      );

      const memory = await createBackend().get("doc-legacy");
      expect(memory!.key).toBe("legacy-key");
      expect(memory!.type).toBe(MemoryType.PROCEDURAL);
      expect(memory!.apiKeyId).toBe("key-9");
    });
  });

  // ─── list ───

  describe("list()", () => {
    /** The live list endpoint omits the stored text (only `text_length`). */
    const stripText = (doc: Record<string, unknown>) => {
      const { original_text, ...rest } = doc;
      return { ...rest, text_length: String(original_text ?? "").length };
    };

    test("hydrates each listed document and counts by type", async () => {
      const idA = hindsightDocumentId("key-1", SAMPLE_INPUT.key);
      const idB = hindsightDocumentId("key-1", "other");
      const docA = documentFixture(idA);
      const docB = documentFixture(idB, {
        original_text: "Another memory",
        document_metadata: {
          omniroute_key: "other",
          omniroute_type: "semantic",
          omniroute_api_key_id: "key-1",
          omniroute_session_id: "sess-1",
        },
      });

      const { calls } = mockHealthy((method, url) => {
        if (method !== "GET") return undefined;
        if (url.pathname.endsWith("/documents")) {
          // Live shape: `{ items, total, limit, offset }`, no stored text.
          return jsonResponse({
            items: [stripText(docA), stripText(docB)],
            total: 2,
            limit: 100,
            offset: 0,
          });
        }
        const decoded = decodeURIComponent(url.pathname);
        if (decoded.includes(idA)) return jsonResponse(docA);
        if (decoded.includes(idB)) return jsonResponse(docB);
        return undefined;
      });

      const result = await createBackend().list({ apiKeyId: "key-1", limit: 10 });
      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(result.byType).toEqual({ factual: 1, semantic: 1 });
      // Content only exists because the row was hydrated from /documents/{id}.
      expect(result.data.map((m) => m.content)).toContain(SAMPLE_INPUT.content);
      expect(calls.filter((c) => c.url.pathname.includes("/documents/")).length).toBeGreaterThan(0);
    });

    test("scopes results client-side (Hindsight filters by tag, not by apiKeyId)", async () => {
      const mine = documentFixture(hindsightDocumentId("key-1", "mine"));
      const theirs = documentFixture(hindsightDocumentId("key-2", "theirs"), {
        document_metadata: {
          omniroute_key: "theirs",
          omniroute_type: "factual",
          omniroute_api_key_id: "key-2",
          omniroute_session_id: "sess-9",
        },
      });
      mockHealthy((method, url) => {
        if (method !== "GET") return undefined;
        if (url.pathname.endsWith("/documents")) {
          return jsonResponse({ items: [stripText(mine), stripText(theirs)], total: 2 });
        }
        const decoded = decodeURIComponent(url.pathname);
        if (decoded.includes(String(mine.id))) return jsonResponse(mine);
        if (decoded.includes(String(theirs.id))) return jsonResponse(theirs);
        return undefined;
      });

      const result = await createBackend().list({ apiKeyId: "key-1" });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].apiKeyId).toBe("key-1");
    });

    test("drops expired memories (Hindsight has no per-memory TTL)", async () => {
      const expired = documentFixture(hindsightDocumentId("key-1", "old"), {
        document_metadata: {
          omniroute_key: "old",
          omniroute_type: "factual",
          omniroute_api_key_id: "key-1",
          omniroute_session_id: "",
          omniroute_expires_at: "2000-01-01T00:00:00.000Z",
        },
      });
      mockHealthy((method, url) => {
        if (method !== "GET") return undefined;
        if (url.pathname.endsWith("/documents")) {
          return jsonResponse({ items: [stripText(expired)], total: 1 });
        }
        return jsonResponse(expired);
      });

      const result = await createBackend().list({});
      expect(result.data).toHaveLength(0);
    });
  });

  // ─── search ───

  describe("search()", () => {
    test("recalls through POST /memories/recall and returns one Memory per fact", async () => {
      const { calls } = mockHealthy((method, url) =>
        method === "POST" && url.pathname.endsWith("/memories/recall")
          ? jsonResponse({
              results: [
                {
                  id: "fact-1",
                  text: "Limit orders are preferred early in the session.",
                  type: "world",
                  document_id: "doc-1",
                  metadata: {
                    omniroute_key: "desk-preference",
                    omniroute_type: "factual",
                    omniroute_api_key_id: "key-1",
                    omniroute_session_id: "sess-1",
                  },
                  scores: { final: 0.87, reranker: 0.5, semantic: 0.31 },
                },
                {
                  id: "fact-2",
                  text: "The desk flattens before the close.",
                  type: "experience",
                  document_id: "doc-2",
                  metadata: {
                    omniroute_key: "close-rule",
                    omniroute_type: "episodic",
                    omniroute_api_key_id: "key-1",
                    omniroute_session_id: "sess-1",
                  },
                  scores: { final: 0.44 },
                },
              ],
            })
          : undefined
      );

      const results = await createBackend().search({
        query: "how should early orders be placed",
        apiKeyId: "key-1",
        limit: 10,
      });

      const recall = calls.find((c) => c.method === "POST")!;
      expect(recall.url.pathname).toBe(`/v1/default/banks/${BANK}/memories/recall`);
      expect(recall.body.query).toBe("how should early orders be placed");
      expect(recall.body.tags).toContain("omniroute");
      expect(recall.body.tags).toContain("apikey:key-1");

      expect(results).toHaveLength(2);
      // Recalled facts are the unit of return, not the retained blob.
      expect(results[0].id).toBe("fact-1");
      expect(results[0].content).toBe("Limit orders are preferred early in the session.");
      expect(results[0].metadata.hindsight_score).toBe(0.87);
      expect(results[0].metadata.hindsight_fact_type).toBe("world");
      // Type is recovered from preserved metadata, not from Hindsight's fact type.
      expect(results[0].type).toBe(MemoryType.FACTUAL);
      expect(results[1].type).toBe(MemoryType.EPISODIC);
      expect(results[0].key).toBe("desk-preference");
    });

    test("honours the configured recall budget", async () => {
      const { calls } = mockHealthy((method, url) =>
        method === "POST" ? jsonResponse({ results: [] }) : undefined
      );
      await createBackend({ recallBudget: "high" }).search({ query: "q", apiKeyId: "k" });
      expect(calls.find((c) => c.method === "POST")!.body.budget).toBe("high");
    });

    test("applies the caller limit", async () => {
      const facts = Array.from({ length: 5 }, (_, i) => ({
        id: `f${i}`,
        text: `fact ${i}`,
        document_id: `d${i}`,
        metadata: { omniroute_type: "factual" },
        scores: { final: 1 - i / 10 },
      }));
      mockHealthy((method, url) =>
        method === "POST" ? jsonResponse({ results: facts }) : undefined
      );
      const results = await createBackend().search({ query: "q", apiKeyId: "k", limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  // ─── update ───

  describe("update()", () => {
    test("re-retains under the same document id (Hindsight replace semantics)", async () => {
      const id = hindsightDocumentId(SAMPLE_INPUT.apiKeyId, SAMPLE_INPUT.key);
      const { calls } = mockHealthy((method, url) => {
        if (method === "GET" && url.pathname.includes("/documents/")) {
          return jsonResponse(documentFixture(id));
        }
        if (method === "POST" && url.pathname.endsWith("/memories")) {
          return jsonResponse({ success: true, items_count: 1 });
        }
        return undefined;
      });

      const ok = await createBackend().update(id, { content: "Updated content" });
      expect(ok).toBe(true);

      const retain = calls.find((c) => c.method === "POST")!;
      expect(retain.body.items[0].content).toBe("Updated content");
      // Identity is stable across the update: same document, so the upsert replaces.
      expect(retain.body.items[0].document_id).toBe(id);
      expect(retain.body.items[0].metadata.omniroute_api_key_id).toBe("key-1");
    });

    test("patches a fact id instead (text/context curation)", async () => {
      const { calls } = mockHealthy((method, url) => {
        if (method === "GET" && url.pathname.includes("/documents/")) return errorResponse(404);
        if (method === "PATCH" && url.pathname.includes("/memories/")) return jsonResponse({});
        return undefined;
      });

      const ok = await createBackend().update("fact-1", { content: "curated" });
      expect(ok).toBe(true);
      const patch = calls.find((c) => c.method === "PATCH")!;
      expect(patch.url.pathname).toBe(`/v1/default/banks/${BANK}/memories/fact-1`);
      expect(patch.body).toEqual({ text: "curated" });
    });

    test("returns false for an unknown id", async () => {
      mockHealthy(() => errorResponse(404));
      expect(await createBackend().update("nope", { content: "x" })).toBe(false);
    });
  });

  // ─── delete ───

  describe("delete()", () => {
    test("deletes the Hindsight document", async () => {
      const { calls } = mockHealthy((method, url) =>
        method === "DELETE" ? jsonResponse({ success: true }) : undefined
      );
      const ok = await createBackend().delete("doc-1");
      expect(ok).toBe(true);
      expect(calls.find((c) => c.method === "DELETE")!.url.pathname).toBe(
        `/v1/default/banks/${BANK}/documents/doc-1`
      );
    });

    test("soft-deletes a fact when no document matches (Hindsight has no per-fact DELETE)", async () => {
      const { calls } = mockHealthy((method, url) => {
        if (method === "DELETE") return errorResponse(404);
        if (method === "PATCH") return jsonResponse({});
        return undefined;
      });
      const ok = await createBackend().delete("fact-1");
      expect(ok).toBe(true);
      expect(calls.find((c) => c.method === "PATCH")!.body.state).toBe("invalidated");
    });

    test("returns false when neither exists", async () => {
      mockHealthy(() => errorResponse(404));
      expect(await createBackend().delete("ghost")).toBe(false);
    });

    test("returns false when the fact route rejects a non-UUID document id", async () => {
      mockHealthy((method) => {
        if (method === "DELETE") return errorResponse(404);
        if (method === "PATCH") return errorResponse(400, "not a valid UUID");
        return undefined;
      });
      expect(await createBackend().delete("omniroute:key-1:abc")).toBe(false);
    });
  });

  // ─── failure modes ───

  describe("failure modes", () => {
    test("surfaces HTTP failures from retain", async () => {
      mockHealthy((method, url) =>
        method === "POST" ? errorResponse(500, "extraction failed") : undefined
      );
      await expect(createBackend().create(SAMPLE_INPUT)).rejects.toThrow(/HTTP 500/);
    });

    test("times out instead of hanging forever", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_input: unknown, init: unknown) =>
          new Promise((_resolve, reject) => {
            const signal = (init as { signal?: AbortSignal }).signal;
            signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );

      const backend = createBackend({ timeout: 20 });
      const result = await backend.health();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out/);
    });

    test("does not call the network before a health check", async () => {
      const { calls } = mockHealthy((method, url) =>
        method === "POST" ? jsonResponse({ success: true }) : undefined
      );
      await createBackend().create(SAMPLE_INPUT);
      expect(calls[0].url.pathname).toBe("/health");
    });
  });

  // ─── reflect ───

  describe("reflect()", () => {
    test("maps onto POST /reflect and returns the generated text", async () => {
      const { calls } = mockHealthy((method, url) =>
        method === "POST" && url.pathname.endsWith("/reflect")
          ? jsonResponse({ text: "The desk prefers limit orders early." })
          : undefined
      );
      const text = await createBackend().reflect("how should I place orders");
      expect(text).toBe("The desk prefers limit orders early.");
      expect(calls.find((c) => c.method === "POST")!.url.pathname).toBe(
        `/v1/default/banks/${BANK}/reflect`
      );
    });
  });
});
