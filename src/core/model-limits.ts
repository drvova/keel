// Where omp-vcc learns a model's real context window when the host's is too high.
//
// omp-vcc takes the window from the host (its model's contextWindow, which omp's
// own discovery fills from the provider when it is configured to, and Pi's from
// its catalog and models.json) and makes no network call of its own. When a
// provider serves less than the host was told, its overflow error often states
// the limit ("maximum context length is 32768 tokens"); that limit is kept per
// model in omp-vcc-models.json next to the config, with the host's compaction
// policy as the latest compaction for that model carried it, so the next session
// starts with both. The core reads and writes the file (lisp/src/limits.lisp, op limits).
import { core } from "./lisp-core";

export interface ModelLike {
  provider?: string;
  id?: string;
  contextWindow?: number | null;
}

/** What the core needs of a model: its provider, id and window. */
const modelOf = (model: ModelLike | undefined) => (model ? { provider: model.provider, id: model.id, contextWindow: model.contextWindow } : null);

const limits = (request: Record<string, unknown>) => core({ op: "limits", ...request });

/** Keep the limit an overflow error stated for `model`; a smaller one replaces a larger one, never the reverse. `dir` is the config's (Config.dir). */
export const learnWindow = (dir: string, model: ModelLike | undefined, contextWindow: number, now = new Date()): boolean =>
  limits({ action: "learn", model: modelOf(model), dir, window: contextWindow, now: now.toISOString() }).recorded === true;

/** The same by the model's provider/id key, as the file names it. */
export const recordLearnedWindow = (dir: string, key: string, contextWindow: number, now = new Date()): boolean =>
  limits({ action: "learn", key, dir, window: contextWindow, now: now.toISOString() }).recorded === true;

/** The limit an overflow error stated for this model's key, in this or an earlier session. */
export const learnedWindow = (dir: string, key: string): number | undefined => limits({ action: "learned", key, dir }).window as number | undefined;

/** The host's policy for a model with a learned window, as a compaction last carried it; undefined before one did. */
export const learnedHostPolicy = (dir: string, key: string): object | undefined => limits({ action: "policy", key, dir }).policy as object | undefined;

/** Keep the policy a compaction carried, for a model with a learned window only (where it is read); written when it changed. */
export const keepHostPolicy = (dir: string, model: ModelLike | undefined, policy: object | undefined): void => {
  limits({ action: "record-policy", model: modelOf(model), dir, policy: policy ?? null });
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
export const windowOf = <Host extends string>(model: ModelLike | undefined, hostName: Host, configDir: string): WindowInfo<Host> =>
  limits({ action: "window", model: modelOf(model), hostName, dir: configDir }).window as WindowInfo<Host>;
