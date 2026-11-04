# AGENTS.md

omp-vcc is an omp (oh-my-pi) extension: algorithmic compaction (no LLM call), pinned notes, and `vcc_recall` over the raw session history and the project's other sessions. A fork of pi-vcc, made omp-only. User-facing docs are in `README.md`; keep it short and put contributor notes here.

## Checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup:omp
bun run typecheck
bun test
```

omp is not a dependency: it releases often, and a pinned copy would test a version users have long updated past. `bun run setup:omp` installs the latest omp into `node_modules` without saving it (`OMP_VERSION=18.14.0 bun run setup:omp` for another one); typecheck and the suite need it, since tests drive the hook with omp's own `convertToLlm` (`tests/support/host.ts`), read sessions with omp's own parser (`tests/support/load-session.ts`), and `tests/omp-host.test.ts` runs omp-vcc inside a real omp session. omp needs a recent Bun (its `engines.bun`). CI runs everything against the latest omp and against the floor of the peer range in `package.json`, on every push and pull request and weekly.

`tests/long-horizon.test.ts` holds the long-horizon floor: a synthetic 60- and 120-turn session with planted facts, compacted every 6 turns through the real hook (`tests/support/long-horizon.ts`). `bun run scripts/benchmark-long-horizon.ts` prints the per-fact table (`… 60 6 all` for a 32K, 128K and 1M window); run it before and after a change to the summary or recall.

omp's own docs ship inside its package (`dist/docs-index.generated.txt`: a JSON list of names, a newline, then a base64 gzip of the bodies); `extensions.md`, `compaction.md` and `session.md` cover what omp-vcc uses. Its sources are in `node_modules/@oh-my-pi/pi-coding-agent/src` (`session/messages.ts` for `convertToLlm`, `extensibility/shared-events.ts` for the events).

## Layout

- `index.ts` (`omp.extensions` in `package.json`): registers everything below, with a fresh compaction state per binding.
- `src/hooks/compaction.ts`: the compaction hook: which messages are live, where to cut, smart keep-tail, what each message becomes in the summary (`toSummaryMessage`). omp's functions come in through a `CompactionHost`.
- `src/core/raw-store.ts` (the originals of what omp rewrites in the session file, in `<session>.jsonl.vcc-raw`) and `src/hooks/raw-capture.ts` (copies them from omp's entries as they land).
- `src/hooks/omp-host.ts`: that host: omp's `convertToLlm` from `pi.pi`, and the trigger (reason, willRetry) read from `auto_compaction_start`, since omp's `session_before_compact` carries none.
- `src/core/window.ts` (pure: limits stated in overflow errors, omp's trigger from the policy omp passes in `preparation.settings` (`ompTrigger`, a port of pi-agent-core's `resolveThresholdTokens`, which omp does not export; `tests/window.test.ts` checks it against omp's own), the budgets), `src/core/model-limits.ts` (the learned-limits file) and `src/hooks/window-limits.ts` (the effective window, the trigger a compaction sizes for, learning from `message_end`, compacting at `agent_end` when omp's window is too high).
- `src/core/`: summary pipeline (`normalize` → `filter-noise` → `build-sections` → `brief`/`rank` → `format`, driven by `summarize.ts`), `history-index.ts` (`[History Index]`: built in the hook, stored in the compaction's `details.historyIndex`, rendered by `summarize.ts`), `working-set.ts` (`[Working Set]`: chosen in the hook from the originals of what is summarized and what is kept, rendered by `summarize.ts`, its `#N` in `details.workingSet`), recall (`recall-request.ts` parses the call, `recall-run.ts` runs it, `search-entries.ts` ranks), settings.
- `src/extract/`: one module per summary section (user messages and early requests, files, commits, tracked commands).
- `src/core/pins.ts` (pinned notes: `omp-vcc.pin` custom entries replayed along the branch) and `src/core/sessions.ts` (the project's other session files: listing, id resolution, each file's active branch).
- `src/commands/`: `/omp-vcc` (`omp-vcc.ts`, with `compact-feedback.ts`), `/omp-vcc-recall`, `/omp-vcc-pin` and `/omp-vcc-unpin`.
- `src/tools/`: `vcc_recall` (`recall.ts`) and `vcc_pin` (`pin.ts`): the text the agent reads, the JSON Schema, and what a call does.
- `src/details.ts`: what a compaction stores in its details (`compactor: "omp-vcc"`; `"pi-vcc"` is read too).

## Rules

- Support the whole peer range (`>=18.14.0`; CI tests its floor and the latest omp). Raise the floor in `package.json` when a change needs a newer omp; otherwise use a newer omp API only behind a check that keeps older releases on the old path.
- Nothing under `src/` or `index.ts` imports a package at runtime, omp's included: types come from `@oh-my-pi/*` with `import type`, functions from `pi.pi`, and what omp's docs describe is ported (as `ompTrigger` is), not imported. CI checks that `bun build index.ts --target bun --packages external` imports nothing, statically or dynamically, but node builtins.
- omp-vcc works with omp as configured: it never changes omp's settings (only omp's settings registry, a package import, can) and never asks the user to. Every omp method that writes a summary (`remote`, `snapcompact`, `handoff`, `soft`, the notes-backed rollover) asks the hook first, and the hook answers every automatic pass, recovery included (a running turn's newest steps kept, or the whole window summarized; cancelled with the reason only when no summary can shrink it), so none of them writes one. It steps aside only for the user's opt-outs (`overrideDefaultCompaction: false`, `skipForProviders`) and when nothing is live. omp's shake runs before it (an overflow, when shake is the first usable method) or after it (the post-commit rescue), and hands over through `soft`. What runs around it rewrites messages in place (shake, `supersedeReads`, `dropUseless`, the age-based prune), so omp-vcc keeps the originals as they land (`src/core/raw-store.ts`, `src/hooks/raw-capture.ts`, `keepOriginals`). Recall reads them for the entries omp rewrote (`prunedAt`, an `artifact://` splice), falling back along a fork's `parentSession` chain; the summary is written from them (the cut and budgets count what the context holds); and on omp's `context` event, omp's placeholder for a kept result gains ` (the original: vcc_recall expand:[N])`, the same text on every request so the prompt cache keeps it. The copy comes from omp's entries, not the event's message, which omp de-obfuscates for display. `tests/omp-host.test.ts` checks it in a real omp session.
- omp binds the factory again for every subagent session while module state is shared, so per-session state lives in the binding (`createCompactionState()`), not in a module variable.
- `#N` refs in summaries are session-wide entry indices that `vcc_recall` resolves. Any change to which entries are indexed must keep them stable; `[History Index]` ranges are `#N` too. Pins are `custom` entries, so they are never counted. In another session (`session:'id'`, `scope:'project'` hits) `#N` is that session's own.
- Sections carried across compactions are merged from structured data or re-capped verbatim, never re-written: rewriting a previous summary is how LLM compactors lose detail compaction after compaction. Keep the summary bounded as the session grows (the long-horizon test checks it). `[Working Set]` is not carried at all: it is chosen again at every compaction (the merge drops the previous one), within `compactionBudgets`' `workingSetTokens` and at most half of what the compaction removes. It picks by paths, failure flags, recency and recall's own ranking, never by wording.
- Agents act on recall and summary text (headers, hint lines, `Ignored:` notes). Treat it as an interface: change it on purpose, and update the tests that pin it.
- Session data written under the pi-vcc name stays readable: `compactor: "pi-vcc"` details, and `pi-vcc-config.json` (copied to `omp-vcc-config.json` once).
- The smart keep-tail limit (25k) is omp-vcc's own and does not follow omp's `compaction.keepRecentTokens`; it, the summary budget, the summary's section sizes (`summaryLimits`) and the growth guard's margin scale with the trigger (`compactionBudgets`), and `expand`'s clips with the recall cap (`expandDetailChars`). All must stay the old numbers on a ~128K window. A new size limit that depends on how much context there is belongs there too, not in a constant.
- omp-vcc makes no network calls. The window is omp's (`ctx.model.contextWindow`, which omp's own discovery fills from the provider) or a smaller limit an overflow error stated; omp-vcc does not ask providers itself.
- Tests that read settings set `OMP_VCC_CONFIG_PATH` to a temp file, never the user's config. `tests/real-sessions.test.ts` runs only when `~/.omp/agent/sessions` exists.
- `research/` is git-ignored local data (real sessions, replays). Never commit it or quote session content in commits or PRs.
- Note user-facing changes in `CHANGELOG.md` under `[Unreleased]`.
