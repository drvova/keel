// Where omp-vcc learns a model's real context window when omp's is too high.
//
// omp-vcc takes the window from omp (its model's contextWindow, which omp's own
// discovery fills from the provider when it is configured to) and makes no
// network call of its own. When a provider serves less than omp was told, its
// overflow error often states the limit ("maximum context length is 32768
// tokens"); that limit is kept per model in omp-vcc-models.json next to the
// config, so the next session starts with it.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { settingsPath } from "./settings";

export interface ModelLike {
  provider?: string;
  id?: string;
  contextWindow?: number | null;
}

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
