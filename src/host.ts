// The host keel runs on, omp (oh-my-pi) or Pi, as each entry binds it, and the
// few things only the host can do: read its session manager into the snapshot
// every op carries, list the project's session files by time, and act on what
// the core answers (append an entry, tell the user, send a message). index.ts
// builds omp's host from what omp hands an extension (`pi.pi`); pi.ts builds
// Pi's from Pi's own package. Shared code reads what differs from here, never
// from the host's name.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readdirSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";
import type { Config } from "./settings";
import { SURFACE } from "./surface";

/** What started a compaction: omp's auto_compaction_start reason or Pi's session_before_compact reason, or manual (/compact, /keel). */
export type CompactionReason = "manual" | "threshold" | "overflow" | "idle" | "incomplete";

/** What started a compaction, and whether the host retries the turn after it. */
export interface CompactionTrigger {
  reason: CompactionReason;
  willRetry: boolean;
}

export const MANUAL_TRIGGER: CompactionTrigger = { reason: "manual", willRetry: false };

/** What differs between the hosts and is the same for every session of one. */
interface HostProfile {
  name: "omp" | "pi";
  /** The host's name in what keel tells the user. */
  displayName: "omp" | "Pi";
  /** The prefix keel's commands had before, kept as an alias of each: /omp-vcc… on omp, /pi-vcc… on Pi. */
  oldCommand: "omp-vcc" | "pi-vcc";
  /**
   * The event after which the host will not continue on its own: omp's
   * agent_end without `willContinue`; Pi's agent_settled (its agent_end comes
   * before overflow recovery and queued work).
   */
  settledEvent: "agent_end" | "agent_settled";
  /** Where a user sets a model's contextWindow for the host. */
  modelsFile: string;
  /** The host rewrites messages in the session file (omp: shake, supersedeReads, pruning), so keel keeps their originals (src/raw-capture.ts). Pi never does. */
  rewritesInPlace: boolean;
}

/** A host as a binding of keel uses it: its profile and its own functions. */
export interface Host extends HostProfile {
  /** The host's convertToLlm (omp's from `pi.pi`, Pi's from its package); keel calls it with one message at a time. */
  convertToLlm: (messages: any[]) => any[];
  /** The host's agent directory: where keel's config and learned limits live. */
  agentDir: () => string;
  /** The trigger of the compaction a session_before_compact event is for. */
  triggerOf: (event: unknown) => CompactionTrigger;
}

/** A host as one binding of keel sees it: with its own config file. */
export interface Binding extends Host {
  config: Config;
}

export const OMP_HOST: HostProfile = { name: "omp", displayName: "omp", oldCommand: "omp-vcc", settledEvent: "agent_end", modelsFile: "omp's models.yml", rewritesInPlace: true };
export const PI_HOST: HostProfile = { name: "pi", displayName: "Pi", oldCommand: "pi-vcc", settledEvent: "agent_settled", modelsFile: "Pi's models.json", rewritesInPlace: false };

/**
 * omp: its own convertToLlm and agent directory from `pi.pi`, so nothing here
 * imports an omp package at runtime. omp's session_before_compact carries no
 * trigger: every automatic pass emits auto_compaction_start (and awaits its
 * handlers) right before the hook, so its reason is kept for the next hook run,
 * which reads it once (a pass that ends without auto_compaction_end must not
 * leave it behind for a later manual one). A run with none pending is manual.
 * omp retries the turn after an overflow or a cut-off ("incomplete") reply,
 * never after threshold or idle maintenance, and resumes the run itself after
 * automatic maintenance (`compaction.autoContinue`).
 */
export const ompHost = (pi: ExtensionAPI): Host => {
  let pending: CompactionTrigger | undefined;
  pi.on("auto_compaction_start", (event) => {
    const reason = event?.reason;
    pending = {
      reason: reason === "overflow" || reason === "idle" || reason === "incomplete" ? reason : "threshold",
      willRetry: reason === "overflow" || reason === "incomplete",
    };
  });
  pi.on("auto_compaction_end", () => { pending = undefined; });
  return {
    ...OMP_HOST,
    convertToLlm: (messages) => pi.pi.convertToLlm(messages),
    agentDir: () => pi.pi.getAgentDir(),
    triggerOf: () => {
      const trigger = pending ?? MANUAL_TRIGGER;
      pending = undefined;
      return trigger;
    },
  };
};

// --- the session, as the host holds it -------------------------------------------------

/** What keel reads of the host's session manager; omp's and Pi's ReadonlySessionManager both have it. */
export interface SessionManagerLike {
  getSessionFile?(): string | undefined;
  getSessionDir?(): string | undefined;
  getEntries?(): any[];
  getBranch?(): any[];
}

/** What a host's ctx offers keel at an event. */
export interface HostCtx {
  sessionManager?: SessionManagerLike;
  model?: { provider?: string; id?: string; contextWindow?: number | null } | null;
  getContextUsage?: () => { tokens?: number | null } | undefined;
  /** The session's working directory, as both hosts' ctx carry it. */
  cwd?: string;
}

/** A session manager's list; undefined where it gives none or the call throws (a closed session). */
const listOf = (read: (() => unknown) | undefined): any[] | undefined => {
  try {
    const list = read?.();
    return Array.isArray(list) ? list : undefined;
  } catch { return undefined; }
};
export const hostBranch = (sm: SessionManagerLike | undefined) => listOf(sm?.getBranch?.bind(sm));
/** The session's file, or undefined: a closed session throws on every read, this one too. */
export const sessionFileOf = (sm: SessionManagerLike | undefined): string | undefined => {
  try {
    const file = sm?.getSessionFile?.();
    return typeof file === "string" ? file : undefined;
  } catch { return undefined; }
};
export const hostEntries = (sm: SessionManagerLike | undefined) => listOf(sm?.getEntries?.bind(sm));

const DATA_ENTRY_TYPES = new Set<string>(SURFACE.dataEntryTypes);

/**
 * One entry as the snapshot carries it: its place in the tree and what it is,
 * without its body. A message is its role, time, attribution and a tool
 * result's call id, so #N, the branch, the turns and a request's messages read
 * from it; a compaction keeps where its kept tail starts; keel's own pin and
 * evict entries keep their data, which the pins and the evictions are read from.
 */
const skeleton = (e: any): Record<string, unknown> => ({
  type: e?.type,
  id: e?.id,
  parentId: e?.parentId,
  ...(typeof e?.customType === "string" ? { customType: e.customType } : {}),
  ...(DATA_ENTRY_TYPES.has(e?.customType) ? { data: e.data } : {}),
  ...(e?.type === "compaction" ? { firstKeptEntryId: e.firstKeptEntryId, providerReplayThroughEntryId: e.providerReplayThroughEntryId } : {}),
  ...(e && "message" in e ? { message: e.message == null ? null : messageSkeleton(e.message) } : {}),
});

const messageSkeleton = (m: any): Record<string, unknown> => ({
  role: m.role,
  ...(m.timestamp !== undefined ? { timestamp: m.timestamp } : {}),
  ...(typeof m.attribution === "string" ? { attribution: m.attribution } : {}),
  ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
  ...(m.steering === true ? { steering: true } : {}),
});

type SnapshotHost = Pick<HostProfile, "name" | "displayName" | "modelsFile"> & { config: Pick<Config, "path"> };

/**
 * What the host knows at an event, as the one snapshot every op for it carries
 * (lisp/src/host.lisp reads it). The core counts #N, finds the branch, loads the
 * settings and works out the window from it.
 */
export const hostSnapshot = (host: SnapshotHost, ctx: HostCtx | undefined) => {
  const sm = ctx?.sessionManager;
  const branch = hostBranch(sm) ?? [];
  const tree = hostEntries(sm) ?? branch;
  let tokens: number | null = null;
  try { tokens = ctx?.getContextUsage?.()?.tokens ?? null; } catch {}
  const m = ctx?.model;
  return {
    name: host.name,
    displayName: host.displayName,
    modelsFile: host.modelsFile,
    configPath: host.config.path(),
    sessionFile: sessionFileOf(sm) ?? null,
    cwd: ctx?.cwd ?? process.cwd(),
    model: m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : null,
    contextTokens: tokens,
    tree: tree.map(skeleton),
    branch: branch.flatMap((e: any) => (typeof e?.id === "string" && e.id ? [e.id] : [])),
  };
};

const sameFile = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/**
 * The project's other session files, newest first by last write (SBCL reads a
 * file's time only to the second): the directory the session manager keeps
 * this project's sessions in, or else the session file's, less the session's own.
 */
export const projectFiles = (ctx: HostCtx | undefined): string[] => {
  const sm = ctx?.sessionManager;
  const file = sessionFileOf(sm);
  if (!file) return [];
  let dir = dirname(file);
  try { const d = sm?.getSessionDir?.(); if (typeof d === "string" && d) dir = d; } catch {}
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(dir, n))
    .filter((f) => !sameFile(f, file))
    .flatMap((f) => { try { return [{ f, mtime: statSync(f).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
};

// --- acting on the core's answers ---------------------------------------------------

export interface NotifyCtx {
  /** False in omp's print and json modes, whose extension UI drops notify. */
  hasUI?: boolean;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

/**
 * Tell the user: the host's notify where there is a UI. Print and json modes
 * have none (their notify is a no-op), so there it goes to stderr, as omp's own
 * commands' output does, and stdout stays the model's. The session may have
 * ended and its UI gone by the time something is told: then it is not.
 */
export const tell = (ctx: NotifyCtx, message: string, type: "info" | "warning" | "error" = "info"): void => {
  try {
    if (ctx.hasUI === false) process.stderr.write(`${message}\n`);
    else ctx.ui.notify(message, type);
  } catch {}
};

/** A compaction hook returns before the host applies it and shows its own status; its outcome line comes after that. */
const AFTER_HOST_STATUS_MS = 500;

/** Tell once the host's own status has shown; at once where there is no UI (print mode may exit before a timer). */
export const tellLater = (ctx: NotifyCtx, message: string): void => {
  if (ctx.hasUI === false) return tell(ctx, message);
  setTimeout(() => tell(ctx, message), AFTER_HOST_STATUS_MS);
};

/**
 * Hand the host a message to send (a follow-up prompt, a note for the agent);
 * if the host refuses it, the user hears what was not sent instead of nothing.
 */
export const deliver = (ctx: NotifyCtx, what: string, send: () => unknown): Promise<void> => {
  const refused = (err: unknown) => tell(ctx, `keel: could not send ${what}: ${err instanceof Error ? err.message : String(err)}`, "warning");
  try {
    return Promise.resolve(send()).then(() => {}, refused);
  } catch (err) {
    refused(err);
    return Promise.resolve();
  }
};

/** What the core asks the host to do, in order (lisp/src/surface.lisp). */
type Effect =
  | { do: "append"; customType: string; data: unknown }
  | { do: "tell"; text: string; severity: "info" | "warning" | "error" }
  | { do: "send"; what: string; message: { customType: string; content: string; display: boolean }; options: Record<string, unknown> };

/** Do what the core answered; a message is sent without waiting for the host to take it. */
export const act = (pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">, ctx: NotifyCtx, effects: unknown): Promise<void> => {
  const sent: Promise<void>[] = [];
  for (const e of (effects ?? []) as Effect[]) {
    if (e.do === "append") pi.appendEntry(e.customType, e.data);
    else if (e.do === "tell") tell(ctx, e.text, e.severity);
    else if (e.do === "send") sent.push(deliver(ctx, e.what, () => pi.sendMessage(e.message as any, e.options as any)));
    else throw new Error(`keel's core answered an effect this binding does not know: ${JSON.stringify(e)}`);
  }
  return Promise.all(sent).then(() => {});
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
    // compact() throwing, or settling rejected, is told through onError as the host's own errors are, once.
    // The callbacks always run: Pi's compact() settles before they do.
    let told = false;
    const fail = (err: unknown) => {
      if (!told) { told = true; options.onError?.(err instanceof Error ? err : new Error(String(err))); }
      resolve();
    };
    let returned: unknown;
    try {
      returned = ctx.compact({ ...options, onComplete: () => { options.onComplete?.(); resolve(); }, onError: (err: Error) => fail(err) });
    } catch (err) {
      return fail(err);
    }
    if (returned && typeof (returned as Promise<unknown>).then === "function") (returned as Promise<unknown>).then(() => resolve(), (err) => fail(err));
  });

/**
 * Register one of keel's commands, `/keel` or `/keel-SUFFIX`, and the same
 * command under the name it had before (`/omp-vcc-SUFFIX` on omp,
 * `/pi-vcc-SUFFIX` on Pi), so what users type still works.
 */
export const registerCommand = (
  pi: Pick<ExtensionAPI, "registerCommand">,
  host: Pick<HostProfile, "oldCommand">,
  suffix: string,
  options: Parameters<ExtensionAPI["registerCommand"]>[1] & { description: string },
): void => {
  const name = suffix ? `${SURFACE.command}-${suffix}` : SURFACE.command;
  pi.registerCommand(name, options);
  pi.registerCommand(suffix ? `${host.oldCommand}-${suffix}` : host.oldCommand, { ...options, description: `The old name of /${name}. ${options.description}` });
};
