/** What started a compaction: omp's auto_compaction_start reason or Pi's session_before_compact reason, or manual (/compact, /omp-vcc, /pi-vcc). Pi's are manual, threshold and overflow. */
export type CompactionReason = "manual" | "threshold" | "overflow" | "idle" | "incomplete";

/** What the host says the summarized turns did to files (its preparation.fileOps). */
export interface FileOps {
  read?: string[];
  /** Edited or written whole; whether a file is new, the blocks tell. */
  changed?: string[];
}

export type NormalizedBlock =
  // `injected`: the text came from an extension custom_message, not from the
  // user. It renders in the brief but is not read into [Early Session Requests]
  // or [User Messages].
  | { kind: "user"; text: string; sourceIndex?: number; injected?: boolean }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  // `failed`: the call's result came back as an error (toolResult isError).
  | { kind: "tool_call"; id?: string; name: string; args: Record<string, unknown>; sourceIndex?: number; failed?: true }
  // `callId`: the id of the call this is the result of.
  | { kind: "tool_result"; callId?: string; name: string; text: string; sourceIndex?: number }
  // A command the user ran themselves: `!cmd`, or (lang "python") a python cell.
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number; lang?: "python" };
