import type { Message } from "@earendil-works/pi-ai";

/** Pi reports the first three; omp also compacts when idle and after a cut-off ("incomplete") reply. */
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
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
  // A command the user ran themselves: Pi/omp `!cmd`, or (lang "python") an omp python cell.
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number; lang?: "python" };
