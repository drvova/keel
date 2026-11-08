// Compaction, the one flow whose state the binding keeps, since the host runs
// it across several events and calls: its session_before_compact (the core
// decides it, op compact, in two calls: what the host's convertToLlm must
// convert, then the answer), its session_compact (keel tells the outcome once
// the host applied keel's compaction), /keel, which asks the host for a pass
// and waits for it, and the compaction keel starts itself once a run settles
// past its own trigger on a model whose window the host overestimates.
//
// omp's ctx.compact() takes a focus string or an options object, not both, and
// its options have no customInstructions; only onComplete / onError say how it
// ended. So /keel hands the hook its marker through this binding's state for
// the manual pass that call starts. Pi's ctx.compact() takes customInstructions,
// which reach the hook, and returns before the compaction runs. So the marker
// goes both ways, and /keel waits for whichever the host settles by.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { core, whenCore } from "./core";
import { compactAndWait, deliver, hostSnapshot, registerCommand, tell, tellLater, type Binding, type CompactionTrigger } from "./host";
import { SURFACE } from "./surface";

/** The compaction keel wrote on the last pass, until the host has applied it. */
export interface WrittenCompaction {
  summary: string;
  /** The outcome line, told once the host has applied it. */
  statsLine: string;
  /** /keel's: the command tells the outcome itself. */
  fromCommand: boolean;
  /** The host retries the turn after it (an overflow, a cut-off reply): nothing to tell. */
  willRetry: boolean;
  /** /compact's prompt to send once it is done. */
  followUpPrompt: string | null;
}

/** Per binding: omp binds the factory again for every subagent while module state is shared. */
export interface CompactionState {
  /** Set by a pass that wrote a compaction, cleared at the start of every pass: matched to what the host applies by its summary. */
  written: WrittenCompaction | null;
  /** /keel's marker for the manual pass it is starting (omp's compact() cannot carry it). */
  pendingManualInstructions: string | null;
  /** Why the hook last cancelled, for /keel to report where omp shows no notifications. */
  lastCancelNotice: string | null;
  /** The user was told the core is not there yet. */
  coreNoticeShown: boolean;
  /** The pass keel started itself once a run settled, so the hook records why. */
  selfTrigger: CompactionTrigger | null;
  /** That the host's window is above the model's real one was told. */
  windowNoticeShown: boolean;
}

export const createCompactionState = (): CompactionState => ({
  written: null, pendingManualInstructions: null, lastCancelNotice: null, coreNoticeShown: false, selfTrigger: null, windowNoticeShown: false,
});

/** The host's convertToLlm of one message; a message it rejects converts to nothing. */
const convertOne = (convert: Binding["convertToLlm"], message: unknown): unknown[] => {
  try { return convert([message]); } catch { return []; }
};

export const registerCompaction = (pi: ExtensionAPI, host: Binding, state: CompactionState): void => {
  const beforeCompact = (event: any, ctx: any): { cancel: true } | { compaction: any } | undefined => {
    state.written = null;
    // Read on every run: omp's tracker forgets its trigger once read.
    const hostTrigger = host.triggerOf(event);
    const { reason, willRetry } = state.selfTrigger ?? hostTrigger;
    const { preparation } = event;
    const ask = (converted?: unknown[][]) => core({
      op: "compact",
      host: hostSnapshot(host, ctx),
      event: {
        branchEntries: event.branchEntries,
        customInstructions: event.customInstructions ?? (reason === "manual" ? state.pendingManualInstructions : null) ?? null,
        reason,
        willRetry,
        tokensBefore: preparation.tokensBefore,
        hostSettings: preparation.settings ?? null,
        previousSummary: typeof preparation.previousSummary === "string" ? preparation.previousSummary : null,
        fileOps: { read: [...preparation.fileOps.read], changed: [...preparation.fileOps.edited, ...preparation.fileOps.written] },
        // A pass keel started itself went by the policy as last recorded; this one carries the current policy, which may since say no.
        selfStarted: state.selfTrigger !== null,
      },
      ...(converted ? { converted } : {}),
    });
    let reply = ask();
    if (reply.kind === "convert") reply = ask((reply.messages as unknown[]).map((m) => convertOne(host.convertToLlm, m)));
    if (reply.kind === "pass") return undefined;
    if (reply.kind === "cancel") {
      if (typeof reply.notice === "string") {
        state.lastCancelNotice = reply.notice;
        tell(ctx, reply.notice, "warning");
      }
      return { cancel: true };
    }
    const compaction = reply.compaction as { summary: string };
    state.written = {
      summary: compaction.summary,
      statsLine: reply.statsLine as string,
      fromCommand: reply.fromCommand === true,
      willRetry,
      followUpPrompt: (reply.followUpPrompt as string | undefined) ?? null,
    };
    return { compaction };
  };

  pi.on("session_before_compact", (event, ctx): any =>
    // While the core is not there, the host compacts as it would without keel; the user hears why once.
    whenCore(() => beforeCompact(event, ctx), (why) => {
      if (state.coreNoticeShown) return;
      state.coreNoticeShown = true;
      tell(ctx, why, "warning");
    }));

  // The outcome of a compaction keel wrote, once the host applied that one (another extension's can win).
  pi.on("session_compact", async (event, ctx) => {
    const written = state.written;
    if (!event.fromExtension || !written || event.compactionEntry?.summary !== written.summary) return;
    // /keel tells its own; the host retries the turn itself after an overflow or a cut-off reply.
    if (written.fromCommand || written.willRetry) return;
    tellLater(ctx, written.statsLine);
    // omp resumes an interrupted run by itself after automatic maintenance; only a /compact follow-up prompt is sent here.
    const prompt = written.followUpPrompt;
    if (prompt) await deliver(ctx, "the follow-up prompt", () => pi.sendUserMessage(prompt));
  });

  registerCommand(pi, host, "", {
    description: SURFACE.commands.find((c) => c.suffix === "")!.description,
    handler: async (args, ctx) => {
      const parsed = whenCore(() => core({ op: "args", command: args ?? null }), (why) => tell(ctx, why, "warning"));
      if (!parsed) return;
      const followUpPrompt = parsed.followUpPrompt as string;
      const instructions = parsed.instructions as string;
      state.lastCancelNotice = null;
      state.pendingManualInstructions = instructions;
      try {
        await compactAndWait(ctx as any, {
          customInstructions: instructions,
          // A follow-up prompt replaces omp's resume of a turn the compaction interrupted.
          ...(followUpPrompt ? { suppressContinuation: true } : {}),
          onComplete: () => {
            // The compaction this pass wrote, which the hook keeps for the command to tell.
            const written = state.written?.fromCommand ? state.written : null;
            if (written) tellLater(ctx, written.statsLine);
            else tell(ctx, "Compacted with keel");
            if (followUpPrompt) void deliver(ctx, "the follow-up prompt", () => pi.sendUserMessage(followUpPrompt));
          },
          // Why it did not happen, from the host's error; the hook told its own reason when it cancelled.
          onError: (err: Error) => {
            const r = core({ op: "outcome", host: hostSnapshot(host, ctx as any), error: { message: err.message, mode: (ctx as any).mode ?? null, cancelNotice: state.lastCancelNotice } });
            if (typeof r.text === "string") tell(ctx, r.text, r.severity as "warning" | "error");
          },
        });
      } catch {
        // A compact() that throws has reported through onError.
      } finally {
        state.pendingManualInstructions = null;
      }
    },
  });

  // A run that settled past keel's own trigger on a model whose window the host overestimates
  // (it would only notice at the overflow): keel compacts in the host's stead, once at a time.
  let scheduled = false;
  pi.on(host.settledEvent as "agent_end", ((event: { willContinue?: boolean; aborted?: boolean } | undefined, ctx: any) => {
    if (event?.willContinue || event?.aborted || scheduled) return;
    const decided = whenCore(() => core({ op: "settled", host: hostSnapshot(host, ctx) }).settled as { notice: string } | null | undefined);
    if (!decided) return;
    if (!state.windowNoticeShown) {
      state.windowNoticeShown = true;
      tell(ctx, decided.notice);
    }
    scheduled = true;
    setTimeout(() => {
      const done = () => { state.selfTrigger = null; scheduled = false; };
      try {
        if (ctx.isIdle?.() === false) return done();
        state.selfTrigger = { reason: "threshold", willRetry: false };
        void compactAndWait(ctx).finally(done);
      } catch {
        done();
      }
    }, 0);
  }) as any);
};
