// A session on a real model with omp-vcc loaded, in omp or in Pi, as a user runs
// it: the model is a provider in the host's own models file (omp's `models.yml`,
// Pi's `models.json`) whose key the host reads from the environment, omp-vcc is
// loaded from this package (omp: `omp.extensions`; Pi: `pi.extensions`), and
// every turn goes through the host's own agent loop, tools, context counting and
// compaction. Shared by the long-horizon and Cybench sessions
// (tests/support/long-horizon.ts, tests/support/cybench.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "../..");

/** The model the sessions run on: DeepSeek V4.1 Flash, on OpenScale's OpenAI-compatible API. */
export const LONG_HORIZON_MODEL = { baseUrl: "https://api.openscale.so/v1", model: "deepseek/deepseek-v4.1-flash", api: "openai-completions" };

/** A local, git-ignored file the key may come from instead: `OMP_VCC_LH_API_KEY=…` lines, like a .env file. */
export const KEY_FILE = resolve(REPO, "research/long-horizon.env");

/** OMP_VCC_LH_* settings from KEY_FILE, for those the environment does not set (omp then reads the key from the env). */
const loadKeyFile = () => {
  if (!existsSync(KEY_FILE)) return;
  for (const line of readFileSync(KEY_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?(OMP_VCC_LH_[A-Z_]+)\s*=\s*['"]?([^'"\s]*)['"]?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
};

/**
 * The real model a session runs on; undefined without a key for it. The tests
 * take the key from the environment only, so a plain `bun test` never starts
 * hours of model turns; the benchmark scripts also read KEY_FILE (`keyFile`).
 */
export const realModel = (options: { keyFile?: boolean } = {}): { baseUrl: string; model: string; api: string } | undefined => {
  if (options.keyFile) loadKeyFile();
  if (!process.env.OMP_VCC_LH_API_KEY) return undefined;
  return {
    baseUrl: process.env.OMP_VCC_LH_BASE_URL || LONG_HORIZON_MODEL.baseUrl,
    model: process.env.OMP_VCC_LH_MODEL || LONG_HORIZON_MODEL.model,
    api: process.env.OMP_VCC_LH_API || LONG_HORIZON_MODEL.api,
  };
};

export type Host = "omp" | "pi";

/** The host a session runs in: `OMP_VCC_LH_HOST` (`omp` or `pi`), omp by default. */
export const sessionHost = (): Host => (process.env.OMP_VCC_LH_HOST === "pi" ? "pi" : "omp");

export interface HostSessionOptions {
  /** omp or Pi; sessionHost() by default. */
  host?: Host;
  /** A temp directory the session owns: the host's agent dir, its sessions and omp-vcc's config go here. */
  work: string;
  /** The project the agent works in (the host's cwd). */
  cwd: string;
  /** The window the host is told (default 128K): its trigger, and so omp-vcc's budgets, follow it. */
  contextWindow?: number;
  /** omp-vcc settings, over `overrideDefaultCompaction: true` (`{ overrideDefaultCompaction: false }`: the host's own compaction). */
  config?: Record<string, unknown>;
}

export interface HostSession {
  host: Host;
  session: any;
  sessionManager: any;
  /** A registered tool as the host's agent runs it (validated arguments, the session's context). */
  tool: (name: string) => any;
  /**
   * The compaction the long-horizon session runs every few turns: omp's idle
   * pass; on Pi, which has none, Pi's own /compact (a manual pass through Pi's
   * compaction pipeline).
   */
  periodicCompaction: () => Promise<void>;
  /** Close the session and put back the env it changed. */
  close: () => Promise<void>;
}

export const openHostSession = async (options: HostSessionOptions): Promise<HostSession> =>
  (options.host ?? sessionHost()) === "pi" ? openPiSession(options) : openOmpSession(options);

/** The provider, the env and omp-vcc's config every session starts from; `restore` puts the env back. */
const prepare = (options: HostSessionOptions) => {
  const provider = realModel({ keyFile: true });
  if (!provider) throw new Error(`set OMP_VCC_LH_API_KEY, or put it in ${KEY_FILE}, to a key for DeepSeek V4.1 Flash on OpenScale`);
  const saved = ["PI_CODING_AGENT_DIR", "OMP_VCC_CONFIG_PATH"].map((k) => [k, process.env[k]] as const);
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const agentDir = join(options.work, "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OMP_VCC_CONFIG_PATH = join(options.work, "omp-vcc-config.json");
  writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, ...options.config }));
  return { provider, agentDir, restore };
};

const openOmpSession = async (options: HostSessionOptions): Promise<HostSession> => {
  const { provider, agentDir, restore } = prepare(options);
  try {
    // The provider as a user configures it: omp reads the key from the named environment variable.
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:",
      "  long-horizon:",
      `    baseUrl: ${JSON.stringify(provider.baseUrl)}`,
      "    apiKey: OMP_VCC_LH_API_KEY",
      `    api: ${provider.api}`,
      "    models:",
      `      - id: ${JSON.stringify(provider.model)}`,
      "        name: long-horizon model",
      `        api: ${provider.api}`,
      "        reasoning: false",
      "        input: [text]",
      `        contextWindow: ${options.contextWindow ?? 128_000}`,
      "        maxTokens: 8192",
      "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
      "",
    ].join("\n"));

    const omp: any = await import("@oh-my-pi/pi-coding-agent");
    const { initializeExtensions }: any = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init" as string);
    const sessionManager = omp.SessionManager.create(options.cwd, join(options.work, "sessions"));
    const session = (await omp.createAgentSession({
      cwd: options.cwd,
      agentDir,
      sessionManager,
      // omp keeps this much verbatim before asking any hook: let every pass reach the compactor.
      settings: omp.Settings.isolated({ "compaction.keepRecentTokens": 1 }),
      modelPattern: `long-horizon/${provider.model}`,
      thinkingLevel: "off",
      additionalExtensionPaths: [REPO],
      disableExtensionDiscovery: true,
      enableMCP: false,
      enableLsp: false,
      hasUI: false,
    })).session;
    if (session.model?.provider !== "long-horizon") {
      await session.dispose?.();
      throw new Error(`omp picked ${session.model?.provider}/${session.model?.id}, not the configured model`);
    }
    await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, mode: "rpc", uiContext: new Proxy({}, { get: () => () => undefined }) });
    return {
      host: "omp",
      session,
      sessionManager,
      tool: (name) => session.getToolByName(name),
      periodicCompaction: () => session.runIdleCompaction(),
      close: async () => {
        await session.dispose?.();
        restore();
      },
    };
  } catch (e) {
    restore();
    throw e;
  }
};

const openPiSession = async (options: HostSessionOptions): Promise<HostSession> => {
  const { provider, agentDir, restore } = prepare(options);
  try {
    // The provider as a user configures it: Pi interpolates the key from the environment variable.
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        "long-horizon": {
          baseUrl: provider.baseUrl,
          apiKey: "$OMP_VCC_LH_API_KEY",
          api: provider.api,
          models: [{
            id: provider.model,
            name: "long-horizon model",
            api: provider.api,
            reasoning: false,
            input: ["text"],
            contextWindow: options.contextWindow ?? 128_000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }, null, 2));

    const pi: any = await import("@earendil-works/pi-coding-agent" as string);
    const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
    const model = modelRuntime.getModel("long-horizon", provider.model);
    if (!model) throw new Error(`Pi did not load long-horizon/${provider.model} from ${modelsPath}`);
    const resourceLoader = new pi.DefaultResourceLoader({ cwd: options.cwd, agentDir, additionalExtensionPaths: [REPO] });
    await resourceLoader.reload();
    const sessionManager = pi.SessionManager.create(options.cwd, join(options.work, "sessions"));
    const { session } = await pi.createAgentSession({
      cwd: options.cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      sessionManager,
      // Pi keeps this much verbatim before asking any hook: let every pass reach the compactor.
      settingsManager: pi.SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
    });
    if (session.model?.provider !== "long-horizon") {
      await session.dispose?.();
      throw new Error(`Pi picked ${session.model?.provider}/${session.model?.id}, not the configured model`);
    }
    await session.bindExtensions({ mode: "rpc", uiContext: { notify: () => {} } });
    return {
      host: "pi",
      session,
      sessionManager,
      tool: (name) => session.agent.state.tools.find((t: any) => t.name === name),
      periodicCompaction: async () => {
        try {
          await session.compact();
        } catch {
          // "Nothing to compact": too little since the last one.
        }
      },
      close: async () => {
        await session.dispose?.();
        restore();
      },
    };
  } catch (e) {
    restore();
    throw e;
  }
};

/** Text of a message's content. */
export const textOf = (m: any): string =>
  typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => (p?.type === "text" ? p.text : "")).join("\n") : "";

/** What a benchmark session cost and how it made room, read off its branch. */
export interface RunStats {
  /** Model requests, and their prompt tokens (input and cache reads, as the benchmarks have always counted them; cache writes are not in it). */
  requests: number;
  promptTokens: number;
  /** The share of all prompt tokens (input, cache reads, cache writes) the provider read from its cache. */
  cacheShare: number;
  /**
   * The prompt tokens the provider read uncached (input and cache writes): what
   * each edit of the context costs, since the provider reads everything after
   * it again (the cost Context Language Models counts as prefix-reuse FLOPs).
   */
  uncachedTokens: number;
  /** omp-vcc's evict entries on the branch (one per run of turns taken out, restores not counted), by who made them (the agent with vcc_context, the user, omp-vcc as the context filled). */
  evictions: { agent: number; user: number; auto: number };
}

export const runStats = (branch: any[]): RunStats => {
  const usages = branch.filter((e: any) => e.type === "message" && e.message?.role === "assistant" && e.message.usage).map((e: any) => e.message.usage);
  const sum = (key: string) => usages.reduce((n: number, u: any) => n + (u[key] ?? 0), 0);
  const all = sum("input") + sum("cacheRead") + sum("cacheWrite");
  const evictions = { agent: 0, user: 0, auto: 0 };
  for (const e of branch) {
    if (e.type === "custom" && e.customType === "omp-vcc.evict" && e.data?.op === "evict" && e.data.by in evictions) evictions[e.data.by as keyof typeof evictions]++;
  }
  return { requests: usages.length, promptTokens: sum("input") + sum("cacheRead"), cacheShare: all ? sum("cacheRead") / all : 0, uncachedTokens: sum("input") + sum("cacheWrite"), evictions };
};

/** The stats as the benchmarks print them. */
export const statsLine = (s: RunStats): string =>
  `${s.requests} requests, ${Math.round(s.promptTokens / 1000)}K prompt tokens, ${Math.round(s.cacheShare * 100)}% read from cache (${Math.round(s.uncachedTokens / 1000)}K uncached), evictions by the agent/user/omp-vcc ${s.evictions.agent}/${s.evictions.user}/${s.evictions.auto}`;
