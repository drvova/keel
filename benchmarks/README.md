# Compaction Benchmarks

How the ranked brief compaction (`compileRanked`) is measured against the shipped
baseline compaction (**master 0.3.18**), plus the current results.

> [`benchmark.ts`](./benchmark.ts) in this folder is a **self-contained template**
> you can run on your own sessions (see §8). It is a readable starting frame, not a
> turnkey tool — the fact weights and command families are meant to be edited to
> match your workflow. The full research harness that produced the numbers below
> lives under `research/` (not shipped).

## 1. What is measured

When a session is compacted, the older transcript is replaced by a **brief**: a
compressed summary that must preserve the durable facts of the session (files
edited, commands run, commits, ...) while staying small.

Two things are in tension:

- **Recall** — how many real facts survive into the brief.
- **Size** — how many characters the brief costs.

The benchmark compares two brief builders on the same sessions:

- **baseline** (master 0.3.18) — one contiguous raw transcript-tail window,
  line-capped.
- **ranked** (`compileRanked`) — scores and selects blocks under a size budget.

```
full transcript ──► extract reference facts  (ground truth, weighted)
       │                                   │
       ├──► baseline brief ──►┐            │
       └──► ranked brief   ──►┤  same extractor parses both  (symmetric)
                              ▼
        paired scoring: recall · density · precision · size
```

## 2. Datasets

| name                | what it is                                  | size             |
|---------------------|---------------------------------------------|------------------|
| local tests         | unit + integration suite (`bun test`)       | 214 tests        |
| hf-dataset          | a public HuggingFace session dataset        | 794 sessions     |
| local real sessions | held-out real sessions, not in hf-dataset   | large (11–27 MB) |

`hf-dataset` is the primary in-sample corpus. `local real sessions` are the
out-of-sample (OOS) check against overfitting to hf-dataset.

## 3. Scoring

### 3.1 Fact model

Reference facts are extracted from the **full** transcript (the ground truth).
Both briefs are then parsed by the **same** extractor and scored by **exact set
membership** — a fact counts as recalled only if its normalized key appears in
the brief. Because both sides use the same parser, scoring is symmetric and
neither builder gets a parsing advantage.

Keys are **normalized**, not embeddings:

- **command family** via regex — `git <verb>`, `gh pr|issue <verb>`,
  search (`rg`/`grep`/`find`), test/verify (`bun|npm|pytest|cargo|go test|tsc`...)
- **file path** (read vs modified)
- **commit**
- **tool call** (edit-class vs read-class)

### 3.2 Fact weights

Not all facts matter equally. Each recalled fact contributes its category weight,
so losing a commit hurts far more than losing a generic `ls`:

| fact category            | weight | rationale                          |
|--------------------------|:------:|------------------------------------|
| failed command           |   6    | an error state is the most critical to carry forward |
| commit                   |   5    | durable checkpoint                 |
| modified file            |   4    | concrete change to the codebase    |
| test / verify command    |   4    | proves state                       |
| edit-class tool call     |   4    | concrete change                    |
| gh pr / issue command    |   2    | workflow milestone                 |
| file read                |   1    | context, low durability            |
| search command           |   1    | context, low durability            |
| read-class tool call     |   1    | context, low durability            |
| other command (generic)  |  0.5   | the long tail                      |

### 3.3 Metrics

| metric              | formula                                     | meaning                                       |
|---------------------|---------------------------------------------|-----------------------------------------------|
| weightedRecall      | Σ weight(ref facts found) / Σ weight(all ref facts) | fraction of *value* kept (empty session → 1) |
| weightedFactDensity | Σ weight(facts found) / (briefChars / 1000) | value kept per 1k chars (size-normalized)     |
| precision           | mean fact-weight of the brief's own facts (non-overlapping partition) | is the budget spent on high-value fact types? (~0.5–5) |
| size                | brief length in chars                       | budget cost                                   |

`weightedFactDensity` is the fairest single quality number because it is
size-normalized: a builder cannot win it just by writing more.

### 3.4 How comparisons are made

Comparison is **paired**: the per-session delta between ranked and baseline,
reported as the median + mean (+ IQR) of those deltas. A marginal comparison
(median of one column minus median of the other) is *not* paired and can mislead,
so it is never used for the headline delta.

## 4. Results vs master 0.3.18

hf-dataset, production budget (see §5), 790 non-empty sessions.

**TL;DR vs 0.3.18:** same recall on the typical session (paired median +0.0pp),
but **smaller** (median −11%, corpus −35%) and **denser** (~1.4× fact-value per
char, duplicates near-eliminated). The only cost is a small recall dip on the
large-session tail (mean −2.4pp, §4.2) — the exact place the brief shrinks most.

### 4.1 Headline

| metric                       | baseline (master) | ranked | delta            |
|------------------------------|:-----------------:|:------:|:-----------------|
| weightedRecall — paired      |         —         |   —    | **median +0.0pp**, mean −0.7pp |
| weightedRecall — marginal median | 72.0%         | 69.2%  | (marginal, context only) |
| weightedFactDensity (median) |       3.69        |  5.10  | **~1.4×**, paired wins 465 / 171 |
| precision (median)           |       1.68        |  1.84  | +0.20 mean       |
| duplicate commands / brief   |        0.9        |  0.1   | near-eliminated  |
| duplicate tool calls / brief |        0.9        |  0.1   | near-eliminated  |
| recall wins / losses         |         —         |   —    | 253 / 199        |

**Read:** on the median session, ranked matches master's recall (+0.0pp) while
packing ~1.4× the fact-value per character and near-eliminating duplicates. The
small negative *mean* comes entirely from a large-session tail (§4.2).

### 4.2 Size and recall by session size

Bucketed by master's brief size. Size reduction is **per-session median**.

| bucket (master brief) |  n  | size reduction | recall Δ (median) | recall Δ (mean) |
|-----------------------|:---:|:--------------:|:-----------------:|:---------------:|
| SMALL  (<3.5k)        | 291 |      ~0%       |      +0.0pp       |     +1.2pp      |
| MED    (3.5–6k)       | 130 |       8%       |      +0.0pp       |     +0.1pp      |
| LARGE  (≥6k)          | 369 |      38%       |      +0.0pp       |     −2.4pp      |

Overall size reduction depends on how you weight it:

| view                        | reduction |
|-----------------------------|:---------:|
| per-session median          |  **11%**  |
| per-session mean            |    19%    |
| corpus total bytes          |    35%    |

The oft-quoted "−35%" is the **corpus-byte** figure — dominated by LARGE sessions
(−38% median). The **typical** session shrinks ~11%.

### 4.3 By fact category

| fact category            | master recall | ranked recall | delta   |
|--------------------------|:-------------:|:-------------:|:--------|
| gh pr / issue            |     71.7%     |     77.9%     | +6.2pp  |
| test / verify            |     84.7%     |     85.4%     | +0.7pp  |
| generic command (tail)   |     67.1%     |     62.0%     | −5.1pp  |

High-value categories (commits, modified files) sit at parity; the differences
are confined to the low-weight long tail.

### 4.4 Out-of-sample (local real sessions)

On held-out large/huge real sessions, ranked **ties-or-wins every session**
(recall mean ≈ +3.1pp, 0 regressions) at ~4× density. Absolute recall there is
low (~17–20%) simply because an ~8k-char brief can only cover a fraction of the
thousands of facts in an 11–27 MB transcript; the comparison is fair because both
builders get the same budget.

## 5. Size-relative budget

The budget is not a flat cap; it scales with session length:

```
maxBriefChars = clamp(slope × blockCount, floor, ceiling)
```

| param   | role                                | production value         |
|---------|-------------------------------------|--------------------------|
| floor   | minimum budget (small sessions)     | ~4400 chars (1100 tok)   |
| ceiling | maximum budget (bounds growth)      | ~8000 chars (2000 tok)   |
| slope   | budget per transcript block         | ~60 chars/block (15 tok) |

A flat cap gives a 50-block and a 3000-block session the same budget, starving the
long tail on large sessions. The slope gives longer sessions more room; the
ceiling keeps it bounded. `blockCount` is the length driver because it is
available in-place (no need to run the baseline builder to size the budget).

## 6. Where ranked leads / trails

- **Leads:** density (~1.4×), precision, near-total dedup, gh-command recall, and
  small/medium sessions — at recall parity or better.
- **Trails:** the LARGE-session long tail (mean −2.4pp) and generic long-tail
  commands (−5.1pp) — which is also exactly where ranked is smallest (−38%).

So the win vs master is **smaller + denser at median-recall parity**, not a raw
recall win. Closing the LARGE tail without giving back the size advantage is the
open improvement target (candidate levers: near-duplicate prose compression to
free budget for markers, a targeted LARGE-session ceiling, and scoring/selection
tuning).

## 7. Caveats

- The OOS gain is real but modest and workflow-specific.
- The firm, defensible claim is **no median regression + higher fact-density**,
  not a large recall win.

## 8. Run it on your own sessions

[`benchmark.ts`](./benchmark.ts) is a **template**: a single self-contained file
(fact model, weights, and metrics inlined) that scores the ranked brief against
the plain transcript-tail brief on your sessions. Run it from a clone of this
repo (needs [bun](https://bun.sh) and the repo's installed dependencies):

```
bun benchmarks/benchmark.ts --sessions=~/.omp/agent/sessions --limit=200
```

It prints a baseline-vs-ranked table plus the paired recall delta, and writes
`benchmarks/out/benchmark.{csv,json}` (gitignored) for your own analysis.

| flag          | meaning                                 | default                |
|---------------|-----------------------------------------|------------------------|
| `--sessions`  | dir of `*.jsonl` sessions (recursed)    | `~/.omp/agent/sessions` |
| `--limit`     | max sessions to score                   | all                    |
| `--floor`     | min brief budget, chars (§5)            | 4400                   |
| `--ceiling`   | max brief budget, chars (§5)            | 8000                   |
| `--per-block` | budget slope, chars/block (§5)          | 60                     |
| `--max-blocks`| ranked selection pool size              | 80                     |
| `--recent`    | recent blocks always kept               | 16                     |
| `--out`       | output dir                              | `benchmarks/out`       |

It reads transcripts locally and makes **no network calls**; only aggregate
metrics and session IDs are written to `--out`.

**Adapt it to your workflow.** The two blocks worth editing are the `WEIGHTS`
table (§3.2 — what a fact is worth to *you*) and the command-family regexes
(§3.1 — e.g. add your test runner or task tool). The default baseline is this
repo's own `compile()`; to reproduce a "vs a released version" number, install
that version and import its `compile` as the baseline (see the comment at the
top of the file).
