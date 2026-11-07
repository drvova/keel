// The compaction hook, shared by both hosts: the event in, the compaction (or
// a cancel) out. The core decides all of it (op compact, lisp/src/host.lisp and
// compaction.lisp) from the event and the host's snapshot; what it cannot do is
// the host's convertToLlm, so it first lists the messages to convert, and this
// converts them. The host's own functions arrive through the binding (omp:
// src/hooks/omp-host.ts; Pi: pi.ts), so nothing here imports a host package.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync } from "fs";
import { join } from "path";
import { tell, tellLater, type Binding, type ConvertToLlm } from "../host";
import type { WindowState } from "./window-limits";
import { core } from "../core/lisp-core";
import { whenCore } from "../core/core-wait";
import { hostSnapshot } from "../core/host-snapshot";

/** What the compaction hook needs of its host. */
export type CompactionHost = Pick<Binding, "name" | "displayName" | "command" | "modelsFile" | "convertToLlm" | "triggerOf" | "config">;

/** The compaction omp-vcc wrote on the last pass, until the host has applied it. */
export interface WrittenCompaction {
  summary: string;
  /** The outcome line, told once the host has applied it. */
  statsLine: string;
  /** /omp-vcc's: the command tells the outcome itself. */
  fromCommand: boolean;
  /** The host retries the turn after it (an overflow, a cut-off reply): nothing to tell. */
  willRetry: boolean;
  /** /compact's prompt to send once it is done. */
  followUpPrompt: string | null;
}

/** Per-binding state. omp binds the factory again for every subagent, so it gets one per binding. */
export interface CompactionState {
  /** Set by a pass that wrote a compaction, cleared at the start of every pass: matched to what the host applies by its summary. */
  written: WrittenCompaction | null;
  /**
   * The /omp-vcc marker for the manual compaction the command is starting:
   * omp's ctx.compact() cannot carry instructions together with callbacks. The
   * hook reads it for a manual pass that arrives without instructions.
   */
  pendingManualInstructions: string | null;
  /** Why the hook last cancelled a compaction, for /omp-vcc to report where omp shows no notifications. */
  lastCancelNotice: string | null;
  /** The user was told the core is not there yet (src/core/lisp-core.ts). */
  coreNoticeShown: boolean;
}

export const createCompactionState = (): CompactionState => ({
  written: null,
  pendingManualInstructions: null,
  lastCancelNotice: null,
  coreNoticeShown: false,
});

/** The host's convertToLlm of one message; a message it rejects converts to nothing. */
const convertOne = (convert: ConvertToLlm, message: unknown): unknown[] => {
  try {
    return convert([message]);
  } catch {
    return [];
  }
};

export const registerCompactionHook = (pi: ExtensionAPI, host: CompactionHost, state: CompactionState, windows: WindowState) => {
  const beforeCompact = (event: any, ctx: any): { cancel: true } | { compaction: any } | undefined => {
    state.written = null;
    // Read on every run: omp's tracker forgets its trigger once read.
    const hostTrigger = host.triggerOf(event);
    const { reason, willRetry } = windows.selfTrigger ?? hostTrigger;
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
        // A pass omp-vcc started itself went by the policy as last recorded; this one carries the current policy, which may since say no.
        selfStarted: windows.selfTrigger !== null,
      },
      ...(converted ? { converted } : {}),
    });
    let reply = ask();
    if (reply.kind === "convert") reply = ask((reply.messages as unknown[]).map((m) => convertOne(host.convertToLlm, m)));
    // With the `debug` setting on, the pass's decisions, beside the config; a debug write never breaks a compaction.
    if (reply.debug) try { writeFileSync(join(host.config.dir(), "omp-vcc-debug.json"), JSON.stringify(reply.debug, null, 2)); } catch {}
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
      willRetry: reply.willRetry === true,
      followUpPrompt: (reply.followUpPrompt as string | undefined) ?? null,
    };
    return { compaction: compaction as any };
  };

  pi.on("session_before_compact", (event, ctx): any =>
    // While the core is not there, the host compacts as it would without omp-vcc; the user hears why once.
    whenCore(() => beforeCompact(event, ctx), (why) => {
      if (state.coreNoticeShown) return;
      state.coreNoticeShown = true;
      tell(ctx, why, "warning");
    }));

  // The outcome of a compaction omp-vcc wrote, once the host applied that one (another extension's can win).
  pi.on("session_compact", async (event, ctx) => {
    const written = state.written;
    if (!event.fromExtension || !written || event.compactionEntry?.summary !== written.summary) return;
    // /omp-vcc tells its own outcome, from the same record.
    if (written.fromCommand) return;
    // The host retries the turn itself after an overflow or a cut-off reply.
    if (written.willRetry) return;
    tellLater(ctx, written.statsLine);
    // omp resumes an interrupted run by itself after automatic maintenance
    // (compaction.autoContinue); only a /compact follow-up prompt is sent here.
    if (written.followUpPrompt) {
      try {
        await pi.sendUserMessage(written.followUpPrompt);
      } catch {}
    }
  });
};
