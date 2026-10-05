/**
 * Memory module exports and initialization
 */

import { logger } from "../../../open-sse/utils/logger.ts";
const log = logger("MEMORY");

export * from "./backend";
export * from "./manager";
export * from "./settings";
export * from "./types";
export * from "./store";
export * from "./retrieval";
export * from "./vectorStore";
export * from "./embedding";
export * from "./sqliteBackend";
export * from "./genericBackend";
export * from "./hindsightBackend";

// Auto-register SQLiteBackend with MemoryManager on import (sync only)
import { memoryManager } from "./manager";
import { sqliteBackend } from "./sqliteBackend";
import { registerConfiguredBackends, resolveBackendSelection } from "./backendRegistry";

memoryManager.register(sqliteBackend);

export { memoryManager } from "./manager";
export { sqliteBackend } from "./sqliteBackend";
export { createGenericMemoryBackend, createKnownBackend } from "./genericBackend";
export type { GenericBackendConfig, KnownBackendId } from "./genericBackend";
export { KNOWN_BACKENDS } from "./genericBackend";
export { HindsightBackend, createHindsightBackend, hindsightDocumentId } from "./hindsightBackend";
export type { HindsightBackendConfig, RecallBudget } from "./hindsightBackend";
export {
  MEMORY_BACKEND_ENV,
  CONSTRUCTIBLE_BACKEND_IDS,
  buildBackend,
  candidateBackendIds,
  hindsightConfigFromEnv,
  hindsightConfigFromSettings,
  registerConfiguredBackends,
  resolveBackendSelection,
  resolveHindsightConfig,
} from "./backendRegistry";
export { getPersistedBackendSelection } from "./settings";

/**
 * Initialize memory backends from settings.
 * Call this after DB is ready (e.g., from app bootstrap).
 *
 * Order matters: remote backends are constructed and registered first, so that
 * `configure()` can actually select them. Selection precedence is
 * persisted settings → environment → default (`sqlite`).
 */
export async function initMemoryBackends(): Promise<void> {
  const { getMemorySettings, getPersistedBackendSelection } = await import("./settings");
  try {
    const settings = await getMemorySettings();
    const registered = registerConfiguredBackends(settings);
    const persisted = await getPersistedBackendSelection();
    const selection = resolveBackendSelection(settings, persisted);

    if (!memoryManager.getBackend(selection.primary)) {
      // Do not pretend the configured backend is active: fall back to the
      // always-registered SQLite backend and say so loudly. Silently keeping a
      // stale primary was the previous failure mode.
      log.error("Configured primary backend is not registered; falling back to sqlite", {
        requested: selection.primary,
        registered: memoryManager.getRegisteredBackends().map((b) => b.id),
      });
      memoryManager.configure("sqlite", selection.fallbacks);
    } else {
      memoryManager.configure(selection.primary, selection.fallbacks);
    }

    log.info("memory.backends.selected", {
      primary: selection.primary,
      fallbacks: selection.fallbacks,
      source: selection.source,
      constructed: registered,
    });
    await memoryManager.initialize();
  } catch (e) {
    log.warn("Failed to initialize backends", { error: String(e) });
  }
}
