# omp-vcc

Context management for [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) and [Pi](https://github.com/earendil-works/pi) coding agents, without an LLM call. When the context fills, omp-vcc makes room in one of two ways, and nothing it removes is lost:

- **A summary**, built by extraction, not by a model: what the work is, where it stands, the files and commits, a pointer to every range it replaces, and the files the next step works from.
- **Turns out whole** (opt-in): old turns leave the request word for word, a one-line pointer stands in their place, and the agent can shape its own context, as [Context Language Models](https://arxiv.org/abs/2609.37725) does.

Either way the session file keeps everything, and the agent reads any of it back with `vcc_recall`, across the project's earlier sessions too. Pinned notes stay in view throughout.

A fork of [pi-vcc](https://github.com/sting8k/pi-vcc) by [@sting8k](https://github.com/sting8k), inspired by [VCC](https://github.com/lllyasviel/VCC) (View-oriented Conversation Compiler), with a native entry for each host (`index.ts` for omp, `pi.ts` for Pi) over one core in Common Lisp ([why](#the-core-common-lisp-on-sbcl)).

|  | The host's own summary | omp-vcc |
|---|---|---|
| **Method** | An LLM writes it | Extraction and formatting, no LLM |
| **Determinism** | Can vary and hallucinate | Same input, same output |
| **Latency** | An LLM call | 1 ms median, 11 ms p90 |
| **Cost** | The summarization call's tokens | None |
| **Size** | Varies | 97.6% smaller at the median, 89% at p10 |
| **After it** | Old messages gone | Every word searchable with `vcc_recall` |
| **Again and again** | Each rewrite can lose more | Sections merge from stored data and stay capped |

Size and latency were measured by pi-vcc over 1,884 real sessions, before `[Working Set]` (up to 3,800 tokens more); the pipeline is the same.

## Contents

- [Install](#install) · [Quick start](#quick-start) · [Commands and tools](#commands-and-tools)
- Making room: [the summary](#the-summary) · [turns out whole](#turns-out-whole)
- [Recall](#recall) · [Pinned notes](#pinned-notes) · [The window and the tokens](#the-window-and-the-tokens)
- [Config](#config) · [On omp, on Pi](#on-omp-on-pi) · [The core](#the-core-common-lisp-on-sbcl)
- [Benchmarks](#benchmarks) · [Research](#research) · [Coming from pi-vcc](#coming-from-pi-vcc)

## Install

```bash
omp install https://github.com/drvova/omp-vcc
```

```bash
pi install git:github.com/drvova/omp-vcc
```

It needs omp 18.14+ or Pi 1.0+, and [SBCL](https://www.sbcl.org/) (Steel Bank Common Lisp) on the `PATH` (or named by `SBCL`):

```bash
sudo apt install sbcl   # Debian, Ubuntu
```

```bash
brew install sbcl       # macOS
```

The first time it loads, omp-vcc builds its core with that SBCL: a few seconds, once per version, into `lisp/build/` (or `OMP_VCC_CORE_BUILD_DIR` when the install directory is read-only). Until the core is there, or without SBCL, omp-vcc steps aside, says why once, and the host compacts as it would without it.

## Quick start

Nothing needs configuring: once installed, omp-vcc writes every compaction the host runs (`/compact`, a full context, an overflow), and the agent has `vcc_recall` and `vcc_pin`.

To have old turns leave whole instead of being summarized, set `"evict": true` in `omp-vcc-config.json` (see [Config](#config)) and start a new session. The agent then also gets `vcc_context` and its context as an editable file.

## Commands and tools

On omp the commands start `/omp-vcc`, on Pi `/pi-vcc` (pi-vcc's names).

| Command | What it does |
|---|---|
| `/omp-vcc [keep:N] [prompt]` | Compact now, keeping the last `N` user turns (default 1, grown a little by `smartKeepTail`; `keep:0` compacts everything), then send `prompt` instead of resuming |
| `/omp-vcc-recall …` | Search the history, as `vcc_recall` does ([Recall](#recall)) |
| `/omp-vcc-pin [name:NAME] <note>` | Pin a note; with none, list them ([Pinned notes](#pinned-notes)) |
| `/omp-vcc-unpin <N or name>` | Unpin a note |
| `/omp-vcc-evict …` | Take old turns out whole, bring them back, undo, or list ([Turns out whole](#turns-out-whole)) |

| Tool (the agent's) | What it does |
|---|---|
| `vcc_recall` | Search and read the raw history by query, `#N`, range, file or session |
| `vcc_pin` | Pin, name, redefine or unpin a note |
| `vcc_context` | With `evict` on: list what is in context, take turns out or bring them back, undo |

In print mode (`omp -p "/omp-vcc"`, `pi --print "/pi-vcc"`) the commands report on stderr. On a short session `/omp-vcc` may answer "Nothing to compact yet": the host keeps a recent part (`compaction.keepRecentTokens`) before any extension runs.

## The summary

```
[Pinned Notes]
- [1] Never touch the legacy SSO flow, it is being removed (user, #3)

[Task State]
- Request (#14): Also update the session token refresh logic
- Since then: 4 tool calls, 1 failed; changed src/auth/session.ts.
- Last result (#16): bash "bun test tests/auth.test.ts"

[Early Session Requests]
- Fix the auth bug, users can't log in after password reset

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[History Index]
- #0–#16: 2 requests: "Fix the auth bug, users can't log in after password reset" · changed auth/session.ts · 1 failed call

[Working Set]
- #9 read "src/auth/session.ts", the latest version, edited after at #14:
    import { signToken } from "./tokens";
    …[86 more lines: vcc_recall expand:[9]]

---

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset... (#11)
* bash "bun test tests/auth.test.ts" [failed] (#12)
* edit "src/auth/session.ts" (#14)
```

Every `(#N)` is an entry `vcc_recall` reads back exactly. A section appears only when it has something to say.

| Section | What it holds |
|---|---|
| `[Pinned Notes]` | The notes pinned with `vcc_pin` or `/omp-vcc-pin`, verbatim (the newest 20) |
| `[Task State]` | Where the work stands: the latest request, the calls since and their failures, the files changed, the last result, and the failure no later run fixed. Built again each time |
| `[Early Session Requests]` | The session's first 3 user messages, as written |
| `[Files And Changes]` | Files modified, created and read |
| `[Commits]` | The last 8 commits made in the session |
| `[Tracked Commands]` | Recent runs of the commands in `trackCommands` (off by default) |
| `[User Messages]` | The 15 newest later user messages |
| `[History Index]` | One line per compacted range back to the session's start: requests, files, commits, failed calls (8 lines; older ranges merge) |
| `[Working Set]` | What the next step works from, brought back so the agent does not fetch it again: the latest version of each file being worked on, the output of the open failure, and recall's best hits for the latest request. Up to 3,800 tokens, never more than half of what the compaction removes |
| Brief transcript | The conversation's highest-signal lines in order, one line per tool call, `[failed]` marked |

The sizes are those of a ~128K–200K window; they follow the model's ([The window and the tokens](#the-window-and-the-tokens)). On the next compaction the sections merge with the stored state of the previous one, never rewritten from its text, so detail is not lost compaction after compaction; `[Working Set]` and `[Task State]` are chosen again. None of it depends on wording, so it works in every language.

## Turns out whole

Instead of a summary over the oldest part of the window, old turns leave the request whole. Nothing is summarized or rewritten; the session keeps every word. A turn is a request the user made and everything after it, so a call never leaves without its result; the running turn's older steps can leave too, its request and newest step never.

**You** take turns out with `/omp-vcc-evict` at any time, with eviction on or off:

| Argument | What leaves or comes back |
|---|---|
| *(none)* | The oldest half of the turns in context |
| `3` · `all` · `#12-#40` | The three oldest · every finished turn · the turns that range touches |
| `restore #12` · `restore all` | Back in context |
| `undo` | The last edit reversed, whole |
| `list` | What is in and what is out, by `#N` and size |

**With `"evict": true`**:

- **The agent** decides too, with `vcc_context`: no params lists; `drop`, `oldest`, `restore`, `undo`, a `note` kept in their place. A drop that would cost more than it saves is held back with the run that would pay, and `force: true` takes it out anyway.
- **omp-vcc** takes the oldest finished turns out by itself past 85% of the host's trigger, down to half of it, and turns the host's threshold and idle passes down while a finished turn is left to take out. An overflow recovery, `/compact` and `/omp-vcc` still summarize.
- **The context as a file**, the design of [Context Language Models](https://arxiv.org/abs/2609.37725): each request is mirrored beside the session (`<session>.jsonl.vcc-context.md`), one block per turn under a `[[CTX_TURN #12–#19]]` line, its path the first line of the context. The agent edits it with its own tools: delete a block and the turn leaves, rewrite it and what it wrote stands in its place, write between blocks and it stays as a note. The next request sends what the file says; the running turn is not in the file, so it holds still while the agent edits it.

What the request then carries, each part written to read the same on every request so the provider's prompt cache keeps it:

```text
[Your context is mirrored in …/session.jsonl.vcc-context.md, block by block as this request sends it. …]
[Pinned notes, as of #40 (vcc_pin; …):
- [3] auth-plan: refresh after reset; never touch SSO (user, #12)]
[#0–#20 out of context: 7 turns, by omp-vcc as the context filled. Requests: "fix the auth bug"; … It changed 5 files in auth, billing; 2 commits, last 3f2a1c9 fix refresh; 1 failed call. Each entry reads back word for word with vcc_recall expand:[0]; vcc_recall query searches them.]
[#21] add the refresh test
…
[context: ~41808 tokens, 50% of where the host compacts (~83616); ~41808 left]
```

- **The line for what is out** says what it was and did, from the originals omp-vcc kept, and how to read it back.
- **Turn numbers** (`[#21]`) let the agent name turns without listing them.
- **The pinned notes** stand first, brought up to date only when turns leave or come back: an edit at the start of a request makes the provider read all of it again (7.7 appended turns, by the paper's count).
- **The size readout** ends each of omp-vcc's tool results: models misjudge their own context's length (the paper's appendix G), and read a remaining budget better than a share ([Liu et al.](https://arxiv.org/abs/2511.17006)). Past half the trigger the model is also told once per tenth, while something can leave.

Every edit is an `omp-vcc.evict` entry, replayed along the branch, so a branch keeps its own and `/tree` back past one undoes it. Turns leave in large runs from the oldest end, since every edit makes the provider read all that follows it again. Whether a drop pays is worked out from the session itself: the cache's price from each request's usage and cost, over as many requests ahead as the session has made.

## Recall

`vcc_recall` reads the raw session file, so anything compacted or evicted stays reachable: the active branch by default, `scope:"all"` for edited and retried branches too, `scope:"project"` for the project's earlier sessions (restarts, `/new`, forks, omp's handoffs).

```
vcc_recall({ query: "auth token" })                    // ranked search: rare words weigh more, other forms of a word match
vcc_recall({ query: "hook|inject" })                   // a regex (as text when it matches nothing)
vcc_recall({ expand: [1253] })                         // an entry in full: the (#1253) of a summary
vcc_recall({ range: [1250, 1290] })                    // entries in order
vcc_recall({ mode: "touched" })                        // files worked on, with #N
vcc_recall({ query: "#1253:auth.ts" })                 // a file's content at #1253
vcc_recall({ mode: "sessions" })                       // the project's sessions, with their pinned notes
vcc_recall({ query: "auth token", scope: "project" })  // search them too
vcc_recall({ session: "01a194d8", expand: [12] })      // inside another session (its own #N)
```

Results come 5 a page (`page`). One result is capped at 50 KB, or a tenth of the model's window when that is smaller. The tool repairs the loose forms agents send (`"#12"`, `"10-20"`), and names a param it cannot use instead of dropping it. `/omp-vcc-recall auth token scope:all` runs the same search for you.

## Pinned notes

What must survive everything: a decision and its reason, a constraint, the command the task runs. Pinned notes are kept verbatim at the top of every summary, and first in the request with eviction on.

- **Named notes:** `vcc_pin {note, name: "auth-plan"}` (or `/omp-vcc-pin name:auth-plan …`). Pinning the name again replaces its note, so a plan stays current under one name.
- **Yours stay yours:** the agent cannot redefine or unpin a note you pinned; it is told to ask you.
- **Into the next session:** your named notes carry into the project's next session (a restart, `/new`). The agent's do not: a note it pinned may hold what a page told it, and an instruction carried into every later session is how an injection persists (the paper's section 6). It finds them with `vcc_recall` sessions and pins again what still holds.

## The window and the tokens

Every size follows the model's real window, learned from what the provider proves rather than trusted from a catalog. Catalogs disagree: one DeepSeek model is listed at 131K to 1.05M across providers, and one Claude model changed from 1M to 200K between two Pi releases.

- **The window** is the host's (on omp the provider's when its discovery is configured, else its catalog or `models.yml`; on Pi its catalog or `models.json`), lowered to a limit an overflow error stated ("maximum context length is 32768 tokens", in the shapes of OpenAI, Anthropic, Google, DeepSeek, OpenRouter, vLLM, LiteLLM, Together, Mistral, Kimi, Qwen and others). If the provider later accepts a prompt larger than that limit, the limit was wrong and is dropped.
- **Tokens** are counted at the model's own chars per token, measured on each request from two of the provider's counts (the messages added between them over the tokens they added). Code runs about 3.8 chars a token, English prose 5.4, Chinese and Japanese 1–2.
- **What it learns is kept** per model in `omp-vcc-models.json` beside the config, so the next session starts with it. omp-vcc makes no network call of its own.
- **The trigger** is where the host compacts, from the host's own settings for the model, applied as the host applies them (omp's threshold, reserve and per-model thresholds; Pi's `reserveTokens`).
- **The budgets** are shares of the trigger: the kept tail (25k), the summary and its sections, `[Working Set]` and recall's cap are their usual size on a ~128K window, smaller on a small one, larger on ~1M. Each compaction records what it sized from (`details.limits`).
- **A host window that is too high** (an overflow says less) never triggers the host, so omp-vcc compacts at the end of a run past the real window's trigger, and says so once.

## Config

`omp-vcc-config.json` in the host's agent directory (`~/.omp/agent` or the active profile's; `~/.pi/agent`; `$PI_CODING_AGENT_DIR`; `$OMP_VCC_CONFIG_PATH` overrides), created with these defaults. A pi-vcc config there is copied over.

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "debug": false,
  "skipForProviders": [],
  "skipCustomTypes": [],
  "trackCommands": [],
  "keepOriginals": true,
  "workingSet": true,
  "evict": false
}
```

| Key | Default | What it does |
|---|---|---|
| `overrideDefaultCompaction` | `true` | omp-vcc writes `/compact` and automatic compactions; `false`: only its own command |
| `smartKeepTail` | `true` | A `keep:1` tail under 5k tokens grows to the turns that fit in 25k (smaller on a small window); an explicit `keep:N` is kept |
| `debug` | `false` | Each compaction's details (counts, cut, sections, calibration) in `omp-vcc-debug.json` |
| `skipForProviders` | `[]` | Providers whose compactions the host keeps (case-insensitive provider ids) |
| `skipCustomTypes` | `[]` | `custom_message` types left out of the summary (other extensions' per-turn boilerplate) |
| `trackCommands` | `[]` | Commands remembered in `[Tracked Commands]`, by command or prefix (`"ssh"`, `"gh pr"`) |
| `keepOriginals` | `true` | omp only: keep the original of what omp rewrites in place, in `<session>.jsonl.vcc-raw` |
| `workingSet` | `true` | Bring back what the next step works from as `[Working Set]` |
| `evict` | `false` | Turns out whole as the context fills, `vcc_context`, and the context as a file (from the next session) |

## On omp, on Pi

<details>
<summary><b>On omp</b></summary>

- omp-vcc writes the compaction on `/compact`, a full context, an overflow, idle maintenance and a cut-off reply. Every omp method that writes a summary (server compaction, snapcompact, handoff, soft, notes-backed windows) asks omp-vcc first, and omp-vcc answers every pass, so none of them writes one. On an overflow inside a running turn it keeps the turn's newest steps and summarizes the rest; when nothing summarized could shrink the context, it says so.
- omp's shake works with it: on an overflow shake can run first and hand over to soft (omp-vcc), and after a compaction that still leaves too much, omp's rescue shakes the output it kept.
- A threshold or idle pass that would summarize away a running turn that fits the tail waits until the turn ends. omp resumes the run itself after automatic compactions, and skips its background compaction while omp-vcc is installed (omp-vcc takes milliseconds).
- omp rewrites messages in place between compactions (it shakes output into `artifact://` files and blanks old or superseded results). omp-vcc keeps every original as it lands (`keepOriginals`), so recall reads what was there, the summary is written from it, and omp's placeholder points at it: `[Output truncated - 1200 tokens] (the original: vcc_recall expand:[12])`.
- After `/clear`, the summary, the history index and the notes cover what follows it. A message the user sends mid-run (a steer, which omp marks) stays in the running turn.

</details>

<details>
<summary><b>On Pi</b></summary>

- omp-vcc writes the compaction on `/compact`, Pi's threshold and its overflow recovery; Pi asks it for every one, and resumes the run itself.
- Pi never rewrites the session file; what it changes in the context are `context_edit` entries (a failed attempt left out before a retry, a redacted result). The summary reads the branch through them as Pi does; recall reads the raw history.
- A `!cmd` is one line of the summary; a `!!cmd`, which Pi keeps out of the context, is left out of it too.
- When an overflow shows the real window is smaller than Pi's, omp-vcc compacts at its own trigger once the run settles, and says how to set the window in `models.json`.

</details>

## The core: Common Lisp on SBCL

Everything omp-vcc decides is decided in one core, `lisp/`, written in Common Lisp and compiled by [SBCL](https://www.sbcl.org/). The hosts load only JavaScript and TypeScript extensions, so `index.ts`, `pi.ts` and `src/` are thin bindings: they do what only the host can (its events, its session manager, its message conversion) and hand everything else to the core, one JSON request and one JSON answer.

**How it runs.** On first load omp-vcc compiles the sources into one executable (~40 MB, linking only libc and libm). Where the system has named pipes, one core process stays up beside the host and answers every request in about 0.4 ms, keeping the session files it read parsed and only reading the lines they gained; on Windows each request starts its own process (about 5 ms). A core that dies is replaced; one that cannot be built yet leaves the host to compact as it would without omp-vcc.

**Why Common Lisp and SBCL:**

- **One core for two hosts.** omp and Pi each get an entry written against their own API, but the summary, recall, eviction and window rules exist once, so the two hosts cannot drift apart.
- **Nothing to fetch.** The core depends on SBCL alone: its JSON, regex engine and test runner are its own. An install pulls no package from a registry, so there is no supply chain to trust beyond SBCL itself.
- **Native speed and a long-lived image.** SBCL compiles to machine code. A Lisp image is meant to stay up as one process holding its state, which is what lets the core keep sessions parsed between requests instead of re-reading them every time.
- **A system made of definitions.** A Lisp program is a set of named definitions in a running image, the shape of the design omp-vcc follows (the agent working on named entries of its context, with nodecode's Lisp image as the model).
- **Exactness where it matters.** The core keeps JavaScript's arithmetic (lengths in UTF-16 code units, doubles where JavaScript has them) and JavaScript's regex dialect, checked against JavaScript itself on 1,620 patterns, so every number it hands the TypeScript side means the same there. Session text is never given to the Lisp reader.

The cost: SBCL has to be installed. Contributor notes on the core, its ops and its tests are in [AGENTS.md](./AGENTS.md).

## Benchmarks

On a real model, DeepSeek V4.1 Flash in omp, with omp told a smaller window than the model's so the context fills (`scripts/benchmark-long-horizon.ts`, `scripts/benchmark-cybench.ts`; both also run in Pi with `--host=pi`). Single runs unless noted. The brief's own benchmarks against pi-vcc 0.3.18 are in [`benchmarks/README.md`](./benchmarks/README.md).

**[Cybench](https://arxiv.org/abs/2408.08926)**: all 17 file-only capture-the-flag tasks (binaries to reverse, a pcap, emails, crypto) in one session on a 64K window, each task's own questions with at most 15 requests each, and earlier answers asked again tasks later.

| | omp-vcc summary | without `[Working Set]` | omp's own (LLM) | omp-vcc, turns out whole |
|---|---|---|---|---|
| Answered right | 53/62 | 55/62 | 55/62 | 54/62 |
| Asked again, right | 27/27 | – | 28/28 | 28/28 |
| Tool calls to answer again | 39–41 | – | 8 | 56 |
| Compactions | 8 | – | – | 4 |

omp's own compaction, which writes its summary with the model, answered most re-asked questions from its context; omp-vcc looked more of them up again, at no summarization cost. On GLM 5.3 Flash: 51/62 with omp-vcc, 50 without `[Working Set]`, 50 with omp's own.

![Cybench, three compactors](./benchmarks/images/cybench-runs.png)

**Long horizon**: 7 facts planted in 60 or 120 coding turns (read, edit, test, commit). On a 128K window, turns out whole never compacted and still held all 7 facts word for word after 60 turns (4 after 120, where the summary held 1). On a 32K window one turn fills much of it, eviction often has nothing to take, and the summary carries the session.

**`[Working Set]`**: a five-step coding task on a 40K window, 4 runs a side: every run with it finished every step, one without did.

## Research

| Paper | What omp-vcc does with it |
|---|---|
| [Context Language Models](https://arxiv.org/abs/2609.37725), Shao et al., 2026 | The model edits its own context: `vcc_context` and the context as a file; one large edit from the oldest end; notes that stand first; the size readout |
| [Agentic Context Engineering](https://arxiv.org/abs/2510.04618), Zhang et al., 2025 | Rewriting a context erodes it: sections merge from stored data, never rewritten |
| [The Complexity Trap](https://arxiv.org/abs/2508.21433), Lindenbauer et al., 2025 | Masking is as effective as LLM summarization: compaction without an LLM call |
| [Towards Reliable Context Compression](https://arxiv.org/abs/2608.06503), Min et al., 2026 | Agents repeat steps after compaction: failed calls marked and ranked up, `[Task State]` |
| [What Does Context Compression Cost an Agent?](https://arxiv.org/abs/2608.16370), Liu et al., 2026 | State that lives only in the history is what hurts to lose: `[History Index]`, early requests |
| [MemGPT](https://arxiv.org/abs/2310.08560), Packer et al., 2023 | A core memory beside a searchable store: pinned notes and `vcc_recall` |
| [LongMemEval](https://arxiv.org/abs/2410.10813), Wu et al., 2024 | Memory works through pointers: `#N` refs, ranges, recall across sessions |
| [NoLiMa](https://arxiv.org/abs/2502.05167), Modarressi et al., 2025 | Retrieval fails on reworded queries: a search word matches its other forms |
| [Context Length Alone Hurts](https://arxiv.org/abs/2510.05381), Du et al., 2025 | Length alone costs accuracy: recall's cap and every limit follow the window |
| [Lost in the Middle](https://arxiv.org/abs/2307.03172), Liu et al., 2023 | The start of the context is read best: pinned notes first |
| [Masking Stale Observations](https://arxiv.org/abs/2606.00408), Zhang et al., 2026 | A masked result must stay reachable: omp's placeholders point at the kept original |
| [Beyond Compaction: Structured Context Eviction](https://arxiv.org/abs/2606.11213), Semenov et al., 2026 | Evicting what the agent needs makes it re-explore: `[Working Set]`, originals kept |
| [Context as an Environment](https://arxiv.org/abs/2608.21690), Lin et al., 2026 | Evicted spans recoverable by exact addresses: originals by `#N` |
| [TRACER](https://arxiv.org/abs/2608.29363), Lin et al., 2026 | Calls made again after compression are its cost: `[Working Set]` brings their results back |
| [Budget-Aware Tool-Use](https://arxiv.org/abs/2511.17006), Liu et al., 2025 | A remaining-budget signal: the readout's `~N left` |

Also read: [LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120), [Evaluating Goal Drift](https://arxiv.org/abs/2505.02709), [Generative Agents](https://arxiv.org/abs/2304.03442), [Recursively Summarizing](https://arxiv.org/abs/2308.15022), [Slipstream](https://arxiv.org/abs/2605.08580), and [nodecode](https://nodecode.ai/docs/context)'s context design.

## Coming from pi-vcc

- On Pi the commands keep their names (`/pi-vcc`, `/pi-vcc-recall`, `/pi-vcc-pin`, `/pi-vcc-unpin`, and the new `/pi-vcc-evict`); the tools keep theirs (`vcc_recall`, `vcc_pin`).
- Summaries pi-vcc stored (`compactor: "pi-vcc"`) are read as omp-vcc's: their history index carries on.
- The config moves to `omp-vcc-config.json` (copied from `pi-vcc-config.json` once); `continueAfterThresholdCompact` is gone, as both hosts resume the run on their own.

## Acknowledgments

- [pi-vcc](https://github.com/sting8k/pi-vcc) by [@sting8k](https://github.com/sting8k) and its contributors, which this is forked from.
- [VCC](https://github.com/lllyasviel/VCC), the original transcript-preserving conversation compiler.
- Recall's `mode:"touched"` and `#N:path` drill-down from [pi-blackhole](https://github.com/k0valik/pi-blackhole) by [@k0valik](https://github.com/k0valik), who also suggested them.

## License

MIT
