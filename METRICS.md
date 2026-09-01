# Metrics

Derivative measurements layered on top of the solver's objective state (vertex
positions + crossing geometry). The solver maintains objective state; this layer
**imposes its own opinion** about what that state means, refining it over time —
we take the algo's word for nothing beyond raw positions/crossings.

All metrics live in `solver.js` (single source of truth) and are consumed by the
live UIs (`solver.html` card, `interactive.html` panel) and the offline
annotator (`annotate-history.js`). Marginal cost is ~zero: crossing detection
was already paid every move; everything here is O(N) arithmetic over per-vertex
crossing counts.

---

## 1. Progress metrics — `computeProgressMetrics(graph, analysis)`

Snapshot describing how "developed" a layout is. Pure function of one frame.

| field | meaning |
|---|---|
| `progress` | composite 0.40·cleanRatio + 0.45·largestCleanRegionRatio + 0.15·(1 − crossings/(crossings+30)). **Internal plumbing only** — used to order states; not a headline number (its weights are arbitrary and it has misleading local maxima, so it is NOT used to detect cascade onset). |
| `cleanVertices` / `cleanRatio` | vertices with zero incident crossings, and as a fraction. |
| `largestCleanRegion` / `largestCleanRegionRatio` | size of the largest graph-connected clean region. |
| `cleanEdges` / `cleanEdgeRatio` | edges with both endpoints clean. |
| `nearCleanVertices` / `nearCleanRatio` | vertices with ≤1 incident crossing (leading indicator before any vertex is fully clean). |
| `regionFragmentation` | 1 − largestCleanRegion/cleanVertices; how scattered the clean vertices are. |
| `crossingsPerEdge`, `crossingsPerDirtyEdge` | crossing density, overall and among dirty edges. |
| `topCrossingShare` | fraction of all crossings concentrated in the top-5 worst vertices. |

Supporting change: `analyzeGraphState` now also returns `crossingCounts`
(per-vertex crossing involvement) so downstream metrics need no extra pass.

---

## 2. Story / cascade-state metrics — `updateStoryMetrics(graph, st, ...)`

**Real-time, causal, stateful.** A live readout of where a solve sits relative
to the *wasted-tail → cascade* story (section 4). Each number uses only the
present move plus a trailing window `W` (default 15), so the solver can read it
mid-solve. Create state with `createStoryState(W)`; call once per actual move.

| metric | causal definition | reads as |
|---|---|---|
| **freeze** | mean offender-set Jaccard over last W moves | ~0.95 ⇒ the SAME vertices cross every move → thrashing in place. **The negative/"stuck" signal.** |
| **dwell** | moves since crossings last set a STRICT new low | the live length of the current **wasted tail**. Resets only when a cascade makes genuinely new lows (re-touching the same min does NOT reset it). |
| **crowd** | # vertices dirty ≥ W consecutive moves | how many persistent "problem children." |
| **trend** | crossings now − crossings W moves ago | +uphill (escape/thrash), ~0 plateau, −descending (cascade). |
| **thaw** | # offenders that dropped out of the set since last move | turnover; the frozen set breaking up. |
| **drop** | max single-vertex crossing reduction this move | a de-confliction **event** (a vertex shed K crossings). NOT a prediction a cascade will catch. |
| `offenderCount` | vertices with ≥1 crossing | size of the active conflict set. |
| `topOffender` / `topOffenderCc` | worst vertex and its crossing count | the current most-tangled vertex. |

**Trust levels (be honest when publishing):**
- `freeze`, `dwell`, `crowd` need **no foresight** — a defensible live "stuckness"
  reading. If you publish one belief, publish these three.
- `trend`, `drop`, `thaw` are cascade-detection **ingredients** — they light up
  during a real cascade and stay dark during a stuck twitch, but individually are
  necessary-not-sufficient. Publish `drop`/`trend>0` as *events*, never as "a
  cascade is coming."

---

## 3. Cascade onset (retrospective) — `annotate-history.js` `findCascadeOnset`

Offline only (needs the future). Onset = top of the FINAL crossings descent that
reaches the global min, found on a running-median-smoothed (w=5) series so spikes
and endgame noise don't move it. Walk back from the min over real downward
progress; tolerate a short wobble but STOP at sustained-flat runs (those are the
wasted-tail plateau, not the descent). `descentDepth ≈ 0` ⇒ the graph never
actually cascaded (typical of stuck graphs).

---

## 4. The wasted-tail / cascade story (what the metrics describe)

Validated on 30-vertex graphs (n=150 cascades + real replays), stable:

- **Wasted tail**: stuck/slow graphs spend a long stretch (median ~50% of moves,
  up to 80%) thrashing after reaching their best state — `freeze` high (~0.95),
  `dwell` climbing, `trend` ~0, same frozen offender crowd.
- **Cascade**: a breakout fires from a *messy* peak (~30 crossings), reached by
  going **uphill** (`trend` +5/move). It is **triggered by one heavily-tangled
  offender de-conflicting itself** (`drop` large on a core offender), then
  propagates as a ~9-vertex, ~10-move chain that removes ~30 crossings; the
  frozen set **thaws** (`freeze`/Jaccard 0.94 → 0.78).
- **Stuck graphs mostly never START a cascade** (~4 of 75 even produce a ≥5
  descent). They fail to begin one, not midway through one.
- **Inside/outside is NOT the cascade trigger** — at the messy peak there is
  barely a clean region, so that lens (trapped child moves out) describes later
  consolidation, if anything, not the trigger.

---

## 5. Regime metrics — `createRegimeState` + `computeRegimeMetrics(graph, analysis, storyMetrics, st)`

**An assembly layer, not a new computation.** It composes existing signals
(analysis + story metrics + a small nucleus-growth window) into a per-move answer
to *"which regime(s) are we in?"* — so the algo can decide **what to optimize**.
It is **descriptive, not predictive** (see the lifecycle note below). Computed
live and stored on `solverState.regimeMetrics` so the algo can read it next step.

The lifecycle has (at least) two objectives, and the metric describes membership
in each — **allowed to overlap** (both high = the handoff/baton-exchange zone):

| field | tag | meaning |
|---|---|---|
| **bulkReduction** | rollup | `crossingLoad` — how much crossing-soup remains. Heuristic, tunable. |
| **nucleusBuilding** | rollup | `nucleusFraction·(0.5+0.5·solidity)` — how much *solid* nucleus there is to grow. Heuristic, tunable. |
| `nucleusFraction` | graph-state / **independent** | largest clean region / N — the frame's size. |
| `nucleusSolidity` | independent | region density (cheap O(E) proxy; full `establishedScore` available since the O(size³)→near-linear fix). |
| `nucleusGrowth` | independent | nucleus fraction now − W moves ago (W=15). The regime *dynamic*. |
| `boundaryConcentration` | independent | fraction of offenders sitting on the nucleus frontier — high ⇒ growing the nucleus resolves the crossings; low ⇒ scattered. |
| `crossingLoad` | independent | crossings/(crossings+N). |
| `edgeLengthSlack` | independent, **provisional/superseded** | max relative edge length — proxy for "distance from barycentric equilibrium," i.e. reduction still available. Shipped unvalidated; quarantine its reputation. Taken over *all* edges, so it is dominated by the long clean ones; **`dirtyEdgeStats` (section 6) is the same idea restricted to edges that actually cross**, and is the one to reach for. |
| `freeze` / `dwell` / `trend` | **algo-DEPENDENT** | passed through from story — the "current runner has slowed" descriptor. |

**Durability tags matter:** `nucleus*` / `boundaryConcentration` / `crossingLoad`
/ `edgeLengthSlack` are properties of the *graph state* — they survive an algo
rewrite. `freeze`/`dwell`/`trend` describe the *solver's behavior* and drift as
the algo changes. Prefer the independent ones as the durable diagnostic axis.

**Why descriptive, not predictive:** early nucleus behavior does NOT separate
eventual-solve from eventual-fail (both crawl at low nucleus for the first half),
and a "stalled" flag false-fires on ~3/4 of eventual solves. So regime metrics
describe *where a solve is now* (answerable, robust) — they do **not** forecast
its outcome (a coin flip, dominated by algo volatility). Use them to guide the
*current objective*, not to predict.

---

## 6. Dirty-edge length — `dirtyEdgeStats(graph)`

Edge lengths split by whether the edge takes part in a crossing. A **dirty** edge
crosses something; a clean edge does not. Clean edges may be arbitrarily long and
are ignored except as the scale normaliser.

The idea: a long dirty edge spans the drawing and conflicts with whatever lies
along it; a short one keeps the trouble local. So this measures **how localized the
remaining conflict is** — something a crossing count cannot express, since the same
count describes a scattered mess and a single tight knot alike.

| field | meaning |
|---|---|
| `medianDirtyRatio` | `medianDirty / medianClean` — **the discriminating form**, see below |
| `maxDirtyRatio` | `maxDirty / medianClean` — wider range, but separates worse in every band |
| `dirtyCount` / `cleanCount` | set sizes; both ratios get noisy when `dirtyCount` is small |
| `maxDirty`, `medianDirty`, `sumDirty`, `medianClean` | raw lengths — **not comparable across frames**, see below |
| `worstDirtyEdgeIndex` | argmax. Names an edge rather than summarising the drawing |

**Always use the ratio forms.** Raw lengths confound with global contraction of the
whole drawing; only the ratio against `medianClean` is comparable between frames.

**Relationship to `edgeLengthSlack` (section 5).** Same family, and this supersedes
it as a localization measure. `edgeLengthSlack` is `maxLength / median` over *all*
edges, so it is dominated by the long **clean** edges — which is the plausible
reason it never earned its keep and is still tagged provisional. Restricting to
dirty edges is the change that makes the quantity mean something.

Cost is nil: reads the `link.intersection` flags that `intersections()` already sets
as a side effect, so it is O(E) with no crossing tests of its own. It is therefore
valid **only immediately after an `intersections()` call** — the incremental
`countEdgeCrossings()` does not maintain those flags.

### Measured, 60v, 40 runs of this solver (32 solved / 8 failed)

At matched crossing count, runs that go on to fail carry longer dirty edges — but
**only in the deep endgame**, and only in the median. Ratio is failed/solved, so
1.00 means no separation:

| crossings | `medianDirtyRatio` sol / fail | ratio | `maxDirtyRatio` ratio |
|---|---|---|---|
| 3–5 | 1.67 / 7.08 | **4.23** | 2.81 |
| 5–8 | 2.46 / 3.83 | 1.56 | 1.21 |
| 8–12 | 1.89 / 3.59 | 1.90 | 1.46 |
| 12–20 | 2.21 / 2.73 | 1.24 | 0.96 |
| 20–30 | 2.28 / 2.40 | 1.05 | 0.93 |
| 30–50 | 2.12 / 2.20 | 1.04 | 0.98 |

Two things follow, and both are easy to get backwards:

- **The usable band is below ~12 crossings**, strongest below 5. From 20 up there
  is nothing — 1.04–1.05 is noise, on 229+ failed samples, so this is a real
  absence and not a small sample. Steering above that band acts on noise.
- **Median beats max in every band.** `maxDirtyRatio` has far more dynamic range,
  which makes it look like the better signal, and it is the one that stands out
  when watching a Tutte relaxation. It is not the one that separates outcomes here.

**Honest limits.** Failed runs *accumulate* samples in the band they are stuck in,
so part of any gap is "sitting at 4 crossings for 54 moves" rather than "long dirty
edges cause failure." And the 3–5 band rests on 35 failed samples. Sound as a
diagnostic; the causal claim rests on an A/B, not on this table.

**Provenance — the numbers above replace an earlier set that were wrong.** The
first calibration ran a harness that did not reproduce `benchmark-stage2.js`: it
omitted `setDeterministicClock(true)` and the post-generation RNG re-seed
(`benchmark-stage2.js:472,475`). That solver solved 53% where the benchmark solves
71%, and it reported the separation peaking at 20–40 crossings with the *max* —
both of which reverse under the corrected harness. **Validate any trace harness by
reproducing a known benchmark seed before reading science off it**; the fixed one
returns 15/20 on seed 2, matching exactly.

Consumed by the Stage 1 tie-break (`ctx.dirtySteering` in `runDescentPass`), which
is a separate question from the metric's validity — see `ALGO_ARCHIVE.md`.

---

## Where each is computed

| metric set | function | live? | file |
|---|---|---|---|
| progress | `computeProgressMetrics` | yes | solver.js |
| dirty-edge length | `dirtyEdgeStats` | on demand (O(E), after `intersections()`) | solver.js |
| story / cascade-state | `createStoryState` + `updateStoryMetrics` | yes (per move) | solver.js |
| regime | `createRegimeState` + `computeRegimeMetrics` | yes (per move) | solver.js |
| cascade onset | `findCascadeOnset` | no (retrospective) | annotate-history.js |

Live wiring: `solver.html` computes story + regime once per move in its
`solverStep` wrapper (stored on `solverState` so the algo can read them next step,
and on `puzzle._analysis` reused by the render) and shows card rows;
`interactive.html` replays history through story + regime state in
`updateAnalysis` (cached on history length) and shows "Cascade state (live)" and
"Regime (live)" panel blocks; `annotate-history.js` recomputes both offline in its
replay pass, so exported histories get `metrics.story` and `metrics.regime` per
move (option A — no raw `moveEntry` bloat).
