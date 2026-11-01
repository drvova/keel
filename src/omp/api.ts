// The slice of omp's extension API (@oh-my-pi/pi-coding-agent >= 18) that
// pi-vcc uses, typed structurally so the package builds without omp installed.
// tests/omp-host.test.ts checks these shapes against a real omp when present.
import type { RecallSessionManager } from "../tools/recall-spec";

export type OmpNotifyType = "info" | "warning" | "error";

export interface OmpSessionManager extends RecallSessionManager {
  getEntries: () => any[];
}

export interface OmpContext {
  ui: { notify: (message: string, type?: OmpNotifyType) => void };
  mode?: "tui" | "rpc" | "json" | "print";
  sessionManager: OmpSessionManager;
  model?: { provider?: string };
}

export interface OmpCommandContext extends OmpContext {
  /**
   * A focus string or an options object, not both. Print/RPC reject when the
   * compaction fails; the TUI reports the failure itself and resolves.
   */
  compact: (
    instructionsOrOptions?:
      | string
      | { onComplete?: () => void; onError?: (error: Error) => void; suppressContinuation?: boolean },
  ) => Promise<void>;
}

/** auto_compaction_start: fired, and awaited, before session_before_compact on every automatic pass. */
export interface OmpAutoCompactionStartEvent {
  type: "auto_compaction_start";
  reason: "threshold" | "overflow" | "idle" | "incomplete";
  action: string;
}

export interface OmpToolDefinition {
  name: string;
  label: string;
  description: string;
  /** omptype schema or plain JSON Schema. */
  parameters: Record<string, unknown>;
  /** "essential" stays a top-level tool; extension tools default to "discoverable". */
  loadMode?: "essential" | "discoverable";
  /** Approval tier; extension tools default to "exec". */
  approval?: "read" | "write" | "exec";
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: OmpContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

export interface OmpExtensionAPI {
  on: (event: string, handler: (event: any, ctx: any) => unknown) => void;
  registerCommand: (
    name: string,
    command: { description?: string; handler: (args: string, ctx: OmpCommandContext) => Promise<void> },
  ) => void;
  registerTool: (tool: OmpToolDefinition) => void;
  sendMessage: (
    message: { customType: string; content: unknown; display?: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ) => void;
  sendUserMessage: (content: string, options?: { deliverAs?: string }) => unknown;
  /** omp's own package exports (resolved on first access). */
  readonly pi: {
    convertToLlm: (messages: any[]) => any[];
    getAgentDir: () => string;
  };
}
