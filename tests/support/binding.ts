// keel on a fake host, for tests: the real register() (src/register.ts) on an
// API that records what keel registers and does, and helpers that call its
// tools and commands as the host does. The config is KEEL_CONFIG_PATH when a
// test sets it, else a file under the temp dir, never the user's.
import { tmpdir } from "os";
import { join } from "path";
import { openConfig } from "../../src/settings";
import { act, hostSnapshot, OMP_HOST, MANUAL_TRIGGER, projectFiles, type Binding } from "../../src/host";
import { core } from "../../src/core";
import { register } from "../../src/register";

export const testConfig = openConfig(() => join(tmpdir(), "keel-test-agent"));

/** omp's profile with that config, every compaction a manual one. */
export const ompBinding: Binding = { ...OMP_HOST, config: testConfig, convertToLlm: (m) => m, agentDir: () => join(tmpdir(), "keel-test-agent"), triggerOf: () => MANUAL_TRIGGER };

/** A host's appendEntry, as a test records entries. */
export interface Appender { appendEntry: (customType: string, data?: unknown) => void }

/**
 * One call of a keel tool as src/register.ts makes it, synchronously: the
 * core's text, the entries it decided appended through `host`.
 */
export const callTool = (name: string, params: unknown, ctx: any, host: Appender = { appendEntry: () => {} }, on: Binding = ompBinding): string => {
  const reply = core({ op: "tool", name, params: params ?? null, projectFiles: projectFiles(ctx), host: hostSnapshot(on, ctx) });
  actOn(reply.effects, host);
  return reply.text as string;
};

/** The effects of an answer acted on through `host`: what was told, joined by lines (undefined: nothing), and what was sent. */
const actOn = (effects: unknown, host: Appender) => {
  const told: string[] = [];
  const sent: any[] = [];
  void act({ appendEntry: host.appendEntry, sendMessage: (message: any) => { sent.push(message); } } as any, { ui: { notify: (m: string) => told.push(m) } }, effects);
  return { told: told.length ? told.join("\n") : undefined, sent };
};

/** One of keel's commands (all but /keel) as src/register.ts runs it, synchronously: what the user is told. */
export const callCommand = (suffix: string, args: string, ctx: any, host: Appender = { appendEntry: () => {} }, on: Binding = ompBinding): string | undefined =>
  actOn(core({ op: "command", suffix, args, projectFiles: projectFiles(ctx), host: hostSnapshot(on, ctx) }).effects, host).told;

/**
 * The host's next request through keel's context event (op context), as
 * src/register.ts sends it: the messages to send instead (undefined: as they
 * are), the note sent the model, and what the user is told.
 */
export const requestContext = (messages: unknown[], ctx: any, host: Appender, tool = false, on: Binding = ompBinding) => {
  const reply = core({ op: "context", messages, tool, host: hostSnapshot(on, ctx) });
  const { told, sent } = actOn(reply.effects, host);
  return { messages: (reply.messages ?? undefined) as unknown[] | undefined, note: sent[0]?.content as string | undefined, notice: told };
};

/** One keel_recall call on omp's binding, the model's window `contextWindow` when one is given. */
export const executeRecall = (params: unknown, sessionManager: any, options: { contextWindow?: number } = {}): string =>
  callTool("keel_recall", params, { sessionManager, model: options.contextWindow ? { contextWindow: options.contextWindow } : null });

/** One keel_pin call on omp's binding, appended through `host`. */
export const executePin = (params: unknown, host: Appender, sessionManager: any, ctx: any = { sessionManager }): string =>
  callTool("keel_pin", params, ctx, host);

/** What keel did on a fake host: what it registered, appended, told and sent. */
export interface FakeHost {
  tools: Map<string, any>;
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
  appended: Array<{ customType: string; data: unknown }>;
  sent: Array<{ message: any; options: any }>;
  notices: string[];
  /** Every handler for EVENT, in order; the last answer that is not undefined. */
  fire: (event: string, payload: any, ctx: any) => any;
  /** A tool's text, called as the host calls it. */
  tool: (name: string, params: unknown, ctx: any) => Promise<string>;
  /** A command run as the host runs it. */
  command: (name: string, args: string, ctx: any) => Promise<void>;
}

/** register() on a fake omp (or Pi, with `profile`), whose appendEntry the test may route with `appendEntry`. */
export const fakeHost = (options: { profile?: typeof OMP_HOST; appendEntry?: (customType: string, data?: unknown) => void } = {}): FakeHost => {
  const h: FakeHost = {
    tools: new Map(), commands: new Map(), handlers: new Map(), appended: [], sent: [], notices: [],
    fire: (event, payload, ctx) => {
      let answer: any;
      for (const f of h.handlers.get(event) ?? []) { const r = f({ type: event, ...payload }, ctx); if (r !== undefined) answer = r; }
      return answer;
    },
    tool: async (name, params, ctx) => (await h.tools.get(name).execute("call", params, undefined, undefined, ctx)).content[0].text,
    command: (name, args, ctx) => h.commands.get(name)!(args, { ui: { notify: (m: string) => h.notices.push(m) }, ...ctx }),
  };
  const pi: any = {
    on: (name: string, f: any) => h.handlers.set(name, [...(h.handlers.get(name) ?? []), f]),
    registerTool: (t: any) => h.tools.set(t.name, t),
    registerCommand: (name: string, c: any) => h.commands.set(name, c.handler),
    appendEntry: (customType: string, data?: unknown) => { h.appended.push({ customType, data }); options.appendEntry?.(customType, data); },
    sendMessage: (message: any, opts: any) => { h.sent.push({ message, options: opts }); },
    sendUserMessage: () => {},
  };
  register(pi, { ...(options.profile ?? OMP_HOST), convertToLlm: (m: any[]) => m, agentDir: () => join(tmpdir(), "keel-test-agent"), triggerOf: () => MANUAL_TRIGGER });
  return h;
};

/** omp's keel_recall tool as the extension registers it, for tests of the tool's own surface. */
export const recallTool = (): any => fakeHost().tools.get("keel_recall");

/**
 * One call of that tool on the session file FILE, the session manager holding
 * the entries ENTRIES (ids) with BRANCH (ids, all of them by default) its path.
 */
export const callRecallTool = async (tool: any, file: string, params: Record<string, unknown>, entries: readonly string[], branch: readonly string[] = entries): Promise<string> => {
  const result = await tool.execute("tool-call", params, undefined, undefined, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => branch.map((id) => ({ id })),
      getEntries: () => entries.map((id) => ({ id })),
    },
  });
  return result.content[0].text as string;
};
