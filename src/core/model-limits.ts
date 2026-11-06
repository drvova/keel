// Where omp-vcc learns a model's real context window when the host's is too high.
//
// omp-vcc takes the window from the host (its model's contextWindow, which omp's
// own discovery fills from the provider when it is configured to, and Pi's from
// its catalog and models.json) and makes no network call of its own. When a
// provider serves less than the host was told, its overflow error often states
// the limit ("maximum context length is 32768 tokens"); that limit is kept per
// model in omp-vcc-models.json next to the config, so the next session starts
// with it.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { effectiveWindow } from "./window";

export interface ModelLike {
  provider?: string;
  id?: string;
  contextWindow?: number | null;
}

export const modelKey = (model: ModelLike | undefined): string | undefined =>
  model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;

const LIMITS_FILE = "omp-vcc-models.json";

interface LearnedLimit {
  contextWindow: number;
  source: "overflow-error";
  at: string;
  /**
   * The host's compaction policy as the latest compaction for this model
   * carried it (preparation.settings, read by its TriggerRule): where omp-vcc
   * compacts in the host's stead (hooks/window-limits.ts), in a later session too.
   */
  hostPolicy?: object;
}

const writeLimits = (dir: string, limits: Record<string, LearnedLimit>): boolean => {
  try {
    writeFileSync(join(dir, LIMITS_FILE), `${JSON.stringify(limits, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
};

const readLimits = (dir: string): Record<string, LearnedLimit> => {
  try {
    const path = join(dir, LIMITS_FILE);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/** The limit an overflow error stated for this model, in this or an earlier session; `dir` is the config's (Config.dir). */
export const learnedWindow = (dir: string, key: string | undefined): number | undefined => {
  if (!key) return undefined;
  const n = readLimits(dir)[key]?.contextWindow;
  return typeof n === "number" && n > 0 ? n : undefined;
};

/** Keep the limit an overflow error stated. A smaller one replaces a larger one, never the reverse. */
export const recordLearnedWindow = (dir: string, key: string | undefined, contextWindow: number, now = new Date()): boolean => {
  if (!key || !(contextWindow > 0)) return false;
  const limits = readLimits(dir);
  const known = limits[key]?.contextWindow;
  if (typeof known === "number" && known <= contextWindow) return false;
  limits[key] = { ...limits[key], contextWindow, source: "overflow-error", at: now.toISOString() };
  return writeLimits(dir, limits);
};

/** The host's policy for a model with a learned window, as a compaction last carried it; undefined before one did. */
export const learnedHostPolicy = (dir: string, key: string | undefined): object | undefined => {
  const policy = key ? readLimits(dir)[key]?.hostPolicy : undefined;
  return policy && typeof policy === "object" ? policy : undefined;
};

/** Keep the policy a compaction carried, for a model with a learned window only (where it is read); written when it changed. */
export const recordHostPolicy = (dir: string, key: string | undefined, policy: object | undefined): void => {
  if (!key || !policy) return;
  const limits = readLimits(dir);
  const known = limits[key];
  if (!known || JSON.stringify(known.hostPolicy) === JSON.stringify(policy)) return;
  limits[key] = { ...known, hostPolicy: policy };
  writeLimits(dir, limits);
};

export interface WindowInfo<Host extends string = string> {
  /** What the host uses (ctx.model.contextWindow; omp's discovery fills it from the provider, Pi's catalog and models.json). */
  host?: number;
  /** What an overflow error said, in this or an earlier session. */
  learned?: number;
  /** The smaller of them. */
  effective?: number;
  source: Host | "overflow-error" | "unknown";
}

/** The window for this model: the host's, or the smaller one an overflow error stated (learned next to the config in `configDir`). */
export const windowOf = <Host extends string>(model: ModelLike | undefined, hostName: Host, configDir: string): WindowInfo<Host> => {
  const host = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
  const learned = learnedWindow(configDir, modelKey(model));
  const effective = effectiveWindow(host, learned);
  const source = effective === undefined ? "unknown"
    : effective === learned && learned !== host ? "overflow-error"
    : hostName;
  return { host, learned, effective, source };
};
