# Algorithm Archive

This documents strategies and approaches that have been tried but are currently disabled or experimental. Kept as "algo memory" for future reference.

> **Maintenance**: Update this file when making algorithmic changes. When disabling a strategy, document why. When trying something new, add it here even if it fails. This lets future sessions quickly recapitulate what's been explored.

## Currently Unused Strategies

### Experimental Strategies (in solver.js, not called from solverStep)

These are fully implemented but not called from `solverStep`:

| Strategy | Purpose | Why Disabled |
|----------|---------|--------------|
| `findBottleneckMove` | Non-fast version, uses full `intersections()` calls | Replaced by `findBottleneckMoveFast` for performance |
| `findBestMove` | Non-fast version, checks ALL nodes | Replaced by `findBestMoveFast` which only checks conflicting nodes |
| `findEdgeSideMove` | Move vertices across edges to resolve same-side conflicts | Sometimes helps, but can be unpredictable. Works for group moves. |
| `findUnblockMove` | When vertex is stuck, move its neighbors instead | Relies on `state.recentAttempts` tracking, complex logic |
| `findTriangleSolveMove` | Find "clean triangles" and solve their interiors | Rarely triggers (clean triangles are uncommon) |
| `findDeclutterMove` | Push yellow vertices toward boundaries to make space | Often hurts more than helps by spreading things out |

### Manual-Only Strategies (in solver.js, buttons only)

These are available as interactive buttons but removed from the auto solver loop:

| Strategy | Purpose | Why Manual-Only |
|----------|---------|-----------------|
| `findCompactMove` | Tighten local clusters of yellow vertices | Was causing solver to get stuck faster; user prefers to trigger manually when appropriate |
| `findRelocateMove` | Move yellow vertices toward their weighted centroid | Allows +3 crossing increase for "reorganization"; too risky in auto mode |
| `findConsolidateMove` | Grow largest geometric cluster by pulling in nearby vertices | Intentionally ignores crossing count; purely structural |
| `findMoveClumpMove` | Translate entire clump as rigid body | Rarely finds improvements; expensive to compute |

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

**solver.js** (~2900 lines) is the single source of truth for all algorithms. It has section headers for navigation:

- `CORE GRAPH FUNCTIONS` - intersection detection, graph generation
- `ANCHOR SCORING` - determines how "fixed" a vertex is  
- `INCREMENTAL CROSSING DETECTION` - fast move evaluation
- `FAST STRATEGIES` - used in main loop (findBestMoveFast, findBottleneckMoveFast)
- `MANUAL-ONLY STRATEGIES` - buttons only (findCompactMove, findRelocateMove, etc.)
- `ESCAPE STRATEGY` - last resort in main loop
- `EXPERIMENTAL STRATEGIES` - not in main loop (findEdgeSideMove, findTriangleSolveMove, etc.)
- `MAIN SOLVER LOOP` - solverStep orchestration
- `CLUMP-BASED STRATEGIES` - findGrowClumpMove (active in loop)
- `INTERACTIVE/UI STRATEGIES` - centroid, local, uncross, wiggle

A modular file split was attempted but had browser dependency issues. Deleted those files; solver.js now has inline documentation instead.

---

*Last updated: March 2026*
*To restore any strategy: it's still in solver.js, just not called from `solverStep`*
