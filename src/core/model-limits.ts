// Where omp-vcc learns a model's real context window when omp's may be wrong.
//
// omp reads the window from the provider's /models only for providers with
// `discovery` configured; otherwise it takes models.yml, its catalog or a 128K
// default. About as often as not, the provider's own /models states it
// (context_length, max_model_len, …), so omp-vcc asks it once per base URL, with
// omp's credentials for that model, in the background. When the provider says
// nothing, an overflow error often does ("maximum context length is 32768
// tokens"); that limit is kept per model in omp-vcc-models.json next to the
// config, so the next session starts with it.
//
// No package import: global fetch, and the key through omp's ctx.modelRegistry.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { settingsPath } from "./settings";
import { contextLengthOfModelEntry } from "./window";

export interface ModelLike {
  provider?: string;
  id?: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number | null;
}

export interface RegistryLike {
  getApiKeyAndHeaders?: (model: any) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

export const modelKey = (model: ModelLike | undefined): string | undefined =>
  model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;

// ── learned limits (from overflow errors) ──

const LIMITS_FILE = "omp-vcc-models.json";

interface LearnedLimit {
  contextWindow: number;
  source: "overflow-error";
  at: string;
}

const limitsPath = (): string => join(dirname(settingsPath()), LIMITS_FILE);

const readLimits = (): Record<string, LearnedLimit> => {
  try {
    const path = limitsPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/** The limit an overflow error stated for this model, in this or an earlier session. */
export const learnedWindow = (key: string | undefined): number | undefined => {
  if (!key) return undefined;
  const n = readLimits()[key]?.contextWindow;
  return typeof n === "number" && n > 0 ? n : undefined;
};

/** Keep the limit an overflow error stated. A smaller one replaces a larger one, never the reverse. */
export const recordLearnedWindow = (key: string | undefined, contextWindow: number, now = new Date()): boolean => {
  if (!key || !(contextWindow > 0)) return false;
  const limits = readLimits();
  const known = limits[key]?.contextWindow;
  if (typeof known === "number" && known <= contextWindow) return false;
  limits[key] = { contextWindow, source: "overflow-error", at: now.toISOString() };
  try {
    writeFileSync(limitsPath(), `${JSON.stringify(limits, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
};

// ── the provider's /models ──

/** Per base URL: model id -> stated context length. Shared by every binding in the process. */
const providerWindows = new Map<string, Promise<Map<string, number>>>();

const PROBE_TIMEOUT_MS = 8_000;

/** OpenAI-compatible APIs list models at `${baseUrl}/models`, next to `${baseUrl}/chat/completions`. */
const probesAt = (model: ModelLike): string | undefined => {
  if (!model.baseUrl || !/^https?:\/\//i.test(model.baseUrl)) return undefined;
  if (!model.api || !/^openai/i.test(model.api)) return undefined;
  return `${model.baseUrl.replace(/\/+$/, "")}/models`;
};

const fetchWindows = async (url: string, model: ModelLike, registry: RegistryLike | undefined, fetchImpl: FetchLike) => {
  const windows = new Map<string, number>();
  try {
    const auth = await registry?.getApiKeyAndHeaders?.(model);
    const headers: Record<string, string> = { ...(auth?.ok ? auth.headers : undefined) };
    // omp's keyless providers resolve to "N/A": no Authorization header for those.
    const key = auth?.ok ? auth.apiKey?.trim() : undefined;
    if (key && key !== "N/A" && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${key}`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return windows;
    const body = (await res.json()) as { data?: unknown };
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? (body as unknown[]) : [];
    for (const entry of list) {
      const id = (entry as { id?: unknown })?.id;
      const n = contextLengthOfModelEntry(entry);
      if (typeof id === "string" && n) windows.set(id, n);
    }
  } catch {}
  return windows;
};

/**
 * Ask the model's provider for its context length, once per base URL per
 * process. Resolves to undefined when the API is not OpenAI-compatible, the
 * request fails, or the provider does not say.
 */
export const probeProviderWindow = async (
  model: ModelLike | undefined,
  registry: RegistryLike | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<number | undefined> => {
  if (!model?.id) return undefined;
  const url = probesAt(model);
  if (!url) return undefined;
  let pending = providerWindows.get(url);
  if (!pending) {
    pending = fetchWindows(url, model, registry, fetchImpl);
    providerWindows.set(url, pending);
  }
  return (await pending).get(model.id);
};

/** What a finished probe found, without waiting: the hook never blocks on the network. */
const settled = new Map<string, number | undefined>();

export const startProviderProbe = (model: ModelLike | undefined, registry: RegistryLike | undefined, fetchImpl?: FetchLike): void => {
  const key = modelKey(model);
  if (!key || settled.has(key)) return;
  void probeProviderWindow(model, registry, fetchImpl).then((n) => settled.set(key, n), () => settled.set(key, undefined));
};

export const providerWindow = (model: ModelLike | undefined): number | undefined => {
  const key = modelKey(model);
  return key ? settled.get(key) : undefined;
};

/** Tests: forget what the probes found. */
export const resetProviderProbes = (): void => {
  providerWindows.clear();
  settled.clear();
};
