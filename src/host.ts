// The host omp-vcc runs on, omp (oh-my-pi) or Pi, as each entry binds it:
// index.ts builds omp's from what omp hands an extension (src/hooks/omp-host.ts),
// pi.ts builds Pi's from Pi's own package. Each piece comes from that host's
// code; shared code reads what differs from here, never from the host's name.
import type { TriggerRule } from "./core/window";
import { isRecoveryReason, type CompactionReason } from "./types";
import type { Config } from "./core/settings";
import { windowOf, type ModelLike, type WindowInfo } from "./core/model-limits";
import type { SessionManagerLike } from "./core/session-file";

export type HostName = "omp" | "pi";

/** The host's convertToLlm (omp's from `pi.pi`, Pi's from its package); omp-vcc calls it with one message at a time. */
export type ConvertToLlm = (messages: any[]) => any[];

/** What started a compaction, and whether the host retries the turn after it. */
export interface CompactionTrigger {
  reason: CompactionReason;
  willRetry: boolean;
}

export const MANUAL_TRIGGER: CompactionTrigger = { reason: "manual", willRetry: false };

/** A pass that must shrink the context: an overflow, or a reply cut off at the limit. */
export const isRecovery = (trigger: CompactionTrigger): boolean =>
  isRecoveryReason(trigger.reason) || trigger.willRetry;

/** What differs between the hosts and is the same for every session of one. */
export interface HostProfile {
  name: HostName;
  /** The host's name in what omp-vcc tells the user. */
  displayName: "omp" | "Pi";
  /** omp-vcc's command prefix: /omp-vcc… on omp; /pi-vcc… on Pi, the names pi-vcc users know. */
  command: "omp-vcc" | "pi-vcc";
  /** Where the host compacts, from the policy it hands the hook. */
  rule: TriggerRule;
  /**
   * The event after which the host will not continue on its own: omp's
   * agent_end without `willContinue`; Pi's agent_settled (its agent_end comes
   * before overflow recovery and queued work).
   */
  settledEvent: "agent_end" | "agent_settled";
  /** Where a user sets a model's contextWindow for the host. */
  modelsFile: string;
  /**
   * The host rewrites messages in the session file (omp: shake, supersedeReads,
   * pruning), so omp-vcc keeps their originals (src/hooks/raw-capture.ts). Pi
   * never rewrites an entry.
   */
  rewritesInPlace: boolean;
}

/** A host as a binding of omp-vcc uses it. */
export interface Host extends HostProfile {
  convertToLlm: ConvertToLlm;
  /** The host's agent directory: where omp-vcc's config and learned limits live. */
  agentDir: () => string;
  /** The trigger of the compaction a session_before_compact event is for. */
  triggerOf: (event: unknown) => CompactionTrigger;
}

/** A host as one binding of omp-vcc sees it: with its own config file. */
export interface Binding extends Host {
  config: Config;
  /** The model's window: the host's, or the smaller one an overflow error stated (learned next to the config). */
  window(model: ModelLike | undefined): WindowInfo<HostName>;
}

/** A host profile with its config, and the window read through it. */
export const bind = <H extends HostProfile>(host: H, config: Config): H & Pick<Binding, "config" | "window"> => ({
  ...host,
  config,
  window: (model) => windowOf(model, host.name, config.dir()),
});

export const OMP_HOST: HostProfile = {
  name: "omp",
  displayName: "omp",
  command: "omp-vcc",
  rule: "omp",
  settledEvent: "agent_end",
  modelsFile: "omp's models.yml",
  rewritesInPlace: true,
};

export const PI_HOST: HostProfile = {
  name: "pi",
  displayName: "Pi",
  command: "pi-vcc",
  rule: "pi",
  settledEvent: "agent_settled",
  modelsFile: "Pi's models.json",
  rewritesInPlace: false,
};

/**
 * Compact and wait until it has ended, however it ends. omp's compact()
 * settles with the compaction (its callbacks have run by then); Pi's starts
 * it and reports only through the callbacks.
 */
export const compactAndWait = (
  ctx: { compact: (options: any) => unknown },
  options: { customInstructions?: string; suppressContinuation?: boolean; onComplete?: () => void; onError?: (err: Error) => void } = {},
): Promise<void> =>
  new Promise<void>((resolve) => {
    const returned = ctx.compact({
      ...options,
      onComplete: () => {
        options.onComplete?.();
        resolve();
      },
      onError: (err: Error) => {
        options.onError?.(err);
        resolve();
      },
    });
    if (returned && typeof (returned as Promise<unknown>).then === "function") {
      (returned as Promise<unknown>).then(() => resolve(), () => resolve());
    }
  });

export interface NotifyCtx {
  /** False in omp's print and json modes, whose extension UI drops notify. */
  hasUI?: boolean;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
  sessionManager?: SessionManagerLike;
}

/**
 * Tell the user: omp's notify where there is a UI. Print and json modes have
 * none (their notify is a no-op), so there it goes to stderr, as omp's own
 * commands' output does, and stdout stays the model's.
 */
export const tell = (ctx: NotifyCtx, message: string, type: "info" | "warning" | "error" = "info"): void => {
  if (ctx.hasUI === false) {
    try {
      process.stderr.write(`${message}\n`);
    } catch {}
    return;
  }
  ctx.ui.notify(message, type);
};
