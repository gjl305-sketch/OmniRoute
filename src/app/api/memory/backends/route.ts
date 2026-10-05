import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";
import { memoryManager } from "@/lib/memory";
import { getMemorySettings } from "@/lib/memory/settings";
import { HindsightBackend } from "@/lib/memory/hindsightBackend";
import { summarizeBackendConfig } from "@/lib/memory/backendRegistry";
import { MemoryBackendActionSchema } from "@/shared/schemas/memory";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

/**
 * MemoryBackend registry status.
 *
 * Reports the *effective* registry state (what MemoryManager will actually use),
 * not the requested configuration: when a configured backend could not be
 * constructed, that difference is the single most useful thing to see.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const settings = await getMemorySettings();
    const registered = memoryManager.getRegisteredBackends();
    const fallbackIds = new Set(memoryManager.getFallbackBackends().map((b) => b.id));

    const backends = await Promise.all(
      registered.map(async (info) => {
        const backend = memoryManager.getBackend(info.id);
        let health = { ok: false, latencyMs: 0, error: "backend not registered" as string | null };
        if (backend) {
          try {
            const result = await backend.health();
            health = {
              ok: result.ok,
              latencyMs: result.latencyMs,
              error: result.error ? sanitizeErrorMessage(result.error) : null,
            };
          } catch (e: unknown) {
            health = { ok: false, latencyMs: 0, error: sanitizeErrorMessage(e) };
          }
        }
        return {
          id: info.id,
          displayName: info.displayName,
          isPrimary: info.isPrimary,
          isFallback: fallbackIds.has(info.id),
          health,
          config: summarizeBackendConfig(info.id, settings),
        };
      })
    );

    const primary = registered.find((b) => b.isPrimary)?.id ?? memoryManager.getPrimaryBackend().id;

    return NextResponse.json({
      primary,
      fallbacks: Array.from(fallbackIds),
      backends,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: { message: sanitizeErrorMessage(err) } },
      { status: 500 }
    );
  }
}

/**
 * Exercise the selected backend through MemoryManager.
 *
 * `recall` runs the same path OmniRoute uses for retrieval; `reflect` is
 * Hindsight's disposition-aware answer generation, which has no analogue in the
 * MemoryBackend contract and is therefore only reachable when the active
 * primary backend is Hindsight itself.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const rawBody = await request.json().catch(() => ({}));
    const validation = validateBody(MemoryBackendActionSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json(validation.error, { status: 400 });
    }
    const { action, query, limit } = validation.data;

    if (action === "reflect") {
      let primary;
      try {
        primary = memoryManager.getPrimaryBackend();
      } catch (e: unknown) {
        return NextResponse.json(
          { error: { message: sanitizeErrorMessage(e) } },
          { status: 503 }
        );
      }
      if (!(primary instanceof HindsightBackend)) {
        return NextResponse.json(
          { error: { message: `Backend "${primary.id}" does not support reflect` } },
          { status: 400 }
        );
      }
      const text = await primary.reflect(query);
      return NextResponse.json({ action, backend: primary.id, text });
    }

    const memories = await memoryManager.search({ query, apiKeyId: "", limit });
    return NextResponse.json({
      action,
      backend: memoryManager.getPrimaryBackend().id,
      count: memories.length,
      memories: memories.map((memory) => ({
        id: memory.id,
        type: memory.type,
        key: memory.key,
        content: memory.content,
        score:
          typeof memory.metadata?.hindsight_score === "number"
            ? (memory.metadata.hindsight_score as number)
            : null,
      })),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: { message: sanitizeErrorMessage(err) } },
      { status: 502 }
    );
  }
}
