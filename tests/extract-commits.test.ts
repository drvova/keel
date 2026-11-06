import { describe, it, expect } from "bun:test";
import { extractCommits } from "../src/extract/commits";
import type { NormalizedBlock } from "../src/types";

let calls = 0;
/** A bash call and its result, paired by id as the session pairs them. */
const ran = (command: string, text: string, failed = false): NormalizedBlock[] => {
  const id = `call-${++calls}`;
  return [
    { kind: "tool_call", id, name: "bash", args: { command }, ...(failed ? { failed: true as const } : {}) },
    { kind: "tool_result", callId: id, name: "bash", text },
  ];
};

const commitBlocks = (command: string): NormalizedBlock[] => ran(command, "[master 5416801] commit");

describe("extractCommits", () => {
  it("extracts double-quoted -m subject", () => {
    const blocks = commitBlocks('git commit -m "fix: handle empty config"');
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "fix: handle empty config" }]);
  });

  it("extracts single-quoted -m subject", () => {
    const blocks = commitBlocks("git commit -m 'fix: handle empty config'");
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "fix: handle empty config" }]);
  });

  it("extracts first line of $'...' -m subject", () => {
    const blocks = commitBlocks("git commit -m $'fix: handle empty config\\n\\nbody'");
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "fix: handle empty config" }]);
  });

  it("skips git commit without -m", () => {
    expect(extractCommits(commitBlocks("git commit --allow-empty"))).toEqual([]);
  });

  it("extracts heredoc subject with single-quoted delimiter", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<'EOF'\nfeat: add retry to upload client\n\nbody\nEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("extracts heredoc subject with double-quoted delimiter", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<"EOF"\nfeat: add retry to upload client\nEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("extracts heredoc subject with unquoted non-EOF delimiter", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<MSG\nfeat: add retry to upload client\nMSG\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("extracts heredoc subject with <<- and tab-indented lines", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<-EOF\n\tfeat: add retry to upload client\n\tEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("allows a space between << and the delimiter", () => {
    const blocks = commitBlocks(`git commit -m "$(cat << 'EOF'\nfeat: add retry to upload client\nEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("skips leading blank lines in heredoc body", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<'EOF'\n\n\nfeat: add retry to upload client\nEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("skips heredoc with empty body", () => {
    expect(extractCommits(commitBlocks(`git commit -m "$(cat <<'EOF'\n\nEOF\n)"`))).toEqual([]);
  });

  it("skips heredoc with empty body and double-quoted delimiter", () => {
    expect(extractCommits(commitBlocks(`git commit -m "$(cat <<"EOF"\n\nEOF\n)"`))).toEqual([]);
  });

  it("treats delimiter with trailing spaces as end of body", () => {
    expect(extractCommits(commitBlocks(`git commit -m "$(cat <<'EOF'\n\nEOF   \n)"`))).toEqual([]);
  });

  it("unescapes \\\" in heredoc subject", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<'EOF'\\nfix: handle \\"quoted\\" args\\nEOF\\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: 'fix: handle "quoted" args' }]);
  });

  it("keeps plain quotes in heredoc subject", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<'EOF'\nfix: handle "quoted" args\nEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: 'fix: handle "quoted" args' }]);
  });

  it("extracts heredoc subject from escaped newlines", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<'EOF'\\nfeat: add retry to upload client\\n\\nEOF\\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("skips empty heredoc with escaped newlines", () => {
    expect(extractCommits(commitBlocks(`git commit -m "$(cat <<'EOF'\\n\\nEOF\\n)"`))).toEqual([]);
  });

  it("uses the first -m when heredoc is only in a later -m", () => {
    const blocks = commitBlocks(`git commit -m "fix: handle empty config" -m "$(cat <<'EOF'\nbody\nEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "fix: handle empty config" }]);
  });

  it("extracts every commit in an && chain and hashes only the one the output names", () => {
    const blocks = ran(
      `git add a && git commit -m "docs: explain git commit -m" && git add b && git commit -m "$(cat <<'EOF'\nfeat: add retry to upload client\nEOF\n)"`,
      "[master 5416801] docs: explain git commit -m\n 1 file changed\n[master 77aa001] unrelated",
    );
    expect(extractCommits(blocks)).toEqual([
      { hash: "5416801", message: "docs: explain git commit -m" },
      { hash: undefined, message: "feat: add retry to upload client" },
    ]);
  });

  it("hashes quiet commits in a chain from `git log --oneline` lines naming them", () => {
    const blocks = ran(
      'git commit -q -m "fix: one" && git commit -q -m "fix: two" && git log --oneline -2',
      "bbb2222 (HEAD -> master) fix: two\naaa1111 fix: one",
    );
    expect(extractCommits(blocks)).toEqual([
      { hash: "aaa1111", message: "fix: one" },
      { hash: "bbb2222", message: "fix: two" },
    ]);
  });

  it("does not take a later commit's heredoc subject for an unparsable first commit", () => {
    const blocks = commitBlocks(
      `git commit --author="A <a@b>" -m "$(cat <<'EOF'\nfeat: one\nEOF\n)" && git commit -m "$(cat <<'EOF'\nfeat: two\nEOF\n)"`,
    );
    expect(extractCommits(blocks)).toEqual([{ hash: undefined, message: "feat: two" }]);
  });

  it("extracts heredoc subject with --amend", () => {
    const blocks = commitBlocks(`git commit --amend -m "$(cat <<'EOF'\nfeat: add retry to upload client\nEOF\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("extracts heredoc subject with CRLF line endings", () => {
    const blocks = commitBlocks(`git commit -m "$(cat <<'EOF'\r\nfeat: add retry to upload client\r\n\r\nEOF\r\n)"`);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: add retry to upload client" }]);
  });

  it("skips empty heredoc with CRLF line endings", () => {
    expect(extractCommits(commitBlocks(`git commit -m "$(cat <<'EOF'\r\n\r\nEOF\r\n)"`))).toEqual([]);
  });

  // `-q` makes git print no hash, so these commits are hashless.
  const quietBlocks = (command: string): NormalizedBlock[] => ran(command, "");

  it("extracts the subject from combined short flags ending in m", () => {
    expect(extractCommits(quietBlocks('git commit -qam "chore: release v0.11.0"'))).toEqual([
      { hash: undefined, message: "chore: release v0.11.0" },
    ]);
  });

  it("extracts the heredoc subject after combined short flags", () => {
    const cmd = `git commit -qam "$(cat <<'EOF'\nfeat: add retry to upload client\nEOF\n)"`;
    expect(extractCommits(quietBlocks(cmd))).toEqual([{ hash: undefined, message: "feat: add retry to upload client" }]);
  });

  it("extracts the subject of a message piped to `-F -` through a heredoc", () => {
    const cmd = `git commit -q -F - <<'EOF'\nfeat: add retry to upload client\n\nbody\nEOF`;
    expect(extractCommits(quietBlocks(cmd))).toEqual([{ hash: undefined, message: "feat: add retry to upload client" }]);
  });

  it("keeps one entry per commit, preferring the hashed one in either order", () => {
    const hashless = quietBlocks('git commit -q -m "fix: handle empty config"');
    const hashed = commitBlocks('git commit -m "fix: handle empty config"');
    const want = [{ hash: "5416801", message: "fix: handle empty config" }];
    expect(extractCommits([...hashless, ...hashed])).toEqual(want);
    expect(extractCommits([...hashed, ...hashless])).toEqual(want);
    // Two commits that share a message but have different hashes stay two.
    const other = ran('git commit -m "fix: handle empty config"', "[master 9999999] commit");
    expect(extractCommits([...hashed, ...other]).map((x) => x.hash)).toEqual(["5416801", "9999999"]);
  });
});

// Seen with a real model on omp: output that only looks like a hash, a commit in a
// command that failed before reaching it, and an amend.
describe("extractCommits: only git's own output names a hash", () => {
  const call = ran;

  it("a number printed on its own line is not the hash; the --oneline line naming the subject is", () => {
    const blocks = call(
      "python3 t.py && python3 -c 'import random; print(random.randint(1000000, 9999999))' && git add . && git commit -q -m 'feat: parse_amount' && git log --oneline -1",
      "5 tests passed\n4519687\n2b171a6 feat: parse_amount\n",
    );
    expect(extractCommits(blocks)).toEqual([{ hash: "2b171a6", message: "feat: parse_amount" }]);
  });

  it("hex inside a path is not a hash", () => {
    const blocks = call(
      "git commit -q -m 'feat: x'",
      'File "/tmp/claude-0/proj-915ea5c4-653e/tests/t.py", line 7',
    );
    expect(extractCommits(blocks)).toEqual([{ hash: undefined, message: "feat: x" }]);
  });

  it("a lone hash line (git rev-parse --short HEAD) still counts", () => {
    expect(extractCommits(call("git commit -q -m 'feat: x' && git rev-parse --short HEAD", "a1b2c3d\n"))).toEqual([
      { hash: "a1b2c3d", message: "feat: x" },
    ]);
  });

  it("a command that failed before its commit made no commit", () => {
    const blocks = call(
      "python3 t.py && git commit -q -m 'feat: parse_amount' && git log --oneline -1",
      "Traceback (most recent call last):\nImportError: cannot import name 'parse_amount'",
      true,
    );
    expect(extractCommits(blocks)).toEqual([]);
  });

  it("a failed command whose commit git reported still counts (the push after it failed)", () => {
    const blocks = call("git commit -m 'feat: x' && git push", "[master 5416801] feat: x\n 1 file changed\nerror: failed to push", true);
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: x" }]);
  });

  it("git commit's root-commit line gives the hash", () => {
    expect(extractCommits(call("git commit -m 'feat: first'", "[master (root-commit) f632bd6] feat: first\n"))).toEqual([
      { hash: "f632bd6", message: "feat: first" },
    ]);
  });

  it("--amend --no-edit moves the commit to the hash git shows for it", () => {
    const blocks = [
      ...call("git commit -m 'feat: round_cents'", "[master (root-commit) f632bd6] feat: round_cents\n"),
      ...call("git commit --amend --no-edit -q && git show --stat --oneline HEAD", "ee298c1 feat: round_cents\n .gitignore | 1 +\n"),
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: "ee298c1", message: "feat: round_cents" }]);
  });

  it("a quiet --amend --no-edit drops the stale hash", () => {
    const blocks = [
      ...call("git commit -m 'feat: a'", "[master 5416801] feat: a\n"),
      ...call("git commit --amend --no-edit -q", ""),
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: undefined, message: "feat: a" }]);
  });

  it("--amend -m rewrites the last commit's subject and hash", () => {
    const blocks = [
      ...call("git commit -m 'feat: a'", "[master 5416801] feat: a\n"),
      ...call("git commit --amend -m 'feat: a, better'", "[master 77aa001] feat: a, better\n"),
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: "77aa001", message: "feat: a, better" }]);
  });
});

describe("extractCommits: the command and its output", () => {
  it("pairs a call with its own result, not the one next to it", () => {
    // Two calls in one assistant message, their results after both.
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", id: "a", name: "bash", args: { command: "git status" } },
      { kind: "tool_call", id: "b", name: "bash", args: { command: "git commit -m 'feat: x'" } },
      { kind: "tool_result", callId: "a", name: "bash", text: "nothing to commit? no: [master 1111111] something else" },
      { kind: "tool_result", callId: "b", name: "bash", text: "[master 5416801] feat: x" },
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "feat: x" }]);
  });

  it("reads a commit the user ran with !cmd, from its own output", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "git commit -m 'fix: by hand'", output: "[master 5416801] fix: by hand", exitCode: 0 },
      { kind: "bash", command: "git commit -m 'fix: refused'", output: "nothing to commit", exitCode: 1 },
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: "5416801", message: "fix: by hand" }]);
  });
});
