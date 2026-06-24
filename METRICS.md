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

## Where each is computed

| metric set | function | live? | file |
|---|---|---|---|
| progress | `computeProgressMetrics` | yes | solver.js |
| story / cascade-state | `createStoryState` + `updateStoryMetrics` | yes (per move) | solver.js |
| cascade onset | `findCascadeOnset` | no (retrospective) | annotate-history.js |

Live wiring: `solver.html` updates story metrics in its `solverStep` wrapper
(stored on `solverState` so the algo can read them next step) and shows a card
row; `interactive.html` replays history through a story-state in `updateAnalysis`
and shows a "Cascade state (live)" panel block.
