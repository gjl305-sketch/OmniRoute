/**
 * Durable-memory bridge.
 *
 * `MemoryManager` is the configured routing layer for durable memory, but the
 * retrieval hot path (`retrieveMemories` in `./retrieval`) historically read the
 * local SQLite hybrid engine directly. That was invisible while SQLite was the
 * only backend, and wrong as soon as a remote backend is primary: memories would
 * be *written* through MemoryManager to (say) Hindsight and then never *read*
 * back, because retrieval still queried an empty local table.
 *
 * This module is the single seam that fixes that. It is deliberately tiny and
 * deliberately fail-open:
 *
 *   - SQLite primary (the default) → returns null, and retrieval keeps using the
 *     local FTS5 / vector / Qdrant engine exactly as before.
 *   - Remote backend primary → retrieves through MemoryManager, which owns
 *     primary→fallback routing. A remote outage therefore yields the same
 *     (possibly empty) answer `MemoryManager.search` has always produced on total
 *     failure — memory is simply absent for that request, never an error.
 *   - The request is recency-only (no query), which the local engine owns and a
 *     remote recall backend cannot honour → returns null.
 *
 * It lives in its own module rather than in `retrieval.ts` to keep the
 * `retrieval → store → sqliteBackend → retrieval` import graph acyclic.
 */

import { logger } from "../../../open-sse/utils/logger.ts";
import { memoryManager } from "./manager";
import type { Memory } from "./types";
import type { SearchConfig } from "./backend";

const log = logger("MEMORY_DURABLE");

/** Effective primary backend id, or null when the manager has nothing registered. */
export function getActivePrimaryBackendId(): string | null {
  try {
    return memoryManager.getPrimaryBackend().id;
  } catch {
    return null;
  }
}

/** True when durable memory lives somewhere other than the local SQLite engine. */
export function isRemotePrimaryBackend(): boolean {
  const id = getActivePrimaryBackendId();
  return id !== null && id !== "sqlite";
}

export interface DurableRetrievalConfig {
  query?: string;
  maxTokens?: number;
  strategy?: SearchConfig["strategy"];
}

/**
 * Retrieve through the configured primary backend.
 *
 * Returns `null` when the local engine should handle the request: no remote
 * backend is primary, or the request is recency-based rather than query-based (a
 * capability the local engine owns and Hindsight's recall does not offer).
 * Otherwise it returns MemoryManager's answer, which is never an error — the
 * manager converts a total backend failure into an empty result.
 */
export async function retrieveViaPrimaryBackend(
  apiKeyId: string,
  config: DurableRetrievalConfig
): Promise<Memory[] | null> {
  if (!isRemotePrimaryBackend()) return null;

  const query = config.query?.trim();
  if (!query) {
    // "recent" strategy maps to the local exact/recency path; a remote recall
    // backend has no recency-ordered listing that would honour it.
    log.debug("memory.durable.skipped", { reason: "no query for remote backend" });
    return null;
  }

  return memoryManager.search({
    query,
    apiKeyId,
    maxTokens: config.maxTokens,
    strategy: config.strategy ?? "hybrid",
  });
}
