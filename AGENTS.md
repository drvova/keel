# AGENTS.md

pi-vcc is a Pi and omp (oh-my-pi) extension: algorithmic compaction (no LLM call) plus `vcc_recall` over the raw session history. User-facing docs are in `README.md`; keep it short and put contributor notes here.

## Checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
```

`bun.lock` pins an older Pi host (0.85.1). CI also runs the suite on a recent Pi (the `matrix.pi` version in `.github/workflows/ci.yml`); to do the same locally, install that version of both packages:

```sh
V=1.4.0
npm install --no-save --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@$V @earendil-works/pi-codemode@$V
bun test
```

Without the matching `pi-codemode`, older Pi releases pick up a newer one they cannot load and several suites fail. Tests for host features missing from the locked Pi (e.g. context edits) skip there and run on the recent one.

`tests/omp-host.test.ts` runs pi-vcc inside a real omp session and skips unless omp is installed. CI's `omp` job installs the `matrix.omp` version; omp needs Bun >= 1.4.4:

```sh
V=18.14.2
npm install --no-save --ignore-scripts --no-audit --no-fund @oh-my-pi/pi-coding-agent@$V
bun test
```

`tests/long-horizon.test.ts` holds the long-horizon floor: a synthetic 60- and 120-turn session with planted facts, compacted every 6 turns through the real hook (`tests/support/long-horizon.ts`). `bun run scripts/benchmark-long-horizon.ts` prints the per-fact table; run it before and after a change to the summary or recall.

omp's own docs ship inside that package (`dist/docs-index.generated.txt`: a JSON list of names, a newline, then a base64 gzip of the bodies); `extensions.md`, `compaction.md` and `session.md` cover what pi-vcc uses.

## Layout

- `index.ts` (Pi, `pi.extensions`) and `omp.ts` (omp, `omp.extensions`; omp prefers it): register everything below.
- `src/hooks/compaction.ts`: the compaction hook, host-agnostic: which messages are live, where to cut, smart keep-tail, what each message becomes in the summary (`toSummaryMessage`). The host's functions come in through a `CompactionHost`.
- `src/hooks/before-compact.ts`: the Pi binding of that hook (Pi's `convertToLlm`, `buildSessionProjection`, version-gated continue).
- `src/omp/`: the omp binding: `host.ts` (trigger reason from `auto_compaction_start`), `commands.ts` (`/pi-vcc`), `recall-tool.ts` (`vcc_recall` with a JSON Schema), `api.ts` (the structural omp API types).
- `src/core/`: summary pipeline (`normalize` → `filter-noise` → `build-sections` → `brief`/`rank` → `format`, driven by `summarize.ts`), `history-index.ts` (`[History Index]`: built in the hook, stored in the compaction's `details.historyIndex`, rendered by `summarize.ts`), recall (`recall-request.ts` parses the call, `recall-run.ts` runs it, `search-entries.ts` ranks), settings.
- `src/extract/`: one module per summary section (user messages and early requests, files, commits, tracked commands).
- `src/core/pins.ts` (pinned notes: `pi-vcc.pin` custom entries replayed along the branch) and `src/core/sessions.ts` (the project's other session files: listing, id resolution, each file's active branch).
- `src/commands/`, `src/tools/`: `/pi-vcc` (Pi), `/pi-vcc-recall` and `/pi-vcc-pin`/`/pi-vcc-unpin` (shared), the `vcc_recall` and `vcc_pin` specs shared by both hosts (`recall-spec.ts`, `pin-spec.ts`) and their Pi bindings (`recall.ts`, `pin.ts`); omp's are `src/omp/recall-tool.ts` and `src/omp/pin-tool.ts`.

## Rules

- Support the whole peer range (`>=0.74.0 <2.0.0`). Use a newer host API only behind a check that keeps older hosts on the old path.
- Only `index.ts`, `src/hooks/before-compact.ts` and `src/tools/recall.ts` import Pi packages or `typebox` at runtime (and `src/commands/pi-vcc.ts` through `before-compact.ts`); everything else imports types only. The omp path imports no host package: it gets omp's functions from `pi.pi`. Keep it that way (`bun build omp.ts --packages external` should import only node builtins).
- omp binds the factory again for every subagent session while module state is shared, so per-session state lives in the binding (`createCompactionState()`), not in a module variable.
- `#N` refs in summaries are session-wide entry indices that `vcc_recall` resolves. Any change to which entries are indexed must keep them stable; `[History Index]` ranges are `#N` too. Pins are `custom` entries, so they are never counted. In another session (`session:'id'`, `scope:'project'` hits) `#N` is that session's own.
- Sections carried across compactions are merged from structured data or re-capped verbatim, never re-written: rewriting a previous summary is how LLM compactors lose detail compaction after compaction. Keep the summary bounded as the session grows (the long-horizon test checks it).
- Agents act on recall and summary text (headers, hint lines, `Ignored:` notes). Treat it as an interface: change it on purpose, and update the tests that pin it.
- The smart keep-tail limit (25k) is pi-vcc's own and does not follow Pi's `compaction.keepRecentTokens`.
- Tests that read settings set `PI_VCC_CONFIG_PATH` to a temp file, never the user's config. `tests/real-sessions.test.ts` runs only when `~/.pi/agent/sessions` exists.
- `research/` is git-ignored local data (real sessions, replays). Never commit it or quote session content in commits or PRs.
- Note user-facing changes in `CHANGELOG.md` under `[Unreleased]`.
