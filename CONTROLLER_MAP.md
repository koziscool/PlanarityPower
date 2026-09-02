# SolverController: what it actually does

`SolverController.prototype.step` (`solver.js:7930–8668`) decides every move. This
is a read of it as one piece — the strategy it implements, the state that drives
it, and the places where the logic is inconsistent rather than merely untuned.

Nothing here proposes a change. It is the map.

---

## The strategy in one sentence

**Try ordinary greedy descent; if it has nothing, walk down a list of increasingly
drastic structural interventions, each of which simulates its own outcome and only
commits when the simulation projects an improvement.**

That is a good design. Most of what follows is about where the implementation has
drifted from it.

---

## The ladder

One `step()` call returns at the first rung that produces a move. Rungs marked
**OFF** are disabled by default.

| # | rung | fires when | commits |
|---|---|---|---|
| 1 | `tryPendingStructural` | a structural plan has queued moves | next queued move |
| 2 | `tryPendingFinisher` | a finisher sequence is queued | next queued move |
| 3 | `tryAnchoredShakeup` **OFF** | stall ≥ 30, n ≥ 40 | explode-and-resolve burst |
| 4 | `tryCleanAnchorBreak` | stall ≥ 8 (or ≥ 22 w/ weak nucleus), n ≤ 200 | barrier transfer plan |
| 5 | `tryWideStage1` **OFF** | stall ≥ 8 | one wide-search greedy move |
| 6 | region-compaction | stall ≥ 40, or ≥ 15 when count ≤ 20; **n ≤ 60** | compaction schedule |
| **7** | **`findAdaptiveMinimizeMove`** | **always** | **one greedy move** |
| 8 | contained-triangle | count ≤ 15 | interior solve plan |
| 9 | dominant-barrier | count ≤ 15 | component transfer plan |
| 10 | anchored-centroid | always | one weighted-centroid move |
| 11 | separating-triangle finisher | always (fn self-gates at 12) | component relocation |
| 12 | proven stage2 restart | count ≤ 15 | perturbation |
| 13 | region-extension | count ≤ 80, **n ≤ 60** | group translation |
| — | **`stuckCount++` — "Stage 1 is stuck"** | | |
| 14 | cascade trigger **OFF** | wasted-tail, count ≤ 80 | one move |
| 15 | anchor-break auto | wasted-tail, count ≤ 120, **once per solve** | barrier transfer |
| 16 | high-crossing stage1c | 50 < count ≤ 250, stall ≥ 20, nucleus < 0.25 | group reset |
| 17 | stage1c auto | **n ≤ 25**, count ≤ 60 | group reset |
| 18 | problem-child inversion | count ≤ 20 | **nothing — diagnostic only** |
| 19 | escape | always | one perturbation, ≤ +5 crossings |
| 20 | give up | `stuckCount > stuckLimit` | `{stuck: true}` |

### The single most important structural fact

**Rungs 1–6 run before greedy descent.** On a stall the controller restructures
*without first re-probing whether a descent move exists*. Rung 5 (`tryWideStage1`)
is exactly the "look harder for a plain move before restructuring" step — and it is
**off by default**. So the case its own comment describes, "a move exists, greedy
just couldn't see it," is currently unhandled.

Rung 6 also carries a `timeBudgetMs: 600` search — the most expensive in the file —
and it runs *ahead of* the cheap descent probe. It is latched to once per crossing
minimum, so this is not per-step, but the ordering is cost-inverted.

---

## Two different clocks, easily confused

| | `movesSinceCrossingProgress` | `stuckCount` |
|---|---|---|
| incremented | every step, in `initializeStep`, unless a new best | only at rung 13½, when **no rung produced a move** |
| means | "how long since we beat our best crossing count" | "how many consecutive dead steps" |
| drives | every structural trigger (rungs 3,4,5,6,14,16) | the give-up test only |

A run can have a large `movesSinceCrossingProgress` and `stuckCount === 0`
indefinitely — moves are being made, they just aren't improving on the best. That
is the wasted tail.

**And `stuckLimit` (`:8661`) is what actually ends a run:**

```js
var stuckLimit = count <= 5 ? 500 : count <= 15 ? 200 : 50;
```

At 90v, failures report STUCK at 4–77 crossings. Above 15 crossings the solver
quits after 50 dead steps.

---

## Three incompatible retry policies for the same kind of decision

| idiom | resets when | used by |
|---|---|---|
| `*AttemptedAtCount !== count` | crossing count changes **at all**, up or down | contained-triangle, dominant-barrier, finisher, stage2-restart, region-extension, stage1c, problem-child |
| `*AttemptedAtBestCrossings !== bestCrossingCount` | only when a **new best** is set | compaction, clean-anchor-break, wideStage1, anchoredShakeup, cascade trigger, high-crossing stage1c |
| plain boolean, never reset | never | **anchor-break auto** (`:8379`) — one attempt per solve, ever |

These have very different consequences. The first re-fires freely as the count
oscillates. The second fires once per plateau. The third gives a whole strategy a
single shot per graph. There is no evident reason the three groups differ.

---

## Post-success bookkeeping is inconsistent

After committing a move, rungs clear different subsets of the same three fields.
Verified by reading every reset site in `step()`:

| rung | `stuckCount` | `recentAttempts` | `finisherAttemptedAtCount` |
|---|---|---|---|
| region-compaction (6) | — | — | — |
| adaptive-minimize (7) | ✓ | ✓ | ✓ |
| contained-triangle (8) | ✓ | ✓ | — |
| dominant-barrier (9) | ✓ | ✓ | — |
| anchored-centroid (10) | ✓ | — | ✓ |
| finisher (11) | ✓ | — | — |
| stage2-restart (12) | ✓ | — | — |
| region-extension (13) | ✓ | ✓ | ✓ |
| cascade trigger (14) | ✓ | ✓ | ✓ |
| high-crossing stage1c (16) | ✓ | ✓ | ✓ |
| stage1c auto (17) | ✓ | ✓ | ✓ |
| escape (19) | — | — | — |

`finisherAttemptedAtCount` is the finisher's once-per-count latch. Whether the
finisher gets to retry after a successful move therefore depends on *which rung*
produced that move — a coupling nobody would design on purpose. Region-compaction
clearing nothing means a successful compaction leaves `stuckCount` elevated.

---

## Six different stall thresholds

`8` (clean-anchor-break, wideStage1) · `15` (compaction when count ≤ 20) ·
`20` (wasted-tail detection, high-crossing stage1c) · `22` (clean-anchor-break,
weak-nucleus profile) · `30` (anchored shakeup; also the wasted-tail fallback) ·
`40` (compaction).

All measure the same quantity, `movesSinceCrossingProgress`.

---

## How uphill moves are licensed

Worth stating because it is the controller's real invention. Rungs 6, 8, 9, 12, 13,
15, 16, 17 all permit crossings to *rise*. Each does it the same way:

1. run a bounded, time-budgeted search;
2. simulate the full move sequence plus a cleanup rollout;
3. commit **only** if the projection shows improvement;
4. commit via `beginStructuralPlan` with `protectedVertices` and a `maxSteps`
   budget, so rung 1 drains the sequence and Stage 1 cannot dismantle the
   intermediate geometry mid-flight.

`updateStructuralPlan` (`:4666`) retires a plan on its completion condition or marks
it failed at `maxSteps`. This is why a lone uphill move does not work here without
that scaffolding: nothing else protects the result.

---

## Currently inert

- **Off by default:** anchored shakeup (3), wide Stage 1 (5), cascade trigger (14).
- **Diagnostic only:** problem-child inversion (18) runs a 140 ms search at
  count ≤ 20 every time the count changes, stores the report on `state`, and
  **discards it**. Pure cost in headless runs.
- Sixteen `find*`/`suggest*` functions have no caller at all — see `SOLVER_AUDIT.md` §1.

So on a default headless run, the live ladder is: pending plans → clean-anchor-break
→ compaction → **descent** → contained-triangle → barrier → anchored-centroid →
finisher → stage2-restart → region-extension → anchor-break-once → stage1c ×2 →
escape.

---

## What this suggests, without recommending anything

The design intent is sound and the mechanism for safe uphill moves is genuinely
good. What has drifted:

- the controller does not consistently own applicability (see `SOLVER_AUDIT.md` §2
  on gates duplicated between rung and function);
- retry policy, bookkeeping, and stall thresholds were each chosen locally;
- the ordering is cost-inverted at rung 6, and the one rung meant to re-probe
  descent before restructuring is disabled;
- the give-up rule (`stuckLimit`) has never been tuned at the sizes now of
  interest, and is what ends 90v runs.

Each of those is separately measurable against `BENCHMARK_METHODOLOGY.md`.
