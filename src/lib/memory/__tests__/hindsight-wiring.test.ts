/**
 * Wiring tests for the pluggable MemoryBackend layer.
 *
 * These cover the parts that made `memoryPrimaryBackend = "hindsight"` a no-op
 * before: nothing constructed remote backends from `memoryBackendConfigs`, and
 * `MemoryManager.create`/`list` had no fallback path even when fallbacks were
 * configured.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
// Import through the module index (not the bare manager): the index's import-time
// side effect is what registers the SQLite backend, which is also how production
// gets it. Importing the manager alone leaves an empty registry (#8752).
import "../index";
import {
  MEMORY_BACKEND_ENV,
  buildBackend,
  candidateBackendIds,
  hindsightConfigFromEnv,
  hindsightConfigFromSettings,
  registerConfiguredBackends,
  resolveBackendSelection,
  resolveHindsightConfig,
  summarizeBackendConfig,
} from "../backendRegistry";
import { memoryManager } from "../manager";
import { HindsightBackend } from "../hindsightBackend";
import { KNOWN_BACKENDS } from "../genericBackend";
import { isRemotePrimaryBackend, retrieveViaPrimaryBackend } from "../durable";
import { retrieveMemoriesLocal } from "../retrieval";
import type { MemoryBackend } from "../backend";
import type { MemorySettings } from "../settings";
import { DEFAULT_MEMORY_SETTINGS } from "../settings";
import { MemoryType } from "../types";

function settingsWith(overrides: Partial<MemorySettings> = {}): MemorySettings {
  return { ...DEFAULT_MEMORY_SETTINGS, ...overrides };
}

// ─── config resolution ───

describe("hindsightConfigFromEnv()", () => {
  test("returns null when the base URL is unset", () => {
    expect(hindsightConfigFromEnv({})).toBeNull();
  });

  test("reads base URL, key and bank", () => {
    const config = hindsightConfigFromEnv({
      [MEMORY_BACKEND_ENV.baseUrl]: "http://hindsight.internal:8888",
      [MEMORY_BACKEND_ENV.apiKey]: "k",
      [MEMORY_BACKEND_ENV.bankId]: "omni",
    });
    expect(config).toEqual({
      baseUrl: "http://hindsight.internal:8888",
      apiKey: "k",
      bankId: "omni",
    });
  });
});

describe("hindsightConfigFromSettings()", () => {
  test("requires a base URL", () => {
    expect(hindsightConfigFromSettings(undefined)).toBeNull();
    expect(hindsightConfigFromSettings({})).toBeNull();
    expect(hindsightConfigFromSettings({ bankId: "x" })).toBeNull();
  });

  test("parses the optional fields, ignoring invalid values", () => {
    const config = hindsightConfigFromSettings({
      baseUrl: "http://h:8888",
      bankId: "omni",
      apiKey: "k",
      timeout: "5000",
      retainTimeout: 90000,
      recallBudget: "high",
      retainAsync: "true",
      tags: ["a", "", 3],
    });
    expect(config).toEqual({
      baseUrl: "http://h:8888",
      bankId: "omni",
      apiKey: "k",
      timeout: 5000,
      retainTimeout: 90000,
      recallBudget: "high",
      retainAsync: true,
      tags: ["a"],
    });
  });

  test("drops an unknown recall budget", () => {
    const config = hindsightConfigFromSettings({ baseUrl: "http://h", recallBudget: "huge" });
    expect(config?.recallBudget).toBeUndefined();
  });
});

describe("resolveHindsightConfig()", () => {
  test("persisted settings win over the environment", () => {
    const config = resolveHindsightConfig(
      settingsWith({ backendConfigs: { hindsight: { baseUrl: "http://from-settings" } } }),
      { [MEMORY_BACKEND_ENV.baseUrl]: "http://from-env" }
    );
    expect(config?.baseUrl).toBe("http://from-settings");
  });

  test("falls back to the environment so a deploy needs no DB edit", () => {
    const config = resolveHindsightConfig(settingsWith(), {
      [MEMORY_BACKEND_ENV.baseUrl]: "http://from-env",
      [MEMORY_BACKEND_ENV.bankId]: "omni",
    });
    expect(config?.baseUrl).toBe("http://from-env");
    expect(config?.bankId).toBe("omni");
  });

  test("is null when neither source is configured", () => {
    expect(resolveHindsightConfig(settingsWith(), {})).toBeNull();
  });
});

// ─── safe status summary ───

describe("summarizeBackendConfig()", () => {
  test("never exposes the credential value", () => {
    const summary = summarizeBackendConfig(
      "hindsight",
      settingsWith({ backendConfigs: { hindsight: { baseUrl: "http://h:8888", apiKey: "top-secret" } } }),
      {}
    );
    expect(summary).toEqual({ baseUrl: "http://h:8888", bankId: "omniroute", hasApiKey: true });
    expect(JSON.stringify(summary)).not.toContain("top-secret");
  });

  test("reports hasApiKey false when using the environment URL without a key", () => {
    const summary = summarizeBackendConfig("hindsight", settingsWith(), {
      [MEMORY_BACKEND_ENV.baseUrl]: "http://h:8888",
    });
    expect(summary).toEqual({ baseUrl: "http://h:8888", bankId: "omniroute", hasApiKey: false });
  });

  test("returns null for SQLite and for an id it does not know", () => {
    expect(summarizeBackendConfig("sqlite", settingsWith(), {})).toBeNull();
    expect(summarizeBackendConfig("brain", settingsWith(), {})).toBeNull();
  });

  test("reports a preset-backed backend from its built-in default", () => {
    // obsidian/notion have KNOWN_BACKENDS presets, so the summary falls back to the
    // preset base URL. The route only calls this for registered backends.
    const summary = summarizeBackendConfig("obsidian", settingsWith(), {});
    expect(summary?.baseUrl).toBe(KNOWN_BACKENDS.obsidian.config.baseUrl);
    expect(summary?.hasApiKey).toBe(false);
  });
});

// ─── backend construction + registration ───

describe("buildBackend()", () => {
  test("constructs a HindsightBackend from the environment", () => {
    const backend = buildBackend("hindsight", settingsWith(), {
      [MEMORY_BACKEND_ENV.baseUrl]: "http://h:8888",
    });
    expect(backend).toBeInstanceOf(HindsightBackend);
    expect(backend?.id).toBe("hindsight");
  });

  test("returns null when Hindsight is not configured anywhere", () => {
    expect(buildBackend("hindsight", settingsWith(), {})).toBeNull();
  });

  test("returns null for an unknown backend id", () => {
    expect(buildBackend("brain", settingsWith(), {})).toBeNull();
  });
});

describe("candidateBackendIds()", () => {
  test("includes configured ids and the env-configured Hindsight, excluding sqlite", () => {
    const ids = candidateBackendIds(
      settingsWith({ primaryBackend: "hindsight", fallbackBackends: ["sqlite"] })
    );
    expect(ids).toContain("hindsight");
    expect(ids).not.toContain("sqlite");
  });

  test("includes a backend that only has a config entry", () => {
    const ids = candidateBackendIds(
      settingsWith({ backendConfigs: { obsidian: { baseUrl: "http://vault" } } })
    );
    expect(ids).toContain("obsidian");
  });
});

describe("registerConfiguredBackends()", () => {
  const registeredIds: string[] = [];

  afterEach(() => {
    for (const id of registeredIds.splice(0)) memoryManager.unregister(id);
  });

  test("registers Hindsight from the environment", () => {
    const registered = registerConfiguredBackends(settingsWith({ primaryBackend: "hindsight" }), {
      [MEMORY_BACKEND_ENV.baseUrl]: "http://h:8888",
    });
    registeredIds.push(...registered);

    expect(registered).toContain("hindsight");
    expect(memoryManager.getBackend("hindsight")).toBeInstanceOf(HindsightBackend);
  });

  test("skips a backend it cannot construct instead of failing the boot", () => {
    const registered = registerConfiguredBackends(settingsWith({ primaryBackend: "hindsight" }), {});
    registeredIds.push(...registered);
    expect(registered).not.toContain("hindsight");
  });
});

// ─── selection precedence ───

describe("resolveBackendSelection()", () => {
  const base = settingsWith({ primaryBackend: "sqlite" });

  test("explicitly persisted settings win", () => {
    const result = resolveBackendSelection(base, { primary: "hindsight", fallbacks: ["sqlite"] }, {
      [MEMORY_BACKEND_ENV.primary]: "obsidian",
    });
    expect(result).toEqual({ primary: "hindsight", fallbacks: ["sqlite"], source: "settings" });
  });

  test("environment selection applies when nothing is persisted", () => {
    const result = resolveBackendSelection(base, {}, {
      [MEMORY_BACKEND_ENV.primary]: "hindsight",
      [MEMORY_BACKEND_ENV.fallbacks]: "sqlite, obsidian ,",
    });
    expect(result).toEqual({ primary: "hindsight", fallbacks: ["sqlite", "obsidian"], source: "environment" });
  });

  test("falls back to the historical default", () => {
    const result = resolveBackendSelection(base, {}, {});
    expect(result).toEqual({ primary: "sqlite", fallbacks: [], source: "default" });
  });

  test("uses persisted fallbacks when the primary is persisted but fallbacks are not", () => {
    const result = resolveBackendSelection(
      settingsWith({ fallbackBackends: ["sqlite"] }),
      { primary: "hindsight" },
      {}
    );
    expect(result.fallbacks).toEqual(["sqlite"]);
  });
});

// ─── MemoryManager fallback semantics ───

interface FakeBackend extends MemoryBackend {
  createCalls: number;
  listCalls: number;
}

function fakeBackend(
  id: string,
  behaviour: { createThrows?: boolean; listThrows?: boolean } = {}
): FakeBackend {
  const backend: FakeBackend = {
    id,
    displayName: id,
    createCalls: 0,
    listCalls: 0,
    async create(input) {
      backend.createCalls++;
      if (behaviour.createThrows) throw new Error(`${id} create unavailable`);
      return {
        id: `${id}-memory`,
        apiKeyId: input.apiKeyId,
        sessionId: input.sessionId,
        type: input.type,
        key: input.key,
        content: input.content,
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: null,
        accessCount: 0,
        lastAccessedAt: null,
      };
    },
    async get() {
      return null;
    },
    async update() {
      return true;
    },
    async delete() {
      return true;
    },
    async list() {
      backend.listCalls++;
      if (behaviour.listThrows) throw new Error(`${id} list unavailable`);
      return { data: [], total: 0, byType: {} };
    },
    async search() {
      return [];
    },
    async health() {
      return { ok: true, latencyMs: 1 };
    },
  };
  return backend;
}

const CREATE_INPUT = {
  apiKeyId: "k",
  sessionId: "s",
  type: MemoryType.FACTUAL,
  key: "key",
  content: "content",
};

describe("MemoryManager fallback semantics", () => {
  const ids = ["primary-fake", "fallback-fake"];

  beforeEach(() => {
    for (const id of ids) memoryManager.register(fakeBackend(id));
  });

  afterEach(() => {
    // Restore the manager to the state the application expects.
    memoryManager.configure("sqlite", []);
    for (const id of ids) memoryManager.unregister(id);
  });

  test("create() falls back when the primary throws", async () => {
    memoryManager.register(fakeBackend("primary-fake", { createThrows: true }));
    memoryManager.configure("primary-fake", ["fallback-fake"]);

    const memory = await memoryManager.create(CREATE_INPUT);
    expect(memory.id).toBe("fallback-fake-memory");
  });

  test("create() rethrows the primary error when no fallback is configured", async () => {
    memoryManager.register(fakeBackend("primary-fake", { createThrows: true }));
    memoryManager.configure("primary-fake", []);

    await expect(memoryManager.create(CREATE_INPUT)).rejects.toThrow(/primary-fake create unavailable/);
  });

  test("list() falls back when the primary throws", async () => {
    memoryManager.register(fakeBackend("primary-fake", { listThrows: true }));
    memoryManager.configure("primary-fake", ["fallback-fake"]);

    await expect(memoryManager.list({})).resolves.toEqual({ data: [], total: 0, byType: {} });
    expect((memoryManager.getBackend("fallback-fake") as FakeBackend).listCalls).toBe(1);
  });

  test("get() walks primary then fallbacks", async () => {
    memoryManager.configure("primary-fake", ["fallback-fake"]);
    await expect(memoryManager.get("nope")).resolves.toBeNull();
  });
});

// ─── durable retrieval seam ───

describe("durable retrieval seam", () => {
  const ids = ["remote-search-fake"];

  function remoteBackend(searchImpl: () => Promise<any[]>): MemoryBackend {
    const backend: MemoryBackend & { searchCalls: number } = {
      id: ids[0],
      displayName: "Remote",
      searchCalls: 0,
      async create() {
        throw new Error("not used");
      },
      async get() {
        return null;
      },
      async update() {
        return true;
      },
      async delete() {
        return true;
      },
      async list() {
        return { data: [], total: 0, byType: {} };
      },
      search(config) {
        backend.searchCalls++;
        return searchImpl(config);
      },
      async health() {
        return { ok: true, latencyMs: 1 };
      },
    };
    return backend;
  }

  afterEach(() => {
    memoryManager.configure("sqlite", []);
    for (const id of ids) memoryManager.unregister(id);
  });

  test("default SQLite primary leaves retrieval to the local engine", async () => {
    memoryManager.configure("sqlite", []);
    expect(isRemotePrimaryBackend()).toBe(false);
    expect(await retrieveViaPrimaryBackend("k", { query: "anything" })).toBeNull();
  });

  test("a remote primary routes retrieval through MemoryManager", async () => {
    const seen: any[] = [];
    memoryManager.register(
      remoteBackend(async (config: any) => {
        seen.push(config);
        return [
          {
            id: "fact-1",
            apiKeyId: "k",
            sessionId: "",
            type: MemoryType.FACTUAL,
            key: "fact-key",
            content: "durable fact",
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: null,
            accessCount: 0,
            lastAccessedAt: null,
          },
        ];
      })
    );
    memoryManager.configure(ids[0], ["sqlite"]);

    expect(isRemotePrimaryBackend()).toBe(true);
    const results = await retrieveViaPrimaryBackend("k", {
      query: "durable question",
      maxTokens: 2000,
      strategy: "hybrid",
    });
    expect(results).toHaveLength(1);
    expect(results![0].content).toBe("durable fact");
    expect(seen[0]).toMatchObject({ query: "durable question", apiKeyId: "k", maxTokens: 2000 });
  });

  test("recency-only requests are not sent to a remote backend", async () => {
    memoryManager.register(remoteBackend(async () => [{ id: "should-not-be-used" }]));
    memoryManager.configure(ids[0], ["sqlite"]);
    expect(await retrieveViaPrimaryBackend("k", {})).toBeNull();
  });

  test("a remote outage degrades to an empty result, never an error", async () => {
    memoryManager.register(
      remoteBackend(async () => {
        throw new Error("hindsight unreachable");
      })
    );
    memoryManager.configure(ids[0], []);

    // MemoryManager.search converts a total backend failure into []; the seam
    // inherits that contract so a memory outage can never fail a request.
    const results = await retrieveViaPrimaryBackend("k", { query: "q" });
    expect(results).toEqual([]);
  });

  test("the local engine never delegates back to the remote backend", async () => {
    const remote = remoteBackend(async () => {
      throw new Error("must not be reached");
    }) as MemoryBackend & { searchCalls: number };
    memoryManager.register(remote);
    memoryManager.configure(ids[0], ["sqlite"]);

    // Regression: SQLiteBackend.search (the fallback) must run the local engine.
    // When it called retrieveMemories() instead, MemoryManager ran
    // primary -> fallback -> retrieveMemories -> primary ... and a chat request
    // hung until the client gave up whenever the remote backend was down.
    try {
      await retrieveMemoriesLocal("k", { query: "q" });
    } catch {
      // The local DB may not be initialised in this suite; the assertion below
      // is about delegation, not about the engine's own result.
    }
    expect(remote.searchCalls).toBe(0);
  });
});

// The manager is a process-wide singleton; make sure the fallback suite left the
// registry in the state the application expects.
describe("MemoryManager default state", () => {
  test("is back to sqlite after the fallback suite", () => {
    expect(memoryManager.getRegisteredBackends().find((b) => b.isPrimary)?.id).toBe("sqlite");
  });

  test("is anchored on globalThis so separate bundles share one registry", () => {
    // Next.js emits the instrumentation hook and route handlers as separate
    // bundles; a module-scoped instance would give each its own empty registry.
    const store = globalThis as typeof globalThis & {
      __omnirouteMemoryManager__?: unknown;
    };
    expect(store.__omnirouteMemoryManager__).toBe(memoryManager);
    expect(memoryManager.getRegisteredBackends()).toContainEqual(
      expect.objectContaining({ id: "sqlite" })
    );
  });
});
