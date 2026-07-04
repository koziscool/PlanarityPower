# Algorithm Archive

This documents strategies and approaches that have been tried but are currently disabled or experimental. Kept as "algo memory" for future reference.

> **Maintenance**: Update this file when making algorithmic changes. When disabling a strategy, document why. When trying something new, add it here even if it fails. This lets future sessions quickly recapitulate what's been explored.

## Analytics / Metrics Layer

A derivative-measurement layer was added on top of the solver's objective state to
quantify *why* graphs get stuck (the wasted-tail → cascade story). It does not
change move selection yet, but is computed live and stored on `solverState` so the
algo can read it. See **METRICS.md** for full definitions. Key additions in
`solver.js`:

| function | role |
|----------|------|
| `computeProgressMetrics` | per-frame progress snapshot (clean ratios, largest clean region, near-clean, crossing density, top-concentration). |
| `createStoryState` / `updateStoryMetrics` | real-time causal story metrics: **freeze** (offender-set Jaccard), **dwell** (live wasted-tail length), **crowd**, **trend**, **thaw**, **drop**. |
| `analyzeGraphState` | now also returns `crossingCounts` so the above need no extra crossing pass. |

`annotate-history.js` was refactored to reuse these (offline) and add a
retrospective `findCascadeOnset`. Both card UIs display the story metrics.
Validated finding (n=150, 30v): cascades fire from a *messy* peak reached by going
uphill, are triggered by one offender de-conflicting itself, propagate as a
~9-vertex chain, and the frozen offender set thaws; stuck graphs mostly never
*start* a cascade. Inside/outside is not the trigger mechanism.

`analyze-wasted-tail.js` scans exported solver/turbosolver/interactive JSON,
detects first live wasted-tail points using `freeze`, `dwell`, and `trend`, and
tests current structural tools there without changing the solver. First pass on
the current Downloads corpus (`turbosolver-results.json` + `solver-results.json`,
60 histories, 26 wasted-tail graphs, 59 checkpoints):

| tool | useful checkpoints | solves | avg positive payoff |
|------|--------------------|--------|---------------------|
| `stage1c-reset` | 50/59 (84.7%) | 3 | 4.2 crossings |
| `problem-child-inversion` | 38/59 (64.4%) | 4 | 4.2 crossings |
| `anchor-break-barrier` | 36/59 (61.0%) | 0 | 4.7 crossings |

Interpretation: wasted-tail is a strong deployment gate. `anchor-break-barrier`
is cheap and sometimes high-payoff, but does not yet close solves by itself in
this corpus. `problem-child-inversion` is lower-hit-rate but has direct solves.
`stage1c-reset` is broadest, but many winning candidates accept large temporary
crossing damage, so it should be deployed with stricter damage/payback gates or
kept as a second-line wasted-tail intervention.

`anchor-break-barrier` is the first metrics-gated deployment candidate from this
analysis. The live solver can test it in strong wasted-tail (`dwell`/`freeze` or
long no-new-low proxy), but the automatic hook is opt-in through
`state.enableAnchorBreakAuto` / `ENABLE_ANCHOR_BREAK_AUTO=1`. The first broad
auto hook created churn, so the current experimental gate tests it once per
graph, only below 25 crossings, and commits only zero-damage candidates with a
large immediate crossing reduction or a direct solve. Analyzer metric deltas
still support the idea: positive candidates improved crossings, near-clean
ratio, clean-edge ratio, largest clean region, and crossings-per-dirty-edge
immediately. It is not default solver policy until benchmarked solve rate
improves reliably. On seed `12345`, 50 graphs, 30 vertices, 400 move cap, a
default run with the hook disabled solved 34/50. Two opt-in runs with the
tightened gate solved 39/50 and 41/50, with 36 and 28 anchor-break transfer
moves respectively. That is promising, but not conclusive because solver
randomness and wall-clock bounded searches still change trajectories between
runs even when the graph batch is fixed.

Follow-up cascade-trigger mining found that usable solved wasted-tail histories
usually start their final cascade from an ordinary single-vertex adaptive move,
not from an already-labeled structural tool. The common event is a large
`drop`/`thaw` move that breaks the frozen offender set. In response, the solver
now has an experimental `suggestCascadeTriggerMove()` search: after strong
wasted-tail evidence (`dwell`, `freeze`, flat/upward `trend`, or long no-new-low
proxy), it tests a small set of top/persistent offenders and scores candidate
positions by `drop`, `thaw`, crossing improvement, and short deterministic
Stage 1 rollout.

Initial automatic deployment was rejected. On seed `12345`, 50 graphs, 30
vertices, 400 move cap, enabling the hook solved 40/50 with 115.8 average moves
per solve; disabling it solved 43/50 with 124.6 average moves per solve. The
hook fired only 11 times but changed enough trajectories to reduce solve rate.
It remains exported/available for explicit experiments via
`ENABLE_CASCADE_TRIGGER=1`, but normal solver policy does not call it.

## Removed Strategies

These implementations were removed from `solver.js` during consolidation because
they had no active callers. They remain available in Git history:

| Strategy | Purpose | Why Disabled |
|----------|---------|--------------|
| `findBottleneckMove` | Non-fast version, uses full `intersections()` calls | Replaced by `findBottleneckMoveFast` for performance |
| `findBestMove` | Non-fast version, checks ALL nodes | Replaced by `findBestMoveFast` which only checks conflicting nodes |
| `findEdgeSideMove` | Move vertices across edges to resolve same-side conflicts | Sometimes helps, but can be unpredictable. Works for group moves. |
| `findUnblockMove` | When vertex is stuck, move its neighbors instead | Relies on `state.recentAttempts` tracking, complex logic |
| `findTriangleSolveMove` | Find "clean triangles" and solve their interiors | Rarely triggers (clean triangles are uncommon) |
| `findDeclutterMove` | Push yellow vertices toward boundaries to make space | Often hurts more than helps by spreading things out |
| `findMoveClumpMove` | Translate entire clump as rigid body | Rarely finds improvements; expensive to compute |

### Manual-Only Strategies (in solver.js, buttons only)

These are available as interactive buttons but removed from the auto solver loop:

| Strategy | Purpose | Why Manual-Only |
|----------|---------|-----------------|
| `findCompactMove` | Tighten local clusters of yellow vertices | Was causing solver to get stuck faster; user prefers to trigger manually when appropriate |
| `findRelocateMove` | Move yellow vertices toward their weighted centroid | Allows +3 crossing increase for "reorganization"; too risky in auto mode |
| `findConsolidateMove` | Grow largest geometric cluster by pulling in nearby vertices | Intentionally ignores crossing count; purely structural |

### Stage 1b: Reducing Topological Side Flips
- **What**: After adaptive and anchored-centroid descent are exhausted, test a
  bounded set of degree-2-to-5 conflicting vertices on the opposite side of
  edges between their neighbors, or inside triangles formed by their neighbors.
- **Acceptance**: Strict immediate crossing reduction only.
- **Budget**: At most six ranked candidates and four unique accepted moves per
  Stage 1 run. A successful flip returns control to ordinary Stage 1 descent.
- **Why**: Captures visually obvious "sore thumb belongs across this edge/in
  this enclosure" moves without opening the much larger component-move search.

### High-Crossing Stage 1c: Nucleus Creation
- **What**: In larger graphs (`<=60` vertices) that stall with crossings still
  near/above the ordinary region-extension handoff (`50 < crossings <= 160`),
  try one bounded Stage 1c group reset when the largest clean region is still weak
  (`largestCleanRegion / N < 0.25`) and crossings have not set a new low for at
  least 20 moves.
- **Acceptance**: The short rollout must improve crossings by at least
  `max(8, ceil(0.10 * crossings))`. Temporary immediate damage is allowed up
  to `max(45, ceil(0.35 * crossings))` because the point is to create a better
  current-position state for Stage 1, not to perform a monotone descent move.
- **Execution**: The structural plan now executes the group reset plus the
  deterministic cleanup rollout used by the acceptance simulation. Earlier
  versions accepted on the rollout but only executed the reset, which made the
  projection too optimistic.
- **Why**: 50-vertex failures exposed a new regime: high-crossing stalls with
  almost no clean nucleus, where region extension never fires because the graph
  never reaches the `<=80` crossing gate. On seed `12345`, `20` puzzles,
  `50` vertices, `600` move cap, deterministic clock, this hook moved the sample
  from `11/20` solved to `14/20` solved; failed median crossings dropped from
  `84` to `47`, and failures with no extension plan dropped from `6` to `2`.
- **Caveat**: This is a current-position structural reset, not rollback. It can
  alter trajectories. A follow-up first-five comparison across seeds `12345`,
  `1`, `2`, `3`, and `4` preserved solve count (`14/25` before and after the
  rollout/wider-gate tweak) while reducing residual crossings (`483 -> 325`).
  That is useful regime progress, but not yet a proven solve-rate improvement.

### Anchor-Break Barrier Gate Liberalization
- **What**: The automatic anchor-break barrier search now uses a larger
  structural budget for larger graphs: `count <= 120`, `componentLimit: 40`,
  `barrierLimit: 14`, `cleanupSteps: 24`, `timeBudgetMs: 250`.
- **Why**: 60-vertex failures showed the previous gate (`count <= 80`,
  `componentLimit: 25`) missing textbook anchor-break transfers. In seed
  `12345`, graph 4 had a zero-damage 29-vertex transfer available from
  `81 -> ~56`, but the old gate missed it by both count and component limit.
- **Observed 60v effect**: On `node benchmark-stage2.js 5 60 800 12345
  --deterministic-clock`, the solve count stayed `3/5`, but the failure profile
  improved sharply: residuals changed from `96, 81` to `19, 7`, graph 4 solved,
  and the long successful graph 3 dropped from `508` moves to `291`.
- **Rejected variant**: Raising the default count ceiling further to `160`
  converted one high-crossing seed-2 failure, but regressed seed `12345` from
  `3/5` to `2/5` by turning solved graphs into near-endgame misses. Keep `160`
  as an experiment/conditional idea, not default policy.

## Historical Approaches (No Longer in Code)

### "Repel" Strategy
- **What**: Push vertices away from each other to create space
- **Result**: Removed entirely. Spreading vertices out made things worse by creating longer edges.

### Early Escape Strategy
- **What**: Pure random repositioning when stuck
- **Result**: Refined to `findEscapeMove` with "sore thumb" targeting (long edges + low anchor) and catastrophic move prevention (-5 threshold)

### Grid Search at High Counts
- **What**: `findGridMove` originally ran at any crossing count
- **Result**: Now limited to count <= 40. At high counts, fast strategies are more efficient.

### Declutter in Auto Loop
- **What**: Automatically push yellow vertices toward boundaries
- **Result**: Removed from auto loop. The "making space" concept evolved into manual Compact/Relocate buttons. User insight: "making space" is context-dependent.

### Compact Every N Moves
- **What**: Trigger `findCompactMove` every 100 moves automatically
- **Result**: Removed. User found it triggered at wrong times. Better as manual control.

## Key Insights from Interactive Sessions

These observations from human solving sessions informed algorithm design:

### "Sore Thumb" Vertices
Low-anchor vertices with long edges stick out visually and are often the key to progress. Implemented in `anchorScore()` and used by `findEscapeMove`.

### Edge Side Analysis
When multiple conflicts involve the same edge, and conflicting vertices are all on one side, moving them to the other side resolves everything. Partially implemented in `findEdgeSideMove` but not reliable enough for auto use.

### Clean Triangles
A triangle with no external crossings forms an independent subproblem. Implemented in `findTriangleSolveMove` but rarely applicable.

### Group Moves
Moving multiple related vertices together (e.g., an edge chain) is often necessary. `findEdgeSideMove` attempts this but is fragile.

### "Barrier Edge" Awareness  
Human insight: when moving vertices, consider which edges they need to cross and pack efficiently around those barrier edges. Not yet implemented algorithmically.

### Strategic Compacting
Human insight: "packing as you go" around barrier edges should be integrated into solving, not a separate cleanup phase. Current implementation keeps compact/relocate as separate manual tools.

## Proposed but Not Implemented

### Three-Stage Solver Architecture
1. **Stage 1 (Minimize Crossings)**: Current algo is strong here - single-move optimizations
2. **Stage 2 (Maximize Yellow Dots)**: Focus on making vertices conflict-free. Requires 2-3 move combinations.
3. **Stage 3 (Maximize Clumps)**: Consolidate graph structure. Requires 3-8 move combinations.

**Challenge**: Stages 2 & 3 need intelligent multi-move search space narrowing.

### Cyclic Solver Pattern
Proposed flow: 1 → 2 → 3 → 1 → 2 → 3...
- Stages 2 & 3 may temporarily increase crossings for better structure
- Stage 1 re-optimizes from improved position

---

## Codebase Structure

**solver.js** is the single source of truth for active algorithms. `interactive.html`
is the lead human-in-the-loop workflow. `solver.html` and `benchmark.js` evaluate
the same shared `solverStep()` implementation.

Interactive also exposes two diagnostic APIs:

- `analyzeGraphState()` reports crossings, clean graph-connected regions,
  crossing concentration, recent progress, and repeated vertices.
- `minimizeStep()` applies one strictly crossing-reducing geometric move without
  invoking structural, escape, clump, or zero-gain strategies.

The default Stage 1 descent uses `findAdaptiveMinimizeMove()`. It ranks a bounded
set of crossing-heavy vertices, tries deterministic centroid/local positions
first, then spends a small random budget. It replaces crossing-count-based
early/mid/late routing in the shared `solverStep()` path.

The experimental `findBarrierMove()` remains exported for direct testing but is
not called by the default solver loop. Its exhaustive two-vertex search caused
severe stalls and is not yet a justified structural operation.

The first separating-triangle slice uses `findSeparatingTriangles()` and
`suggestStage2Move()`. Separating triangles are treated as Jordan curves even
when their boundary is currently crossed; those crossings are evidence that an
attached component may be on the wrong side.

The active conservative Stage 3 slice uses
`findSeparatingTriangleFinisher()` when 12 or fewer crossings remain. It moves
only a small component of at most six vertices when that component's own edges
cross a separating-triangle boundary and relocating the complete component
directly reduces crossings. The component positions are executed consecutively
so an awkward intermediate vertex move cannot be interrupted by Stage 1. This
handles easy cases such as moving component `[8,17]` inside triangle
`[2,12,16]`.

`suggestContainedTriangleSolve()` handles the complementary case where the
topology is already correct: a crossing-free separating triangle contains every
remaining crossing in one attached interior component. The solver discards the
exterior from the search, holds the separator fixed, and solves only the
induced interior subgraph. Interior positions must remain distinct and inside
the triangle. Deterministic restarts may project temporary crossing increases,
but the complete sequence executes only when the full graph is projected to
reach zero. The active limit is ten interior vertices and 15 crossings. This
solves the graph-26 case inside separator `[1,3,26]`.

Inside-triangle placement uses a bounded deterministic search over interior
barycentric positions, three compact scales, and four rotations. This handles
narrow regions where the topological side choice is clear but placing the
component at the triangle centroid still creates crossings. The expanded search
runs only for the near-solved finisher, only on components of at most six
vertices, and only once per local minimum. Choosing sides for large attached
components remains future work.

When five or fewer crossings remain and no direct component relocation works,
the active finisher may test one setup move on a vertex belonging to a current
crossing edge. The setup may add at most three crossings and is accepted only
when a subsequent separating-triangle relocation plus at most three
deterministic Stage 1 cleanup moves is projected to solve the graph. Active
solver runs allow at most two of these approximately 100 ms lookahead searches
per graph.

`suggestDominantBarrierTransfer()` handles another conservative Stage 3 case:
one crossed edge accounts for at least half the remaining crossings and has a
small complete geometric side. It tests coherent translations of that side,
records directional anchor support/conflict, and executes only when bounded
deterministic cleanup projects a complete solve.

The active suggestion-only Stage 2 slice uses `suggestStage2Restart()`. It
examines at most three crossing-heavy vertices, generates at most eight direct
edge-crossing jumps or translations of both endpoints of a directly crossing
edge, and evaluates each with at most eight deterministic simulated Stage 1
moves under a 75 ms wall-clock budget. Interactive previews a strictly
productive bounded restart before the user explicitly applies it.

Low-degree local enclosure candidates now run before the incidence-based
fallback. For conflicting degree-3-to-5 vertices, Stage 2 tests placement inside
triangles formed by mutually adjacent neighbors and side flips across
neighbor-neighbor edges when the vertex lies opposite most remaining neighbors.
These candidates matched the visually obvious "outlying vertex belongs on the
other side" pattern substantially more often than high-incidence targeting.

`analyzeGraphState()` also reports established-region diagnostics for each
graph-connected clean region. Region size is measured in vertices, not pixels.
Geometry terms report internal/boundary edge counts, internal density,
edge-length regularity, nearest-vertex visibility relative to edge length,
equilateral-style triangle quality, and dandelion quality around internal
degree-7+ vertices. These are diagnostic only. In particular, a large region
with low visibility or narrow triangles is a possible dilation candidate rather
than evidence that further compaction is desirable.

`suggestRegionReorganizationMove()` is a manual Interactive experiment used by
the Compact button before the older geometric compactor. It moves one clean,
low-boundary-anchor, non-dandelion vertex toward its internal clean neighbors.
The move must preserve crossing count, reduce internal edge length, and retain
minimum local visibility. Automatic periodic and local-minimum deployment were
tested and rejected because they added runtime without a consistent solve-rate
gain.

`suggestRegionCompactionPlan()` is the first region-scale compaction experiment.
Interactive exposes it through separate Find/Apply Compaction Plan controls; it
is not called by the automatic solver. The planner treats the strongest current
clean region as a known planar embedding and builds a compact in-place target.
Exact affine targets receive small local adjustments that preserve internal
planarity while restoring recognizable local triangle relationships. The move
scheduler builds a connected compact core, prefers frontier vertices supported
by already placed neighbors, and enters repair mode when recent moves introduce
crossings through protected internal edges. Interactive applies and logs every
scheduled vertex move separately. Full-graph boundary crossings may increase
temporarily, but the completed target must restore the protected region.

The shared solver makes one conservative automatic compaction attempt after 40
moves without improving its best crossing count. The initial automatic
eligibility floor is an eight-vertex region on graphs of at most 60 vertices.
The complete schedule executes as an uninterrupted structural plan, then
returns control to Stage 1. A new best crossing count permits a later attempt;
the same stalled minimum is attempted only once.

`suggestSeparatorReshape()` is a diagnostic-only Stage 2 candidate ranker. For
a small component crossing a separating triangle boundary, it tests moving one
triangle vertex in the direction that expands the separator around the
component. It ranks candidates using boundary-crossing removal, resolved
straddling, established-region growth, clean-vertex growth, crossing change,
and a preliminary anchor-disruption penalty. Interactive reports its best
candidate but does not enable automatic application.

`suggestProblemChildInversions()` is a diagnostic-only Stage 2 candidate
ranker for the case where the solver keeps working around a troublesome vertex
without changing its relevant topological side/sector. It ranks
crossing-involved vertices, samples single-vertex placements hugging each
adjacent reference vertex from multiple side sectors, and evaluates the best
few with a short deterministic Stage 1 rollout. This is meant to expose moves
like "v14 needs to hug outside v0" or "cheap problem child moves outside/inside
a reference structure." Solver exports include the last report as
`finalDiagnostics.lastProblemChildInversionSearch`; Interactive displays it
from the Stage 2 suggestion button. The automatic solver records the diagnostic
near the stuck boundary but does not execute it yet.

`analyzeGraphState()` partitions current crossing events into unresolved
conflict regions. Events are grouped when they share vertices, or when nearby
events touch through an abstract graph edge. Each region reports its crossing
vertices, crossing edges, nearby non-crossing boundary vertices, and geometric
bounds. This supports the isolation-phase diagnosis without changing solver
behavior.

Conflict-region diagnostics also report suggestion-only directional plans.
Within one conflict region, crossing vertices are grouped when their estimated
cheap outward directions agree. High-congestion groups are labeled dilation
plans; other aligned groups are labeled directional-group plans. They report
movable and protected vertices, direction, anchor estimate, and crossing
incidence, but do not execute.

The solver now has reusable structural-plan state. A plan records its objective,
movable/protected vertices, optional direction or separator, completion
condition, and executed step count. The first active use is deliberately
conservative: after Stage 1, Stage 1b, and the existing finisher fail at 15 or
fewer crossings, the solver may automatically commit a bounded Stage 2 restart
only when its deterministic rollout projects zero crossings. Partial-progress
restarts remain suggestion-only.

The second active structural-plan use is a bounded region-extension planner.
After Stage 1, Stage 1b, the finisher, and the proven-solve restart fail, graphs
of at most 60 vertices and 80 crossings may test up to five compatible-anchor
directional groups at three translation distances. Each candidate receives at
most eight simulated Stage 1 cleanup moves under an approximately 110 ms
budget. A plan may temporarily add crossings, but it executes automatically
only when the rollout lowers crossings and clearly grows the largest clean
region, increases clean vertices, or shrinks the largest conflict region.
Interactive Diagnosis reports the last search and the accepted plan's
structural deltas. Both Interactive and Solver use this shared behavior.

TurboSolver retains every geometry snapshot after a puzzle first reaches 20
crossings. Earlier snapshots remain sparse. This makes late Stage 2/3 sequences
and temporary setbacks fully replayable without bloating early-game batch logs.
TurboSolver also accepts and exports a deterministic seed. Runs using the same
seed and configuration reproduce graph generation and solver random choices, so
solve-rate comparisons measure code changes rather than different random batches.

- `CORE GRAPH FUNCTIONS` - intersection detection, graph generation
- `ANCHOR SCORING` - determines how "fixed" a vertex is  
- `INCREMENTAL CROSSING DETECTION` - fast move evaluation
- `FAST STRATEGIES` - used in main loop (findBestMoveFast, findBottleneckMoveFast)
- `MANUAL-ONLY STRATEGIES` - buttons only (findCompactMove, findRelocateMove, etc.)
- `ESCAPE STRATEGY` - last resort in main loop
- `MAIN SOLVER LOOP` - solverStep orchestration
- `CLUMP-BASED STRATEGIES` - findGrowClumpMove (active in loop)
- `INTERACTIVE/UI STRATEGIES` - centroid, local, uncross, wiggle

A modular file split was attempted but had browser dependency issues. Deleted those files; solver.js now has inline documentation instead.

---

Interactive mode intentionally supports pausing the shared solver before
Stage 2/escape so a user can intervene. This is configuration of the shared
solver, not a separate algorithm chain.

### June 2026 compaction + region-extension tune-up

Observed across four 30-vertex failure-graph manual solves: every productive
manual phase combined coherent directional translation of an 8-15 vertex group
with spread reduction; unlocks frequently happened at low crossings (5-15) that
the prior solver hit before any structural function could fire.

Changes applied:

- `suggestRegionCompactionPlan`: enabled translation. Previously hardcoded to
  `directions = [[0,0]]` with `distances = [0]`, so compaction only tightened
  in place. Default is now cardinal sweep with `distances = [0.12, 0.2]`. Time
  budget bumped 320 → 600 ms.
- Compaction call-site (`solverStep`): `minRegionSize` 8 → 5 to let smaller
  clean regions seed compaction. Added an earlier trigger when crossings ≤ 20
  and `movesSinceCrossingProgress ≥ 15`, alongside the existing ≥ 40 trigger.
- `suggestRegionExtensionPlan`: `maxGroupSize` 6 → 12, `cleanupSteps` 8 → 16,
  `damageLimit` floor 8 → 15 and multiplier 0.6 → 0.8, `distances` expanded
  with 0.3 and 0.45 to match observed manual translation magnitudes. Call-site
  time budget 110 → 200 ms.
- `suggestDominantBarrierTransfer`: barrier-candidate filter floor lowered from
  `Math.max(2, ...)` to `Math.max(1, ...)`. The prior floor of 2 excluded the
  unambiguous single-crossing case where one edge IS the dominant barrier by
  definition (100% of crossings). Manual play on graph 16 (seed 88881) showed
  the textbook pattern: one crossing, one 5-vertex side, translate across.

### June 2026 cache-invalidation after compaction (REVERTED)

Tried: in `updateStructuralPlan`, when a `region-compaction` plan completes,
invalidate the count-based caches for the downstream structural strategies
(`regionExtensionAttemptedAtCount`, `barrierTransferAttemptedAtCount`,
`containedTriangleAttemptedAtCount`, `finisherAttemptedAtCount`). Motivation:
graph 47 (seed 55599) showed compaction running 12 moves and finishing at 10
crossings, after which `stage2-region-extension` never fired because the
count-based cache rejected re-attempt at the same crossing count.

Result on seed 55599: solve rate dropped 37/50 → 32/50. Graph 47 recovered
(targeted fix worked) but 7 graphs newly failed (9, 16, 20, 21, 26, 27, 43).
**Churn count went 1 → 9**, the signature of structural strategies firing
repeatedly post-compaction, committing candidates, and unwinding. Several
newly-failed graphs ended at very low residual (graph 13 at 1, graph 21 at 3),
consistent with overshoot from extra structural attempts.

Reverted. The cache invalidation as written was indiscriminate — it fired on
every compaction completion regardless of whether the post-compaction geometry
was meaningfully different to the structural strategies. Future direction: the
Faraday-cage framing is still correct (compaction creates the conditions for
extension and triangle triage), but the trigger needs to be more selective —
probably driven by the post-compaction geometry itself (e.g. a new clean
separating triangle appeared) rather than by the compaction completion event.

### June 2026 barrier-transfer cap loosening

Observed on graph 50 (seed 55599): textbook barrier-edge case, all 5 crossings
on edge 20-21, but `suggestDominantBarrierTransfer` never fired. Diagnosis: the
function defines `component` as every vertex on one side of the barrier
(excluding endpoints) and rejects if `component.length > maxGroupSize`. Graph 50
splits 13/15 across the diagonal — both sides exceed the prior cap of 10.

Changes at the solverStep call-site:

- `maxGroupSize` 10 → 16. Covers up-to-30-vertex graphs where the barrier splits
  the canvas more evenly than the original "small wrong-side group" cases.
- `cleanupSteps` 20 → 30. Translating 13+ vertices across a barrier produces
  more transitional disorder than 5-vertex flips; cleanup needs more budget.
- `timeBudgetMs` 140 → 250. More component × placement combinations to test.

The internal "flip-entire-side" design remains: still does not consider
sub-components. If raising the cap turns out to find solves on graph 50 but
regresses elsewhere, the next iteration is smarter subset selection (start with
vertices whose neighborhoods straddle the barrier, grow by anchor compatibility).

### June 2026 Stage 1 inner-loop trade: fewer offsets, more candidates

`findAdaptiveMinimizeMove` was testing 8 vertices × (2 centroid + 8 cardinal/diagonal
offsets) = 80 deterministic positions per step. The 8 fixed offsets at step 0.04
had diminishing returns — after the centroid + half-centroid tests, eight tiny
nearby perturbations on the same vertex rarely add information.

Changes:

- `candidateLimit` 8 → 12 (~50% more ranked vertices considered per step).
- Offsets cut from 8 cardinal/diagonal directions to 3 evenly-spaced unit
  vectors at 0°, 120°, 240°. Cleaner symmetric coverage, less redundancy.

Per-step deterministic test count: 12 × (2 + 3) = 60 (down from 80, ~25%
cheaper). Hypothesis: more shots at finding the productive vertex outweigh the
lost redundant local probes around already-considered vertices. Stage 1 stays
anchor-free in the inner loop by design — anchor scoring stays in
`findAnchoredCentroidMove` and downstream fallbacks.

Caveat: pulling lower-crossings vertices into the candidate pool may cause
descent to fail the strong-improvement target more often, falling through to
fallbacks earlier. That's a feature, not a bug — pairs with planned
opportunistic-compaction fallback work.

### June 2026 Stage 1 two-list split: cheap main list, periodic big list

`findAdaptiveMinimizeMove` was refactored to test two disjoint candidate lists
per call. Motivation: at 80v, runs across seeds 25–30 showed `strongImprovement`
early-exit firing only ~27% of the time, so candidate-list size directly drove
runtime. Eyeballing also suggested longer candidate lists produced better moves
— but high-crossings high-degree vertices kept hogging the top of the ranking
even when their crossings are a consequence of neighbor positions, not their
own position.

Shape:

- **Main list** — top 18 by score (`crossings*2 + crossings/degree -
  repeatPenalty`), excluding the big-list slice. Cheap probe per candidate:
  centroid + half-centroid + 3 local directions + 1 random sample. Strategy
  tags `adaptive-centroid`, `adaptive-centroid-half`, `adaptive-local`,
  `adaptive-random`.
- **Big list** — top 12 by the same score. Expensive probe: centroid +
  half-centroid + 8 local directions + 5 random samples. Fires every 8th call
  (the other 7 use the main list). Strategy tags `big-centroid`,
  `big-centroid-half`, `big-local`, `big-random`.
- **Lists are disjoint per call** — the same ranked list is sliced into the
  two; vertices float between them as their crossings change across moves.
- **Random angle θ** — one uniform-random angle drawn per call, used by both
  lists for the local-direction probes (`θ + k * 2π/N`). Counters de-aliasing
  across consecutive calls on candidates that didn't move.
- **Counter** — `state.bigListCounter` increments each main-list call, resets
  to 0 after a big-list call OR after any short-circuit (strongImprovement
  cleared).

Per-call worst-case cost: main list 18 × 6 = 108 tests; big list 12 × 18 =
216 tests. Averaged over a 9-call cycle: ~120/call, comparable to the prior
12 × 10 = 120/call.

Refactor split out a shared `runDescentPass(ctx, candidates, spec)` helper so
both lists use the same testPosition/oscillation/bounds logic with different
probe specs. Also added `state.adaptiveStatsBuffer` as a rolling buffer (last
100 calls) of `{kind, candidates, positionsTested, foundMove, improvement,
crossingsBefore}` so we can audit firing cadence and big-list utility.

### June 2026 topology-cache refactor (REVERTED)

Profiling showed many repeated `graph.nodes.indexOf(...)` calls, so we tested
a behavior-preserving topology cache for immutable graph structure: node index
map, link endpoint indices, incident edges, neighbor lists, and adjacency.
The cache deliberately did not store crossing state because crossings depend
on coordinates and must be invalidated after every vertex move.

Result: not worth keeping in the 30-vertex benchmark. The cache removed direct
`graph.nodes.indexOf(...)` calls, but the cost of building and consulting cache
objects, especially inside short-lived simulation clones, outweighed the saved
linear scans at this graph size.

Benchmarks on seed `12345` after the stage-gating/compaction tuning:

- Before topology cache: `50 x 30`, cap `400`, about `61.2s`, `34/50` solved.
- Map-based topology cache: about `66.4s`, `33/50` solved.
- Clone-seeded topology cache: about `92.4s`, `33/50` solved.
- 20-graph smoke after self-loop fixes: `36.0s`, `14/20` solved.

The first cache version also changed behavior around self-loop neighbors:
the original `getNeighbors()` preserved self-loop neighbors, while the cache
initially dropped them. Restoring that behavior still did not recover runtime.

Reverted executable cache usage. Remaining future direction, if this is
revisited: focus on a narrower cache for large-graph-only paths or a crossing
matrix/incremental invalidation design where the asymptotic win is large enough
to pay for cache maintenance.

### June 2026 scalar intersection primitive

Refactored the shared `intersect(a,b)` primitive to avoid allocating temporary
2D vector arrays on every segment-pair test. The public behavior is intended to
stay the same: shared-endpoint segments still return true at the primitive
level, and the same `1e-6` parametric epsilon is used for strict interior
crossings. Higher-level loops still skip shared-endpoint pairs where appropriate.

Reason: profiling consistently showed crossing work dominating runtime. Unlike
the reverted topology cache, this is a narrow local refactor in the core hot
primitive rather than a persistent graph-state abstraction.

### June 2026 benchmark fixed-graph batches

`benchmark-stage2.js` now matches TurboSolver's generation model: it seeds the
RNG, generates the complete graph batch up front, snapshots graph signatures,
then solves clones of those graphs. Solver randomness uses a separate derived
seed (`seed ^ 0x9e3779b9`) so code changes that consume different random
counts during graph 1 do not change graph 2's initial puzzle.

For strict Node A/B tests, pass `--deterministic-clock`. This replaces
`Date.now()` during solving with a deterministic counter so structural-search
time budgets do not vary with machine load or JIT timing. Normal benchmark
runs still use real wall-clock budgets by default.

Before this, the Node benchmark generated and solved each graph sequentially
from one global RNG stream. That made code-version A/B comparisons noisy:
any solver change that consumed a different number of random values could
change every later generated graph. TurboSolver was already safer here because
it creates all puzzles before `Run` starts solving.

### June 2026 deterministic solver clock

The solver now has an internal deterministic clock (`setDeterministicClock`)
used by structural-search time budgets. Browser pages expose it as a checkbox in
`solver.html`, `interactive.html`, and `turbosolver.html`; Node benchmark uses
the same mechanism for `--deterministic-clock`. UI timestamps, animation timing,
and profiler timing still use real time. The deterministic clock increments one
logical millisecond per solver clock read, so candidate searches get reproducible
budgets independent of browser load or headless/runtime differences.

Current reproducible baseline:

```bash
node benchmark-stage2.js 50 30 400 12345 --deterministic-clock
```

Result: `39/50` solved, median solved moves `97`, average solved moves `125.36`.
This is the apples-to-apples baseline for metric and algorithm comparisons.

### June 2026 rollback to first-cut perf baseline

After the fixed-batch benchmark exposed that later comparisons were noisy, we
rolled back the later solver-policy tuning and kept the first-cut hot-path
refactors plus benchmark tooling. Specifically, automatic compaction returned
to the earlier broad search settings (`600ms`, `12` cleanup steps, default
scale/distance candidates), and the added readiness gates around dominant
barrier transfer and region extension were removed.

Kept: scalar `intersect()`, shared-endpoint skips in crossing loops, the simple
incident-edge cache, incremental escape scoring, profiler hooks, and fixed-batch
benchmark support. This makes the next A/B cycle compare from the last clearly
defensible performance point instead of from the experimental late-policy mix.

### June 2026 edge-length diagnostics

Added graph-quality diagnostics for edge length by degree. These are display
metrics only, not auto-solver policy. `analyzeGraphState()` now reports global
edge average, median, max/median ratio, average log edge length over edges,
average per-vertex incident log edge length, and per-degree bucket summaries
(`1`, `2`, `3`, `4`, `5`, `6-8`, `9+`) for average incident length, average
incident log length, average max incident length, and max incident length
relative to graph median.

Motivation: manual Stage 1c reset examples suggest productive grouped moves
often reduce stretched incident edges, especially the worst incident edge,
even when immediate crossing count temporarily increases. Degree buckets are
kept separate because low-degree vertices and high-degree dandelion centers
have different geometric baselines. Aggregated graph-relative changes are still
useful within the same graph because vertex degrees are fixed.

Open: cadence of every-8 is a guess; needs tuning against `adaptiveStatsBuffer`.
The big list's utility is the empirical question — earlier finding was that
high-degree-vertex moves are usually unproductive, but the richer probe set
(8 directions + 5 random) might recover the rare profitable case.

**Status (June 2026): big list currently disabled.** First run showed clear
30v turbo regression — at small scale the disjoint split starves the main
list, since most or all crossed vertices end up in the big list. Bigger
graphs showed structural improvement but solve-rate didn't beat the prior
baseline. Reverted to single main list (top 18 from full ranked pool, cheap
probe spec, random θ retained) while we evaluate scale-aware sizing. The
`runDescentPass` helper and big-list spec stay in place for re-enable.

### June 2026 Stage 1c reset hook

Added a conservative automatic Stage 1c reset hook before escape moves. It is
currently limited to small graphs (`n <= 25`, crossings `<= 60`) and fires only
after ordinary Stage 1 descent has stalled. The hook tries small geometric
groups, allows temporary crossing damage, then scores whether deterministic
Stage 1 rollout pays that damage back with net improvement.

Interactive's `pauseBeforeEscape` still pauses before this hook, so the normal
human-in-the-loop workflow remains inspectable. TurboSolver and Solver use the
hook automatically because they run without that pause.

The Stage 1c evaluator uses fixed-angle, zero-random-sample Stage 1 probes and
rollouts. That is intentional: the normal solver may still use randomness, but
candidate evaluation for this hook needs to be repeatable enough for A/B testing
and for comparing against manual miss logs.

### June 2026 anchor-break barrier diagnostic

Added an inspectable Stage 2 diagnostic for barrier transfers with a local
anchor break. This is based on cases where a dominant barrier edge remains, but
the movable structure is not a single crossing endpoint. Instead, the relevant
constraint chain terminates in a weak/slack vertex, so the whole small chain can
be transferred across the barrier.

The first implementation detects crossing edges against candidate barrier edges,
builds the same-side connected component from the crossing endpoints, orders the
component from nearest-to-barrier outward toward the anchor break, and proposes
target-side positions using already-transferred/target-side neighbors. It is
currently surfaced through Interactive's Stage 2 suggestion path, not automatic
solver policy.

*Last updated: June 2026*
*To restore a removed strategy, retrieve it from Git history and benchmark it before reconnecting it.*
