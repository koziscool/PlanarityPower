# solver.js audit — what is live, and which parameters are ad hoc

A full read of `solver.js` (9,269 lines), recording what actually runs, which
constants govern behaviour, and which are duplicated or inconsistent. Nothing here
is changed yet; this is the map.

Ordered by how much each finding is likely to matter.

---

## 1. The auto solver uses far fewer functions than the file suggests

Verified by grepping every call site (excluding definitions and `exports.`).
**Only four move generators have any internal caller:**

| function | called from | role |
|---|---|---|
| `findAdaptiveMinimizeMove` | 8 sites | the workhorse; all Stage 1 descent and every rollout/cleanup |
| `findAnchoredCentroidMove` | 8172 | one ladder rung |
| `suggestStage2Restart` | 8237 | one ladder rung |
| `findEscapeMove` | 8634 | last resort |

Plus the structural `suggest*` searches at their specific rungs.

**These have NO internal caller at all** — they are exported for the UIs only:
`findBestMoveFast`, `findBottleneckMoveFast`, `findGridMove`, `findBarrierMove`,
`findFinisherMove`, `findGrowClumpMove`, `findLocalMove`, `findCentroidMove`,
`suggestRegionReorganizationMove`, `suggestTriangleTriage`,
`suggestSeparatorReshape`, `findRelocateMove`, `findCompactMove`,
`findConsolidateMove`, `findUncrossMove`, `findWiggleMove`.

### The comments actively mislead about this

- `:531` — "SECTION: FAST STRATEGIES (used in main loop)". **None of them are.**
- `:536` — "findBestMoveFast … ACTIVE in solverStep: Early/Mid game". **Not called.**
- `:8721` — "findGrowClumpMove is ACTIVE in solverStep (mid/late game)". **Not called.**
- `:8892` — "findLocalMove and findAnchoredCentroidMove are also used in solverStep".
  Only the second is.

Anyone reasoning about solver behaviour from these comments — including me, earlier
in this work — will model the wrong algorithm.

**`findBarrierMove` deserves a specific warning if it is ever re-enabled.** Its
Stage 2B branch (`:6357`) is a nested 4-deep grid sweep at 0.05 spacing — roughly
19⁴ ≈ 130k position pairs, each calling full `intersections()` at O(E²). At 60v
that is on the order of 10⁹ intersect tests per invocation.

---

## 2. Size and crossing gates that silently switch strategies off

The most consequential class, because the gate is invisible at runtime — the
strategy simply never reports.

| gate | line | effect |
|---|---|---|
| `nodes <= 60` | 8060 | region compaction off above 60v *(now configurable)* |
| `nodes <= 60 && count <= 80` | 8262 | region extension off above 60v *(nodes now configurable; the `count <= 80` is not)* |
| `nodes <= 25 && count <= 60` | 8533 | stage1c auto hook *(now configurable)* |
| `nodes <= 200` | 7697, 7715, 8425 | several strategies |
| `count <= 120` | 8333, 8342, 8378 | wasted-tail detection and anchor-break auto |
| `count <= 80` | 8349 | cascade trigger |
| `count > 50 && count <= 250` | 8426 | high-crossing stage1c |
| `count <= 20` | 8618 | problem-child inversion (diagnostic only) |
| `count <= 15` | 1884, 3989 | dominant barrier; contained triangle |
| `count <= 12` | 4397, 4448 | separating-triangle finisher and its lookahead |
| `crossings > 250` | 919 | `analyzeConflictRegions` degrades to a single coarse blob |

**Measured consequence.** Runs at 70–100v show `extensions=0` on every puzzle,
because the two 60-vertex gates put the whole structural layer out of reach. The
60v benchmark sits exactly *on* that boundary. See `ALGO_ARCHIVE.md`.

**And the one that ends runs:**

```js
var stuckLimit = count <= 5 ? 500 : count <= 15 ? 200 : 50;   // :8661
```

At 90v, failures report STUCK at 4–77 crossings — they run out of *permission*,
not out of moves. At 20 crossings the solver gives up after 50 moveless steps; at
4 crossings it gets 500. Whether that shape is right at 90v has never been tested.

---

## 3. The same concept, several different constants

Each row is one idea implemented with unrelated numbers in different places.

**Down-weighting a crossing-involved neighbour:**
`0.3` (`weightedCentroid:345`), `0.25` (`suggestDirectionalPlans:1041`),
`0.25` (`barrierAnchorCompatibility:1838`).

**Minimum vertex separation:**
`MIN_NODE_DIST = 0.01` (`:361`, the global guard via `isTooClose`),
`MIN_COMPACT_DIST = 0.02` (`:5605`), `MIN_DIST = 0.02` (`:5802`),
`spacing = 0.012` (`:3983`), `0.014`/`0.025` (`:1194`), bare `0.02` (`:6368`).

**Board clamps:** `0.02/0.98` almost everywhere, but `0.03/0.97` (`:6237`),
`0.05/0.95` (`:8817`), `0.1/0.9` (`:4311`).

**Random-sample ranges** — three different notions of "somewhere on the board":
`0.02 + rand*0.96` (`:554`), `0.15 + rand*0.7` (`:674`), `0.05 + rand*0.9` (`:6759`).

These are cheap to unify and each unification is independently testable.

---

## 4. Two different crossing tests, with different semantics

- `intersect(a, b)` (`:173`) — epsilon `1e-6`, and **returns `true` when both
  endpoints match** (identical edge).
- `edgesIntersectCoords(...)` (`:6443`) — epsilon `0` on the parameters
  (`t > 0 && t < 1`), `1e-10` only on the determinant. Used exclusively by
  `findBarrierMove`.

Worse, the shared-endpoint guard is applied inconsistently. `intersections` (`:212`),
`crossingPairsForGraph`, and `regionCrossingProfile` all guard with
`shareEndpoint`. But **`getCrossingCounts` (`:716`) and `analyzeConflictRegions`
(`:898`) do not** — they rely on the parametric test rejecting a shared endpoint
via exact `t === 0`. That holds for exactly-shared coordinates, but it is an
unstated dependence on exact arithmetic in the two functions that produce the
per-vertex crossing counts everything else ranks by.

Note the `tutte/` port deliberately tightened this epsilon to `1e-9`, on the
grounds that `1e-6` can miss a crossing very near an endpoint (`tutte/src/geom.js`).

---

## 5. Scoring weights: unexplained linear combinations everywhere

Nearly every `suggest*` ends in a hand-tuned sum. A representative sample:

- `anchorScore` (`:327`) — `yellow*0.5 + direction*0.3 + degree*0.2`, with degree
  normalised by an arbitrary `/10` (`:324`).
- `scheduleRegionCompaction` (`:1512`) — `protected*100 + boundary*4 + total −
  repair*45 − placed*12 − remaining*2`.
- `suggestRegionCompactionPlan` (`:1634`) — `growth*30 + recovery*4 + established*3
  + areaReduction*12 − damage*0.12 − protected*8`, accept iff `areaReduction >= 0.5`.
- `suggestRegionExtensionPlan` (`:1768`) — five weighted deltas, accept iff
  `score >= 50`. That threshold is on an unnormalised score.
- `cleanAnchorBreaksForBarrier` (`:2211`) — `(clean?100:0) + (touches?18:0) +
  same*4 − opposite*12 − crossings*8`.
- `suggestStage1cResetPlan` (`:7272`) — nine terms including a bare `−1000` penalty.

**One of these looks like a latent defect rather than just an untuned weight.**
`analyzeEstablishedRegion` (`:858`):

```js
establishedScore = region.length + density*2 + triangleQuality*2 +
  min(1, visibilityRatio) - edgeLengthCV -
  boundaryEdges/max(1,region.length)*0.25 + dandelionQuality
```

`region.length` is an unbounded vertex count; every other term is roughly 0–2.

**Measured, 60v, 6 solves, 19 regions sampled after ~220 moves each:** the whole
quality contribution (`score − vertexCount`) spans **[−0.75, 2.47]**, a range of
3.22, while `vertexCount` ranges 1–60. Of 146 region pairs with different vertex
counts, the score ordering disagrees with plain count ordering **once** — 0.7% —
and that single case is a 4-vertex region edging out a 5-vertex one.

So `establishedScore` is `vertexCount` plus a ±3 tiebreak, and
`bestEstablishedRegion` is "largest clean region" in all but pathological cases.
That would be fine if it were free, but it is not: `analyzeEstablishedRegion` runs
per clean region on every `analyzeGraphState` call and pays for triangle
enumeration, per-vertex dandelion detection with a polar sort, edge-length CV, and
an O(region²) nearest-spacing scan — to produce a ranking that a `.length` sort
reproduces 99% of the time.

Two independent things follow: the quality terms need real weights if they are
meant to matter, and until then the computation can be skipped. `nucleusSolidity`
in `computeRegimeMetrics` reads `best.density` off this object, so check that path
before deleting anything.

---

## 6. Performance: `nodes.indexOf` inside O(E²) loops

`nodeIndexOf` is a linear scan (`:192`). It is called inside doubly-nested edge
loops in: `getCrossingCounts` (`:718–721`, four scans per crossing pair),
`analyzeConflictRegions` (`:902`), `regionCrossingProfile` (`:1301`),
`protectedCrossingVertices` (`:1455`), `countEndpointOutsideCrossings` (`:2475`,
O(E²·n)), `findSeparatingTriangles` (`:3523`), and `cloneGraph` (`:3438`, O(E·n)) —
which is itself called inside inner search loops.

The fix pattern already exists in this file: `analyzeEstablishedRegion` (`:745`)
and `computeRegimeMetrics` (`:3393`) build a `Map` once.

**Correction — this section originally overstated the win.** Measured, replacing
`nodes.indexOf` with a `Map` in `getCrossingCounts` is worth only **~1.2×**
(n=60: 0.68 ms → 0.52 ms; n=150: 3.20 → 2.56, output identical). The reason is
that `indexOf` runs only on pairs that *actually cross*, not on every pair — the
O(E²) `intersect` calls dominate and index-mapping does not touch them. "Linear
scan inside a quadratic loop" was inferred rather than measured.

**Where the real win is: full recounts where incremental would do.**
`simulateAnchorBreakTransfer` calls `intersections()` — a full O(E²) sweep — once
per transfer position, once after the transfer, and once per repair step. For a
~10-vertex component with 6 repairs that is ~18 full recounts per candidate. But
moving one vertex only changes crossings on its incident edges, and
`countEdgeCrossings` already does exactly that at O(deg·E): ~1,000 tests instead
of ~14,000 at n=60, roughly **14×**. Not free — keeping a correct running total
from incremental deltas is the fiddly part, and getting it wrong would corrupt
accept/reject decisions silently. `evaluateMoveDelta` is the existing pattern.

**And since the clock fix, this is a solve-rate lever, not a speed one.** Time
budgets now cap *work done* (see `CONTROLLER_MAP.md`). A faster function buys more
candidates examined per call, which converts directly into solve rate — and
conversely, a controller-level improvement that routes more work to a starved
function will underperform for reasons that have nothing to do with the
controller. That inverts the caveat this section originally carried: search
efficiency is no longer a risk to be benchmarked around, it is the mechanism.

---

## 7. Smaller notes

- `planarGraph` (`:235`) can emit a self-loop when `~~(Math.random()*n) === i`.
  Matches the 2–4 self-loops per graph recorded in `tutte/NOTES.md`.
- `strongImprovement = max(3, ceil(count*0.03))` (`:6807`) governs whether the
  descent pass short-circuits. In the endgame it is always 3, so the pass almost
  never short-circuits there — a fact worth knowing before touching descent.
- `recordCrossingHistory` (`:3009`) stores only *distinct* consecutive counts, so
  `crossingHistory` is not a per-move series and cannot give a rate directly.
- `findFinisherMove` (`:5301`) — "expanded from 5 to match late game" for its
  `count > 15` bail. It has no caller.
- `ENDPOINT_ROOM` (`:2348`) hardcodes an 800×550 px viewport to convert inches to
  coordinates. Correct only if `solver.html`'s viewport still matches.

---

## Suggested order of attack

1. **Fix the misleading comments** (§1) — free, and stops the next reader modelling
   the wrong algorithm.
2. **Make the gates in §2 configurable and measure them**, especially `stuckLimit`,
   which is what actually ends 90v runs.
3. **Check whether `establishedScore`'s quality terms do anything** (§5). If they
   don't, several accept tests are keying off region size alone.
4. **Unify the duplicated constants** (§3), one at a time, each behind a benchmark.
5. **`Map`-ify the hot `indexOf` loops** (§6) — but benchmark, since faster
   searches explore more.

Everything above is measurable against `BENCHMARK_METHODOLOGY.md`. Per the finding
in `ALGO_ARCHIVE.md`, prefer a size where the baseline solve rate is low (85–90v)
so a real effect is large enough to see without fighting seed noise.
