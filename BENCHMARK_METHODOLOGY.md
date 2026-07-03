# Benchmark Methodology

## Purpose

The solver now has enough stochastic and time-budget-sensitive behavior that a
single run can be misleading. This document defines the current apples-to-apples
benchmark protocol and records the first deterministic multi-seed results.

The immediate question was whether the seed `12345` result of `39/50` solved
30-vertex graphs was representative, or whether it was a lucky seed. The answer
from the first sweep is: `12345` is a useful fixed regression target, but it is
not enough to estimate the general solve rate by itself.

## Current Fixed Benchmark

Use this command for the primary deterministic 30-vertex benchmark:

```bash
node benchmark-stage2.js 50 30 400 12345 --deterministic-clock
```

Meaning:

- `50` puzzles
- `30` vertices per puzzle
- `400` solver move cap per puzzle
- seed `12345`
- deterministic solver clock enabled

Current result:

```text
12345  39/50 solved
median solved moves: 97
average solved moves: 125.36
failed median final crossings: 14
```

This is the current single-seed regression baseline. It is good for detecting
large regressions or confirming that a local change did not obviously break the
solver. It is not enough to claim a general solve rate.

## Deterministic Clock

`--deterministic-clock` makes structural-search time budgets use a logical
solver clock instead of real wall-clock time. This matters because the solver has
many bounded searches that stop when their time budget is exhausted. Under real
wall-clock timing, browser load, headless runtime, JIT state, and rendering can
change how many candidates are explored.

The deterministic clock makes runs reproducible for the same code, seed, and
configuration. UI animation timing, export timestamps, and profiler timing still
use real time.

## First Multi-Seed Sweep

Command used:

```bash
for s in 12345 1 2 3 4 5; do
  node benchmark-stage2.js 50 30 400 $s --deterministic-clock > /tmp/bench-$s.log
  node -e "const r=require('./benchmark-stage2-results.json'); console.log('$s', r.summary.solved + '/50', 'avg', r.summary.averageMovesPerSolve.toFixed(1), 'median', r.summary.medianMovesPerSolve, 'failMed', r.summary.failedMedianFinalCrossings);"
done
```

Results:

| seed | solved | solve rate | avg solved moves | median solved moves | failed median final crossings |
|------|--------|------------|------------------|---------------------|-------------------------------|
| 12345 | 39/50 | 78% | 125.4 | 97 | 14 |
| 1 | 39/50 | 78% | 119.8 | 94 | 14 |
| 2 | 31/50 | 62% | 133.9 | 107 | 12 |
| 3 | 39/50 | 78% | 119.6 | 113 | 18 |
| 4 | 34/50 | 68% | 140.6 | 120 | 12 |
| 5 | 34/50 | 68% | 108.8 | 89 | 14 |

Aggregate:

```text
Total solved: 216/300
Mean per-seed solve rate: 72%
Observed seed range: 62% to 78%
```

## Interpretation

The difference between a 65% world and an 80% world is algorithmically important.
A story that matters at 65% may be much less important at 80%, and vice versa.
So we should not let a single seed decide whether a change is meaningful.

From the six-seed sweep, seed-to-seed variation is real and large enough to
explain some of the apparent disagreement between runs. The `12345` result is
near the high end of this first sample, but it is not alone: seeds `1` and `3`
also solved `39/50`. Seed `2` solved only `31/50`. That means the solver has a
wide distribution over generated graph batches, not just small measurement
noise.

The best current estimate from this small sample is roughly `72%`, but the sample
is too small to treat that as a precise global solve rate. It is enough to say
that `39/50` should be treated as a strong seed-specific baseline, not as the
headline general solve rate.

## Recommended Reporting

For quick local checks:

```bash
node benchmark-stage2.js 50 30 400 12345 --deterministic-clock
```

Report:

- solve count
- median solved moves
- failed median final crossings
- strategy totals if the change affects policy

For real algorithm comparisons, use the six-seed suite:

```bash
for s in 12345 1 2 3 4 5; do
  node benchmark-stage2.js 50 30 400 $s --deterministic-clock > /tmp/bench-$s.log
  node -e "const r=require('./benchmark-stage2-results.json'); console.log('$s', r.summary.solved + '/50', 'avg', r.summary.averageMovesPerSolve.toFixed(1), 'median', r.summary.medianMovesPerSolve, 'failMed', r.summary.failedMedianFinalCrossings);"
done
```

Report:

- total solved out of `300`
- mean solve rate
- worst seed
- best seed
- per-seed solve counts
- move-count changes for solved graphs
- failed median final crossings

A change should not be considered a clear win just because it improves seed
`12345`. Stronger evidence is:

- improves total solved across the six-seed suite,
- does not significantly harm the worst seed,
- does not add large move-count churn,
- and has understandable strategy-level evidence explaining why it helped.

## Open Issue: Statistical Confidence

A six-seed suite gives better signal than one seed, but it still has visible
variance. If a future change looks close, especially within about `5/300` solved
puzzles, we should run a larger suite before trusting it. A reasonable next tier
is `20` seeds x `50` puzzles = `1000` puzzles, still deterministic and still
small enough to run headless when needed.

The practical threshold should match the decision:

- Small refactor safety: one seed may be enough if behavior is intended to be unchanged.
- Policy change candidate: six-seed suite minimum.
- Default deployment decision: larger suite if the six-seed result is close.
