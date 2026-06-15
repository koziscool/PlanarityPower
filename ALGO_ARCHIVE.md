# Algorithm Archive

This documents strategies and approaches that have been tried but are currently disabled or experimental. Kept as "algo memory" for future reference.

> **Maintenance**: Update this file when making algorithmic changes. When disabling a strategy, document why. When trying something new, add it here even if it fails. This lets future sessions quickly recapitulate what's been explored.

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

*Last updated: June 2026*
*To restore a removed strategy, retrieve it from Git history and benchmark it before reconnecting it.*
