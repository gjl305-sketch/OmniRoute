/**
 * Backend registration from settings + environment.
 *
 * Before this module existed, `MemoryManager` only ever contained the
 * import-time-registered SQLite backend: `memoryBackendConfigs` was persisted by
 * the settings API but read by nothing, and no code constructed the remote
 * backends that `primaryBackend` / `fallbackBackends` could name. Configuring
 * `memoryPrimaryBackend = "hindsight"` therefore made `MemoryManager.configure()`
 * throw (swallowed by `initMemoryBackends`'s catch), leaving `sqlite` silently
 * primary.
 *
 * This module closes that gap: it turns persisted configuration (and, as a
 * fallback, environment variables) into registered `MemoryBackend` instances
 * *before* the manager is configured, and reports clearly when a configured
 * backend cannot be built instead of failing silently.
 */

import { logger } from "../../../open-sse/utils/logger.ts";
import type { MemoryBackend } from "./backend";
import { memoryManager } from "./manager";
import { HindsightBackend, type HindsightBackendConfig, type RecallBudget } from "./hindsightBackend";
import {
  createGenericMemoryBackend,
  KNOWN_BACKENDS,
  type GenericBackendConfig,
} from "./genericBackend";
import type { MemorySettings } from "./settings";

const log = logger("MEMORY_BACKENDS");

/** Environment contract for the Hindsight integration (mirrors Hindsight's own client env names). */
export const MEMORY_BACKEND_ENV = {
  baseUrl: "HINDSIGHT_API_URL",
  apiKey: "HINDSIGHT_API_KEY",
  bankId: "HINDSIGHT_BANK_ID",
  primary: "OMNIROUTE_MEMORY_PRIMARY_BACKEND",
  fallbacks: "OMNIROUTE_MEMORY_FALLBACK_BACKENDS",
} as const;

/** Backend ids this module knows how to construct. */
export const CONSTRUCTIBLE_BACKEND_IDS = ["sqlite", "hindsight", "obsidian", "notion", "generic"] as const;

const RECALL_BUDGETS: RecallBudget[] = ["low", "mid", "high"];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Hindsight config taken from the environment, or null when unset. */
export function hindsightConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HindsightBackendConfig | null {
  const baseUrl = asString(env[MEMORY_BACKEND_ENV.baseUrl]);
  if (!baseUrl) return null;
  const config: HindsightBackendConfig = { baseUrl };
  const apiKey = asString(env[MEMORY_BACKEND_ENV.apiKey]);
  if (apiKey) config.apiKey = apiKey;
  const bankId = asString(env[MEMORY_BACKEND_ENV.bankId]);
  if (bankId) config.bankId = bankId;
  return config;
}

/** Hindsight config from a persisted `backendConfigs.hindsight` entry, or null when unusable. */
export function hindsightConfigFromSettings(raw: unknown): HindsightBackendConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const baseUrl = asString(source.baseUrl);
  if (!baseUrl) return null;

  const config: HindsightBackendConfig = { baseUrl };
  const apiKey = asString(source.apiKey);
  if (apiKey) config.apiKey = apiKey;
  const bankId = asString(source.bankId);
  if (bankId) config.bankId = bankId;

  const timeout = asNumber(source.timeout);
  if (timeout !== undefined && timeout > 0) config.timeout = timeout;
  const retainTimeout = asNumber(source.retainTimeout);
  if (retainTimeout !== undefined && retainTimeout > 0) config.retainTimeout = retainTimeout;
  const recallTimeout = asNumber(source.recallTimeout);
  if (recallTimeout !== undefined && recallTimeout > 0) config.recallTimeout = recallTimeout;

  const budget = asString(source.recallBudget);
  if (budget && RECALL_BUDGETS.includes(budget as RecallBudget)) {
    config.recallBudget = budget as RecallBudget;
  }

  const retainAsync = asBoolean(source.retainAsync);
  if (retainAsync !== undefined) config.retainAsync = retainAsync;
  if (Array.isArray(source.tags)) {
    config.tags = source.tags.filter((t): t is string => typeof t === "string" && t.length > 0);
  }
  return config;
}

/**
 * Hindsight config resolution order: explicit persisted config wins, then env.
 * The result is null only when neither supplies a base URL.
 */
export function resolveHindsightConfig(
  settings: Pick<MemorySettings, "backendConfigs">,
  env: NodeJS.ProcessEnv = process.env
): HindsightBackendConfig | null {
  return (
    hindsightConfigFromSettings(settings.backendConfigs?.hindsight) ?? hindsightConfigFromEnv(env)
  );
}

/** Build a generic HTTP backend for a preset id (obsidian/notion) or an explicit config. */
function buildGenericBackend(id: string, raw: unknown): MemoryBackend | null {
  const preset = (KNOWN_BACKENDS as Record<string, { displayName: string; config: GenericBackendConfig }>)[id];
  const fromSettings = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const baseUrl = asString(fromSettings.baseUrl) ?? preset?.config.baseUrl;
  if (!baseUrl) return null;

  const config: GenericBackendConfig = {
    ...(preset?.config ?? {}),
    baseUrl,
    ...(asString(fromSettings.apiKey) ? { apiKey: asString(fromSettings.apiKey) } : {}),
    ...(asNumber(fromSettings.timeout) !== undefined
      ? { timeout: asNumber(fromSettings.timeout) }
      : {}),
    ...(fromSettings.headers && typeof fromSettings.headers === "object"
      ? { headers: fromSettings.headers as Record<string, string> }
      : {}),
    ...(fromSettings.endpoints && typeof fromSettings.endpoints === "object"
      ? { endpoints: fromSettings.endpoints as GenericBackendConfig["endpoints"] }
      : {}),
  };

  return createGenericMemoryBackend(id, preset?.displayName ?? id, config);
}

/** Construct one backend by id. Returns null when the id is unknown or unconfigured. */
export function buildBackend(
  id: string,
  settings: Pick<MemorySettings, "backendConfigs">,
  env: NodeJS.ProcessEnv = process.env
): MemoryBackend | null {
  const raw = settings.backendConfigs?.[id];

  if (id === "hindsight") {
    const config = resolveHindsightConfig(settings, env);
    return config ? new HindsightBackend(config) : null;
  }
  if (id === "obsidian" || id === "notion" || id === "generic") {
    return buildGenericBackend(id, raw);
  }
  return null;
}

/** Backend ids worth attempting to construct for the given settings. */
export function candidateBackendIds(settings: MemorySettings): string[] {
  const ids = new Set<string>([settings.primaryBackend, ...settings.fallbackBackends]);
  for (const id of Object.keys(settings.backendConfigs ?? {})) ids.add(id);
  if (process.env[MEMORY_BACKEND_ENV.baseUrl]) ids.add("hindsight");
  ids.delete("sqlite");
  return Array.from(ids).filter((id) => id.length > 0);
}

/**
 * Register every backend that settings (or the environment) can construct.
 * SQLite is already registered at import time and is left untouched.
 */
export function registerConfiguredBackends(
  settings: MemorySettings,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const registered: string[] = [];
  for (const id of candidateBackendIds(settings)) {
    try {
      const backend = buildBackend(id, settings, env);
      if (!backend) {
        log.warn("backend.not_constructible", {
          id,
          reason: "missing baseUrl in memoryBackendConfigs and no environment fallback",
        });
        continue;
      }
      memoryManager.register(backend);
      registered.push(id);
    } catch (e) {
      log.error("backend.registration_failed", { id, error: String(e) });
    }
  }
  return registered;
}

/**
 * Resolve which backend is primary.
 *
 * Precedence: an explicitly persisted selection wins; otherwise an environment
 * selection is used; otherwise the historical default (`sqlite`).
 */
export function resolveBackendSelection(
  settings: MemorySettings,
  persisted: { primary?: string; fallbacks?: string[] },
  env: NodeJS.ProcessEnv = process.env
): { primary: string; fallbacks: string[]; source: "settings" | "environment" | "default" } {
  const envPrimary = asString(env[MEMORY_BACKEND_ENV.primary]);
  const envFallbacks = (env[MEMORY_BACKEND_ENV.fallbacks] ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  if (persisted.primary) {
    return {
      primary: persisted.primary,
      fallbacks: persisted.fallbacks ?? settings.fallbackBackends,
      source: "settings",
    };
  }
  if (envPrimary) {
    return { primary: envPrimary, fallbacks: envFallbacks, source: "environment" };
  }
  return {
    primary: settings.primaryBackend,
    fallbacks: settings.fallbackBackends,
    source: "default",
  };
}

/**
 * Safe, non-secret summary of how a backend is configured, for the status API.
 *
 * Credential *values* are never included — only whether one is present. The base
 * URL is returned because operators need to verify which endpoint the backend is
 * actually talking to.
 */
export interface BackendConfigSummary {
  baseUrl: string;
  bankId: string | null;
  hasApiKey: boolean;
}

export function summarizeBackendConfig(
  id: string,
  settings: Pick<MemorySettings, "backendConfigs">,
  env: NodeJS.ProcessEnv = process.env
): BackendConfigSummary | null {
  if (id === "hindsight") {
    const config = resolveHindsightConfig(settings, env);
    if (!config) return null;
    return {
      baseUrl: config.baseUrl,
      bankId: config.bankId ?? "omniroute",
      hasApiKey: Boolean(config.apiKey),
    };
  }

  if (id === "obsidian" || id === "notion" || id === "generic") {
    const raw = settings.backendConfigs?.[id];
    const fromSettings = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const preset = (KNOWN_BACKENDS as Record<string, { config: GenericBackendConfig }>)[id];
    const baseUrl = asString(fromSettings.baseUrl) ?? preset?.config.baseUrl;
    if (!baseUrl) return null;
    return {
      baseUrl,
      bankId: null,
      hasApiKey: Boolean(asString(fromSettings.apiKey) ?? preset?.config.apiKey),
    };
  }

  return null;
}
