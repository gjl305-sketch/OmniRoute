"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, Button, Input, Select, Badge } from "@/shared/components";
import type { MemorySettingsExtended } from "@/shared/schemas/memory";

interface BackendHealth {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

interface BackendInfo {
  id: string;
  displayName: string;
  isPrimary: boolean;
  isFallback: boolean;
  health: BackendHealth;
  config: { baseUrl: string; bankId: string | null; hasApiKey: boolean } | null;
}

interface BackendsResponse {
  primary: string;
  fallbacks: string[];
  backends: BackendInfo[];
}

interface RecallResult {
  id: string;
  type: string;
  key: string;
  content: string;
  score: number | null;
}

interface Props {
  settings: MemorySettingsExtended;
  onSave: (updates: Partial<MemorySettingsExtended>) => Promise<boolean>;
  saving: boolean;
}

const RECALL_BUDGETS = ["low", "mid", "high"] as const;

/**
 * MemoryBackend selection + Hindsight connection/health.
 *
 * This is the operator surface for the pluggable backend layer: which backend
 * is primary, which are fallbacks, whether each is reachable and how fast, and
 * a live recall probe that runs through the same MemoryManager path chat uses.
 */
export default function BackendConfigCard({ settings, onSave, saving }: Props) {
  const t = useTranslations("memory");

  const [data, setData] = useState<BackendsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<"" | "saved" | "error">("");

  const existingHindsight = (settings.backendConfigs?.hindsight ?? {}) as Record<string, unknown>;
  const [baseUrl, setBaseUrl] = useState(String(existingHindsight.baseUrl ?? ""));
  const [bankId, setBankId] = useState(String(existingHindsight.bankId ?? "omniroute"));
  const [apiKey, setApiKey] = useState("");
  const [recallBudget, setRecallBudget] = useState(String(existingHindsight.recallBudget ?? "mid"));

  const [query, setQuery] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const [results, setResults] = useState<RecallResult[] | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memory/backends");
      if (res.ok) setData((await res.json()) as BackendsResponse);
      else setData(null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const registered = data?.backends ?? [];
  const primaryId = data?.primary ?? settings.primaryBackend ?? "sqlite";
  const fallbackIds = data?.fallbacks ?? settings.fallbackBackends ?? [];

  const saveSelection = async (updates: Partial<MemorySettingsExtended>) => {
    setStatus("");
    const ok = await onSave(updates);
    setStatus(ok ? "saved" : "error");
    if (ok) await refresh();
  };

  const toggleFallback = async (id: string) => {
    if (id === primaryId) return;
    const next = fallbackIds.includes(id)
      ? fallbackIds.filter((f) => f !== id)
      : [...fallbackIds, id];
    await saveSelection({ fallbackBackends: next });
  };

  const saveHindsightConfig = async () => {
    const next: Record<string, unknown> = {
      ...existingHindsight,
      baseUrl: baseUrl.trim(),
      bankId: bankId.trim() || "omniroute",
      recallBudget,
    };
    // Never round-trip the secret: blank means "keep whatever is configured".
    if (apiKey.trim()) next.apiKey = apiKey.trim();
    setApiKey("");
    await saveSelection({ backendConfigs: { ...settings.backendConfigs, hindsight: next } });
  };

  const runRecall = async () => {
    if (!query.trim()) return;
    setTesting(true);
    setTestError("");
    setResults(null);
    try {
      const res = await fetch("/api/memory/backends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recall", query: query.trim(), limit: 10 }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setTestError(body?.error?.message ?? t("engine.backendTestFailed"));
      } else {
        setResults((body?.memories ?? []) as RecallResult[]);
      }
    } catch {
      setTestError(t("engine.backendTestFailed"));
    } finally {
      setTesting(false);
    }
  };

  const healthChip = (health: BackendHealth) =>
    health.ok ? (
      <span className="text-xs text-emerald-500">
        {t("engine.backendHealthy", { latencyMs: health.latencyMs })}
      </span>
    ) : (
      <span className="text-xs text-red-500" title={health.error ?? undefined}>
        {t("engine.backendUnhealthy")}
      </span>
    );

  return (
    <Card>
      <div id="engine-config-backend" className="p-4 scroll-mt-4">
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-sm font-semibold text-text-main">{t("engine.backendTitle")}</h3>
          <Button
            data-testid="backend-refresh-button"
            size="sm"
            variant="outline"
            onClick={refresh}
            loading={loading}
          >
            {t("engine.backendRefresh")}
          </Button>
        </div>
        <p className="text-xs text-text-muted mb-4">{t("engine.backendDescription")}</p>

        {/* Effective registry state */}
        <div className="space-y-2 mb-4">
          {registered.length === 0 && (
            <div className="text-sm text-text-muted">{t("loading")}</div>
          )}
          {registered.map((backend) => (
            <div
              key={backend.id}
              data-testid={`backend-row-${backend.id}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface/30 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-main truncate">{backend.displayName}</span>
                  {backend.isPrimary && (
                    <Badge variant="primary" size="sm">
                      {t("engine.backendRolePrimary")}
                    </Badge>
                  )}
                  {backend.isFallback && (
                    <Badge variant="default" size="sm">
                      {t("engine.backendRoleFallback")}
                    </Badge>
                  )}
                </div>
                {backend.config && (
                  <div className="text-xs text-text-muted truncate">
                    {backend.config.baseUrl}
                    {backend.config.bankId ? ` · ${backend.config.bankId}` : ""}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {healthChip(backend.health)}
                {backend.id !== primaryId && (
                  <Button
                    data-testid={`backend-fallback-toggle-${backend.id}`}
                    size="sm"
                    variant={backend.isFallback ? "danger" : "outline"}
                    onClick={() => toggleFallback(backend.id)}
                    disabled={saving}
                  >
                    {t("engine.backendRoleFallback")}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Primary selection */}
        <div className="mb-4">
          <label className="block text-xs text-text-muted mb-1">
            {t("engine.backendPrimary")}
          </label>
          <Select
            data-testid="backend-primary-select"
            value={primaryId}
            onChange={(e) => void saveSelection({ primaryBackend: e.target.value })}
            className="w-full"
            disabled={saving}
          >
            {registered.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.displayName}
              </option>
            ))}
          </Select>
          <p className="text-xs text-text-muted mt-1">{t("engine.backendRestartHint")}</p>
        </div>

        {/* Hindsight connection */}
        <div className="border-t border-border/60 pt-4 space-y-3">
          <h4 className="text-xs font-semibold text-text-main">
            {t("engine.backendConnTitle")}
          </h4>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              {t("engine.backendBaseUrl")}
            </label>
            <Input
              data-testid="backend-base-url-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://hindsight.internal:8888"
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">
                {t("engine.backendBankId")}
              </label>
              <Input
                data-testid="backend-bank-id-input"
                value={bankId}
                onChange={(e) => setBankId(e.target.value)}
                placeholder="omniroute"
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">
                {t("engine.backendRecallBudget")}
              </label>
              <Select
                data-testid="backend-recall-budget-select"
                value={recallBudget}
                onChange={(e) => setRecallBudget(e.target.value)}
                className="w-full"
              >
                {RECALL_BUDGETS.map((budget) => (
                  <option key={budget} value={budget}>
                    {budget}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              {t("engine.backendApiKey")}
            </label>
            <Input
              data-testid="backend-api-key-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="••••••••"
              className="w-full"
            />
            <p className="text-xs text-text-muted mt-1">
              {existingHindsight.apiKey
                ? t("engine.backendApiKeyPreserve")
                : t("engine.backendApiKeyNone")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              data-testid="backend-save-button"
              size="sm"
              variant="primary"
              onClick={saveHindsightConfig}
              loading={saving}
            >
              {t("save")}
            </Button>
            {status === "saved" && (
              <span className="text-xs text-emerald-500">{t("engine.backendSaved")}</span>
            )}
            {status === "error" && (
              <span className="text-xs text-red-500">{t("engine.backendSaveFailed")}</span>
            )}
          </div>
        </div>

        {/* Recall probe */}
        <div className="border-t border-border/60 mt-4 pt-4">
          <h4 className="text-xs font-semibold text-text-main mb-2">
            {t("engine.backendTestTitle")}
          </h4>
          <div className="flex items-center gap-2">
            <Input
              data-testid="backend-test-query-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("engine.backendTestPlaceholder")}
              className="w-full"
            />
            <Button
              data-testid="backend-test-run-button"
              size="sm"
              variant="outline"
              onClick={runRecall}
              loading={testing}
              disabled={!query.trim()}
            >
              {t("engine.backendTestRun")}
            </Button>
          </div>
          {testError && <p className="text-xs text-red-500 mt-2">{testError}</p>}
          {results !== null && (
            <div className="mt-3 space-y-2">
              {results.length === 0 ? (
                <p className="text-xs text-text-muted">{t("engine.backendTestEmpty")}</p>
              ) : (
                results.map((result) => (
                  <div
                    key={result.id}
                    className="rounded-lg border border-border/60 bg-surface/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-text-muted">{result.key}</span>
                      {result.score !== null && (
                        <span className="text-xs text-text-muted">
                          {result.score.toFixed(3)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-main whitespace-pre-wrap break-words">
                      {result.content}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
