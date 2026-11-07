import { describe, it, expect } from "bun:test";
import type { NormalizedBlock } from "../src/types";
import { summarize, UNCAPPED } from "./support/summary";

/** Each configured command's invocations, as the summary of these blocks stores them. */
const extractTrackedCommands = (blocks: NormalizedBlock[], track: string[]) => {
  const { tracked } = summarize(blocks, { limits: UNCAPPED, trackCommands: track }).state;
  return { byCommand: new Map(track.map((name) => [name, new Set(tracked.find((t) => t.name === name)?.entries ?? [])])) };
};

const bash = (command: string): NormalizedBlock => ({
  kind: "tool_call",
  name: "bash",
  args: { command },
});

const TRACK = ["ssh", "kubectl", "docker", "aws"];

/** The [Tracked Commands] lines a summary of these blocks shows. */
const trackedLines = (blocks: NormalizedBlock[], track: string[]): string[] => {
  const { text } = summarize(blocks, { trackCommands: track });
  const head = text.split("\n\n---\n\n")[0];
  const at = head.indexOf("[Tracked Commands]\n");
  if (at < 0) return [];
  // Wrapped lines rejoined.
  return head.slice(at).split("\n\n")[0].replace(/\n[ \t]+(?=\S)/g, " ").split("\n").slice(1).map((l) => l.slice(2));
};

describe("extractTrackedCommands", () => {
  it("returns empty when trackCommands is empty (feature off)", () => {
    const act = extractTrackedCommands([bash("ssh example-host")], []);
    expect(act.byCommand.size).toBe(0);
  });

  it("captures a shallow one-liner per invocation, not a parsed structure", () => {
    const act = extractTrackedCommands([bash("kubectl get pods -n production")], TRACK);
    expect([...act.byCommand.get("kubectl")!]).toEqual(["kubectl get pods -n production"]);
  });

  it("only tracks command names explicitly configured", () => {
    const act = extractTrackedCommands([bash("kubectl get pods")], ["ssh"]);
    expect(act.byCommand.get("ssh")!.size).toBe(0);
    expect(act.byCommand.has("kubectl")).toBe(false);
  });

  it("cuts at the next real shell separator: semicolon, ampersand, pipe, and NEWLINE", () => {
    const act = extractTrackedCommands(
      [
        bash("docker restart web; echo done"),
        bash("docker restart api && echo ok"),
        bash("docker logs app | grep error"),
        bash("cd /app\ndocker ps\nkubectl get pods"),
      ],
      TRACK,
    );
    const docker = [...act.byCommand.get("docker")!];
    expect(docker).toContain("docker restart web");
    expect(docker).toContain("docker restart api");
    expect(docker).toContain("docker logs app");
    expect(docker).toContain("docker ps");
    expect([...act.byCommand.get("kubectl")!]).toContain("kubectl get pods");
    // None of the captured entries carry the separator itself.
    for (const entry of docker) expect(entry).not.toMatch(/[;&|]$/);
  });

  it("multiline bash blocks are fully scanned, not just the first line", () => {
    const act = extractTrackedCommands(
      [bash("cd /app\nssh prod-server 'docker restart web'\nkubectl get pods -n prod")],
      TRACK,
    );
    expect([...act.byCommand.get("ssh")!].length).toBeGreaterThan(0);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
    expect([...act.byCommand.get("kubectl")!]).toContain("kubectl get pods -n prod");
  });

  it("does not mistake ssh-keygen/docker-compose for real ssh/docker invocations", () => {
    const act = extractTrackedCommands(
      [bash("ssh-keygen -t ed25519 -f mykey"), bash("docker-compose up -d")],
      TRACK,
    );
    expect(act.byCommand.get("ssh")!.size).toBe(0);
    expect(act.byCommand.get("docker")!.size).toBe(0);
  });

  it("does not mistake quoted prose containing a tracked name for a real invocation", () => {
    const act = extractTrackedCommands([bash('echo "docker restart is flaky"')], TRACK);
    expect(act.byCommand.get("docker")!.size).toBe(0);
  });

  it("keeps full strings in the ledger (dedup sees untruncated), truncates only at render", () => {
    const longArgs = "x".repeat(200);
    const act = extractTrackedCommands([bash(`aws ec2 ${longArgs}`)], TRACK);
    const stored = [...act.byCommand.get("aws")!][0];
    expect(stored.length).toBeGreaterThan(200); // full fidelity for dedup
    const rendered = trackedLines([bash(`aws ec2 ${longArgs}`)], TRACK)[0];
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThanOrEqual(5 + 80 + 1); // "aws: " + entry + "…"
  });

  it("scans inside a QUOTED ssh remote-command string for other tracked names", () => {
    const act = extractTrackedCommands([bash('ssh prod-server "docker restart web"')], TRACK);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
  });

  it("scans inside an UNQUOTED ssh remote-command string for other tracked names", () => {
    const act = extractTrackedCommands([bash("ssh prod-server docker restart web")], TRACK);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
  });

  it("boolean ssh flags (-T, -v, -N, -f) consume no value — host and remote command still found", () => {
    for (const flag of ["-T", "-v", "-N", "-f", "-tt", "-vv", "-NT"]) {
      const act = extractTrackedCommands([bash(`ssh ${flag} prod-server docker restart web`)], TRACK);
      expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
    }
  });

  it("locates the ssh target by token position, not substring match (key-prod must not be mistaken for prod)", () => {
    const act = extractTrackedCommands([bash("ssh -i key-prod prod docker restart web")], TRACK);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
  });

  it("wrapper prefixes (sudo/env/nohup/time/command) don't hide the real command", () => {
    const act = extractTrackedCommands(
      [bash("sudo docker restart web"), bash("nohup kubectl apply -f x.yaml &"), bash("env -i docker ps"), bash("sudo -u root kubectl get pods")],
      TRACK,
    );
    // entries keep their prefixes — the ledger records what actually ran
    expect([...act.byCommand.get("docker")!]).toContain("sudo docker restart web");
    expect([...act.byCommand.get("docker")!]).toContain("env -i docker ps");
    expect([...act.byCommand.get("kubectl")!]).toContain("nohup kubectl apply -f x.yaml");
    expect([...act.byCommand.get("kubectl")!]).toContain("sudo -u root kubectl get pods");
  });

  it("VAR=val prefixes don't hide the command and stay in the entry (fidelity)", () => {
    const act = extractTrackedCommands([bash("KUBECONFIG=/tmp/k kubectl get pods")], TRACK);
    const entries = [...act.byCommand.get("kubectl")!];
    expect(entries).toEqual(["KUBECONFIG=/tmp/k kubectl get pods"]);
  });

  it("re-running a command moves it to the tail (most-recently-used)", () => {
    const cmds = [...Array.from({ length: 11 }, (_, i) => bash(`ssh host${i}`)), bash("ssh host0")];
    const [line] = trackedLines(cmds, ["ssh"]);
    expect(line).toContain("ssh host0"); // refreshed — survives the tail cap
    expect(line).not.toContain("ssh host1 |"); // oldest dropped instead
  });

  it("ignores non-bash tool calls entirely", () => {
    const act = extractTrackedCommands([{ kind: "tool_call", name: "read", args: { path: "a.ts" } }], TRACK);
    expect(act.byCommand.get("ssh")!.size).toBe(0);
  });

  it("reads commands the user ran with !cmd and Pi's powershell tool too", () => {
    const act = extractTrackedCommands([
      { kind: "bash", command: "docker compose up -d", output: "", exitCode: 0 },
      { kind: "tool_call", name: "powershell", args: { command: "kubectl get pods" } },
      { kind: "bash", command: "docker ps", output: "", exitCode: 0, lang: "python" },
    ], TRACK);
    expect([...act.byCommand.get("docker")!]).toEqual(["docker compose up -d"]);
    expect([...act.byCommand.get("kubectl")!]).toEqual(["kubectl get pods"]);
  });

  it("separators inside quotes are not boundaries — either direction", () => {
    // quoted prose must not false-positive…
    const prose = extractTrackedCommands([bash('echo "a; docker restart"')], TRACK);
    expect(prose.byCommand.get("docker")!.size).toBe(0);
    // …and a real command's entry must not split mid-quote
    const piped = extractTrackedCommands([bash(`ssh dulov 'echo "hunter2" | sudo -S apt update'`)], TRACK);
    const entries = [...piped.byCommand.get("ssh")!];
    expect(entries.some((e) => e.includes("hunter2") && e.includes("sudo -S apt update"))).toBe(true);
  });

  it("a lone VAR=x line is not an invocation of the command on the next line", () => {
    const act = extractTrackedCommands([bash("COOKIE=/tmp/c\ncurl -s https://x")], ["curl"]);
    expect([...act.byCommand.get("curl")!]).toEqual(["curl -s https://x"]);
  });

  it("an escaped quote outside quotes does not open a quote", () => {
    const act = extractTrackedCommands([bash("echo it\\'s; docker ps; echo done")], TRACK);
    expect([...act.byCommand.get("docker")!]).toEqual(["docker ps"]);
  });

  it("redirection ampersands are not separators; && and & still are", () => {
    const act = extractTrackedCommands(
      [bash("bun test 2>&1 | tail -5"), bash("curl -s https://x &>/dev/null && bun run build"), bash("bun dev & sleep 1")],
      ["bun", "curl"],
    );
    expect([...act.byCommand.get("bun")!]).toEqual(["bun test 2>&1", "bun run build", "bun dev"]);
    expect([...act.byCommand.get("curl")!]).toEqual(["curl -s https://x &>/dev/null"]);
  });

  it("an apostrophe in a shell comment does not hide the next line", () => {
    const act = extractTrackedCommands([bash("# don't fail\nbun test"), bash("# docker ps later\nls")], ["bun", "docker"]);
    expect([...act.byCommand.get("bun")!]).toEqual(["bun test"]);
    expect(act.byCommand.get("docker")!.size).toBe(0); // commented-out command is not a run
  });

  it("ssh -q is a boolean flag", () => {
    const act = extractTrackedCommands([bash("ssh -q host docker ps")], TRACK);
    expect([...act.byCommand.get("docker")!]).toEqual(["docker ps"]);
  });

  it("keeps quotes as written (no stray quote stripped off the end)", () => {
    const act = extractTrackedCommands([bash("cd db && psql -c 'select 1'"), bash(`ssh prod "docker ps"`)], ["psql", "ssh"]);
    expect([...act.byCommand.get("psql")!]).toEqual(["psql -c 'select 1'"]);
    expect([...act.byCommand.get("ssh")!]).toEqual(['ssh prod "docker ps"']);
  });
});

describe("[Tracked Commands] lines", () => {
  it("formats one line per command name that had a match, in insertion order", () => {
    expect(trackedLines([bash("ssh prod-server"), bash("docker ps")], ["ssh", "docker"])).toEqual(["ssh: ssh prod-server", "docker: docker ps"]);
  });

  it("omits command names with zero matches", () => {
    expect(trackedLines([bash("ssh prod-server")], ["ssh", "docker"])).toEqual(["ssh: ssh prod-server"]);
  });

  it("caps entries per command at 10 keeping the NEWEST (recency ledger)", () => {
    const cmds = Array.from({ length: 12 }, (_, i) => bash(`ssh host${i}`));
    const [line] = trackedLines(cmds, ["ssh"]);
    expect(line).toContain("(+2 earlier)");
    expect(line).toContain("ssh host11"); // newest kept
    expect(line).not.toContain("ssh host0 "); // oldest overflowed
  });

  it("a quoted multi-line argument renders on one line", () => {
    expect(trackedLines([bash("python3 -c 'import os\nprint(1)'")], ["python3"])).toEqual(["python3: python3 -c 'import os print(1)'"]);
  });
});
