# omp-vcc

Algorithmic conversation compactor for [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi). No LLM calls: it builds the summary by extraction and formatting, keeps the raw history searchable with `vcc_recall`, and keeps pinned notes at the top of every summary.

A fork of [pi-vcc](https://github.com/sting8k/pi-vcc) by [@sting8k](https://github.com/sting8k), made native to omp: it uses omp's extension API, types and session format directly and no longer runs on Pi. Inspired by [VCC](https://github.com/lllyasviel/VCC) (View-oriented Conversation Compiler).

## Why omp-vcc

|  | omp's summary | omp-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input, same output |
| **Size reduction** | Varies | 97.6% median, 89% at p10 |
| **Compaction latency** | Waits for an LLM call | 1 ms median, 11 ms p90, 348 ms worst |
| **Cost** | Burns tokens on the summarization call | None |
| **History after compaction** | Gone, the agent only sees the summary | Searchable with `vcc_recall`, across the project's sessions |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and stay capped |
| **Structure** | Free-form prose | Up to 7 sections + a brief transcript |

Size and latency were measured by pi-vcc over 1,884 real sessions (summary chars vs the summarized conversation); the summary pipeline is the same. How much of a session's facts survive is measured in [`benchmarks/README.md`](./benchmarks/README.md), and over a long task by `scripts/benchmark-long-horizon.ts`.

## Install

```bash
omp install npm:@drvova/omp-vcc
```

Or from GitHub:

```bash
omp install https://github.com/drvova/pi-vcc
```

omp-vcc needs omp 18.14 or later (`omp.extensions` in `package.json` points omp at `index.ts`).

## Usage

omp-vcc runs whenever omp compacts (`/compact`, a full context, an overflow, idle maintenance, a cut-off reply), or on demand:

- `/omp-vcc` compacts now, keeping the last user turn.
- `/omp-vcc keep:N [prompt]` keeps the last `N` user turns (`keep:0` compacts everything) and sends the optional prompt to the agent afterwards, instead of omp resuming the interrupted turn.
- `/omp-vcc-pin <note>` pins a note that stays at the top of every summary until `/omp-vcc-unpin <N>`; `/omp-vcc-pin` alone lists the notes. The agent pins its own with the `vcc_pin` tool (decisions, constraints, facts the task depends on).

With the default `keep:1`, a small tail is grown automatically (see `smartKeepTail`). To leave `/compact` and automatic compactions to omp, set `overrideDefaultCompaction: false`.

How it fits into omp:

- For `/compact` and automatic compactions, omp-vcc stands in for the summary method omp picks from `compaction.methodOrder` (remote, snapcompact, handoff or soft). `shake`, which only trims tool output, still runs when omp reaches it first. On an overflow omp-vcc cannot cut, it steps aside so omp's own method recovers.
- omp compacts between the tool calls of a turn. When that turn is all that is left in context and fits the tail budget, a threshold or idle pass waits until the turn ends instead of summarizing it away.
- omp resumes the interrupted run itself after automatic compactions (`compaction.autoContinue`); omp-vcc sends no continue of its own.
- While omp-vcc is installed, omp skips its background (speculative) compaction, as it does for any extension that handles compaction. omp-vcc's summary takes milliseconds, so there is no latency to hide.
- After `/clear`, the summary, the history index and the pinned notes cover only what follows it.
- omp's `shake` can move large tool output out of the session file into an `artifact://` file before omp-vcc runs. `vcc_recall` then shows that reference, which the agent opens with `read`.
- `vcc_recall` and `vcc_pin` are top-level tools with read-only approval: the summary tells the agent to call `vcc_recall` by name.

On a short session `/omp-vcc` can answer "Nothing to compact yet" whatever `keep:N` says: omp stops before any extension runs while the whole session still fits in the recent part it always keeps (`compaction.keepRecentTokens` in omp's settings).

### Compacted message structure

```
[Pinned Notes]
- [1] Never touch the legacy SSO flow, it is being removed (user, #3)

[Early Session Requests]
- Fix the auth bug, users can't log in after password reset
- It happens only after a password reset, not after a normal logout

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Tracked Commands]
- docker: docker compose restart api 2>&1

[User Messages]
- Always run tests before committing
- Also update the session token refresh logic

[History Index]
- #0–#16: 2 requests: "Fix the auth bug, users can't log in after password reset" · changed auth/session.ts · 1 failed call

---

...(28 earlier lines omitted)

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset... (#11)
* bash "bun test tests/auth.test.ts" [failed] (#12)
* edit "src/auth/session.ts" (#14)
* bash "docker compose restart api 2>&1" (#15)
* bash "bun test tests/auth.test.ts" (#16)

---

Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.
```

A section only appears when it has something to say; a session with no git commits has no `[Commits]`.

| Section | Contents |
|---|---|
| `[Pinned Notes]` | Notes pinned with `/omp-vcc-pin` or `vcc_pin`, verbatim, until unpinned (the newest 20 are shown) |
| `[Early Session Requests]` | The session's first 3 user messages, as written. Kept for the whole session; they can be stale later in a long session |
| `[Files And Changes]` | Files modified, created or read (capped, paths trimmed to a common root), including omp's hashline edits |
| `[Commits]` | Last 8 commits made in the session (hash + subject) |
| `[Tracked Commands]` | Recent runs of only the commands listed in `trackCommands` (off by default) |
| `[User Messages]` | The 15 newest later user messages, as written (one line each, up to 300 characters) |
| `[History Index]` | One line per compacted range of `#N` entries, back to the start of the session: how many requests, the longest one, the files or directories changed, commits and failed calls. At most 8 lines; older ranges merge into coarser ones |
| Brief transcript | The conversation in order, about 120 recent lines, each tool call shortened to one line with a `(#N)` ref, and `[failed]` when its result was an error. A user's `!cmd` or python cell is one `$ cmd` / `>>> code` line |

On the next compaction, the sections are merged with the previous summary and re-capped, and the transcript rolls forward. What leaves the other sections is still named in `[History Index]`, so on a long task the agent knows which range to read or what to search for. None of the sections depend on wording, so they work the same in every language. omp's host reminders (developer messages), `@file` bodies and text an extension sent on the agent's behalf are not read as the user's words.

## Recall

omp's own compaction drops old messages from the model's view. `vcc_recall` reads the raw session file instead, so anything compacted away stays reachable. It searches the active conversation lineage by default; `scope:"all"` also covers edited or retried branches, and `scope:"project"` this project's earlier sessions (restarts, `/new`, forks, handoffs).

Plain keywords work best. Multi-word queries are OR-matched and ranked, rare terms weigh more, and a regex is accepted (falling back to keywords if it matches nothing):

```
vcc_recall({ query: "auth token" })                  // ranked OR search
vcc_recall({ query: "auth token", page: 2 })         // 5 results per page
vcc_recall({ query: "hook|inject" })                 // regex
vcc_recall({ query: "auth token", scope: "all" })    // all lineages
```

The `#N` refs in a summary, such as `(#1253)`, are the same numbers recall uses, so the agent can go straight to them:

```
vcc_recall({ range: [1250, 1290] })                  // entries in order, 20 per page
vcc_recall({ expand: [1253] })                       // full text
vcc_recall({ mode: "touched" })                      // files worked on, with #N
vcc_recall({ query: "#1253:auth.ts" })               // a file's content from #1253
```

Earlier sessions of the same project (the session files in the same directory) are reachable too:

```
vcc_recall({ mode: "sessions" })                     // list them, newest first, with their pinned notes
vcc_recall({ query: "auth token", scope: "project" }) // search them and this one; hits name their session
vcc_recall({ session: "01a194d8", expand: [12] })    // read one: any call works inside it
```

`scope:"project"` searches the 20 newest earlier sessions (up to 24 MB); `session:` reaches any of them. Each session's `#N` are its own.

Each call does one of these. `page` and `scope` work with all of them, and a param the call cannot use is named in the output instead of dropped silently. omp validates arguments before an extension sees them, so the schema also accepts the loose forms agents send (`"#12"`, `"10-20"`, a scope value in `mode`), and the tool repairs them. One result is capped at 50 KB, or a tenth of the model's context window when that is smaller (at least 8 KB); a clipped one starts with a warning. A search word also matches other forms of it (`rounding` finds `rounds`, `failure` finds `FAIL`).

The same search as a slash command, with results shown in the chat and passed to the agent:

```
/omp-vcc-recall auth token scope:all
/omp-vcc-recall sessions
/omp-vcc-recall auth token session:01a194d8
```

## How it works

1. Pick the cut: everything before the kept tail is summarized, the tail stays as is.
2. Convert each message with omp's own `convertToLlm`, normalize it into uniform blocks and drop noise.
3. Extract the sections and the brief transcript, and format them.
4. If there is a previous summary, merge into it; the history index is carried in the compaction's details.

No step calls a model, and token counts are estimated from the session's own numbers. The extension imports no package at runtime: it gets omp's functions from the extension API.

## Config

Config lives at `omp-vcc-config.json` in omp's agent directory (`~/.omp/agent`, the active profile's, or `$PI_CODING_AGENT_DIR` if set; `$OMP_VCC_CONFIG_PATH` overrides the path) and is created with these defaults on first load. A `pi-vcc-config.json` already in that directory, from pi-vcc on omp, is copied over instead.

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "debug": false,
  "skipForProviders": [],
  "skipCustomTypes": [],
  "trackCommands": []
}
```

- **`overrideDefaultCompaction`** *(default `true`)*: omp-vcc handles `/omp-vcc`, `/compact` and automatic compactions. With `false` it only handles `/omp-vcc`. Existing config files keep their value.
- **`smartKeepTail`** *(default `true`)*: if the `keep:1` tail is under 5k tokens, keep as many turns as fit in 25k. This is omp-vcc's own limit; omp's `compaction.keepRecentTokens` does not change it. An explicit `keep:N` is always respected.
- **`debug`** *(default `false`)*: write details of each compaction (message counts, cut, sections, token calibration) to `/tmp/omp-vcc-debug.json`.
- **`skipForProviders`** *(default `[]`)*: providers for which omp-vcc steps aside, so omp's own method (or another compaction extension) handles them. Compared case-insensitively with omp's provider id (see `/model`). Checked on every compaction; `/omp-vcc` always runs.
- **`skipCustomTypes`** *(default `[]`)*: `customType` values of `custom_message` entries to leave out of the summary, for per-turn boilerplate other extensions inject (skill cards, guidance blocks). Exact, case-sensitive match; look for `"type":"custom_message"` in your session file to find the value. Only the summary input changes, not the cut.
- **`trackCommands`** *(default `[]`)*: commands to remember across compactions, listed in a `[Tracked Commands]` section. Any command or prefix works: `["ssh", "kubectl", "docker"]`, `["psql", "./deploy.sh"]`, or `"gh pr"` (matches `gh pr merge`, not `gh run`). Each entry is the command as written, up to the next shell separator outside quotes, with any `sudo`/`env`/`VAR=` prefix kept; the 10 most recent per command are kept. Only `bash` calls are read, and only `ssh` remote commands are looked into, not `sh -c` or `docker exec`. Empty = off.

## Coming from pi-vcc

- Commands are renamed: `/pi-vcc` → `/omp-vcc`, `/pi-vcc-recall` → `/omp-vcc-recall`, `/pi-vcc-pin` / `/pi-vcc-unpin` → `/omp-vcc-pin` / `/omp-vcc-unpin`. The tools keep their names (`vcc_recall`, `vcc_pin`).
- Summaries pi-vcc stored in a session (`compactor: "pi-vcc"`) are still read as this extension's: their history index carries on and their toasts and follow-ups still fire.
- The config moves to `omp-vcc-config.json` (copied from `pi-vcc-config.json` on first load), and `continueAfterThresholdCompact` is gone: omp always resumes on its own.

## Benchmarks

Benchmarks comparing the ranked brief with the pi-vcc 0.3.18 baseline (recall, fact density, precision, size) are in [`benchmarks/README.md`](./benchmarks/README.md).

## Acknowledgments

- [pi-vcc](https://github.com/sting8k/pi-vcc) by [@sting8k](https://github.com/sting8k) and its contributors, which this is forked from.
- [VCC](https://github.com/lllyasviel/VCC), the original transcript-preserving conversation compiler.
- Recall `mode:"touched"` and `#N:path` drill-down ported from [pi-blackhole](https://github.com/k0valik/pi-blackhole) by [@k0valik](https://github.com/k0valik), who also suggested the feature.

## License

MIT
