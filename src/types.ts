import type { Message } from "@oh-my-pi/pi-ai";

/** What started a compaction: omp's auto_compaction_start reason, or manual (/compact, /omp-vcc). */
export type CompactionReason = "manual" | "threshold" | "overflow" | "idle" | "incomplete";

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  // `injected`: the text came from an extension custom_message, not from the
  // user. It renders in the brief but is not read into [Early Session Requests]
  // or [User Messages].
  | { kind: "user"; text: string; sourceIndex?: number; injected?: boolean }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  // `failed`: the call's result came back as an error (toolResult isError).
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number; failed?: true }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
  // A command the user ran themselves: `!cmd`, or (lang "python") a python cell.
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number; lang?: "python" };
