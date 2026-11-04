// An omp session on a real model with omp-vcc loaded, as a user runs it: the
// model is a provider in `models.yml` whose key omp reads from the environment,
// omp-vcc is loaded from this package, and every turn goes through omp's own
// agent loop, tools, context counting and compaction. Shared by the long-horizon
// and Cybench sessions (tests/support/long-horizon.ts, tests/support/cybench.ts).
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "../..");

/** The model the sessions run on: DeepSeek V4.1 Flash, on OpenScale's OpenAI-compatible API. */
export const LONG_HORIZON_MODEL = { baseUrl: "https://api.openscale.so/v1", model: "deepseek/deepseek-v4.1-flash", api: "openai-completions" };

/** The real model a session runs on; undefined without a key for it (OMP_VCC_LH_API_KEY). */
export const realModel = (): { baseUrl: string; model: string; api: string } | undefined => {
  if (!process.env.OMP_VCC_LH_API_KEY) return undefined;
  return {
    baseUrl: process.env.OMP_VCC_LH_BASE_URL || LONG_HORIZON_MODEL.baseUrl,
    model: process.env.OMP_VCC_LH_MODEL || LONG_HORIZON_MODEL.model,
    api: process.env.OMP_VCC_LH_API || LONG_HORIZON_MODEL.api,
  };
};

export interface OmpSessionOptions {
  /** A temp directory the session owns: omp's agent dir, its sessions and omp-vcc's config go here. */
  work: string;
  /** The project the agent works in (omp's cwd). */
  cwd: string;
  /** The window omp is told (default 128K): its trigger, and so omp-vcc's budgets, follow it. */
  contextWindow?: number;
  /** omp-vcc settings, over `overrideDefaultCompaction: true` (`{ overrideDefaultCompaction: false }`: omp's own compaction). */
  config?: Record<string, unknown>;
}

export interface OmpSession {
  session: any;
  sessionManager: any;
  /** Close the session and put back the env it changed. */
  close: () => Promise<void>;
}

export const openOmpSession = async (options: OmpSessionOptions): Promise<OmpSession> => {
  const provider = realModel();
  if (!provider) throw new Error("set OMP_VCC_LH_API_KEY to a key for DeepSeek V4.1 Flash on OpenScale (tests/support/omp-session.ts)");
  const saved = ["PI_CODING_AGENT_DIR", "OMP_VCC_CONFIG_PATH"].map((k) => [k, process.env[k]] as const);
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const agentDir = join(options.work, "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.OMP_VCC_CONFIG_PATH = join(options.work, "omp-vcc-config.json");
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, ...options.config }));
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
      session,
      sessionManager,
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
