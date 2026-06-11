// Focused Stage 2 benchmark with deterministic graph generation.
// Usage: node benchmark-stage2.js [puzzles=100] [nodes=30] [maxMoves=600] [seed=12345]

const fs = require('fs');
const solver = require('./solver.js');

function seededRandom(seed) {
  let state = seed >>> 0;
  return function() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function runPuzzle(index, nodeCount, maxMoves) {
  const graph = solver.scramble(solver.planarGraph(nodeCount));
  const initialCrossings = solver.intersections(graph.links);
  const state = {};
  const strategies = {};
  const crossingHistory = [initialCrossings];
  const extensionPlans = [];
  let activeExtension = null;
  let solved = false;
  let stopReason = 'move-cap';
  let moves = 0;

  while (moves < maxMoves) {
    const result = solver.solverStep(graph, state);
    if (result.done) {
      solved = true;
      stopReason = 'solved';
      break;
    }
    if (result.stuck) {
      stopReason = 'stuck';
      break;
    }
    if (!result.move) continue;

    moves++;
    strategies[result.move.strategy] = (strategies[result.move.strategy] || 0) + 1;
    crossingHistory.push(result.count);

    const plan = result.move.search && result.move.search.structuralPlan;
    if (result.move.strategy === 'stage2-region-extension' && plan) {
      if (!activeExtension || activeExtension.id !== plan.id) {
        activeExtension = {
          id: plan.id,
          startMove: moves,
          endMove: null,
          startCrossings: plan.startedAtCrossings,
          setupPeakCrossings: result.count,
          bestLaterCrossings: result.count,
          movableVertices: plan.movableVertices,
          projectedCrossings: plan.projectedFinalCrossings,
          completed: false,
          recoveredBelowStart: false
        };
        extensionPlans.push(activeExtension);
      } else {
        activeExtension.setupPeakCrossings = Math.max(
          activeExtension.setupPeakCrossings, result.count);
        activeExtension.bestLaterCrossings = Math.min(
          activeExtension.bestLaterCrossings, result.count);
      }
    }

    if (activeExtension) {
      activeExtension.bestLaterCrossings = Math.min(
        activeExtension.bestLaterCrossings, result.count);
      activeExtension.recoveredBelowStart =
        activeExtension.bestLaterCrossings < activeExtension.startCrossings;
      if (!state.activeStructuralPlan ||
          state.activeStructuralPlan.id !== activeExtension.id) {
        activeExtension.endMove = moves;
        activeExtension.completed = Boolean(
          state.lastStructuralPlan &&
          state.lastStructuralPlan.id === activeExtension.id &&
          state.lastStructuralPlan.status === 'completed');
        activeExtension = null;
      }
    }
  }

  const finalCrossings = solver.intersections(graph.links);
  if (activeExtension) {
    activeExtension.endMove = moves;
    activeExtension.completed = false;
  }
  extensionPlans.forEach(plan => {
    plan.maxSetback = Math.max(0, plan.setupPeakCrossings - plan.startCrossings);
    plan.netRecovery = plan.startCrossings - plan.bestLaterCrossings;
  });

  return {
    puzzle: index + 1,
    solved,
    stopReason,
    moves,
    initialCrossings,
    finalCrossings,
    minimumCrossings: Math.min(...crossingHistory),
    maximumCrossings: Math.max(...crossingHistory),
    maximumSetback: Math.max(...crossingHistory) - initialCrossings,
    strategies,
    extensionPlans,
    extensionPlanCount: extensionPlans.length,
    recoveredExtensionPlans: extensionPlans.filter(p => p.recoveredBelowStart).length,
    completedExtensionPlans: extensionPlans.filter(p => p.completed).length
  };
}

function summarize(results, config, elapsedMs) {
  const solved = results.filter(result => result.solved);
  const failed = results.filter(result => !result.solved);
  const plans = results.flatMap(result => result.extensionPlans.map(plan => ({
    puzzle: result.puzzle,
    solved: result.solved,
    ...plan
  })));
  const recoveredPlans = plans.filter(plan => plan.recoveredBelowStart);
  const successfulMoves = solved.map(result => result.moves);
  const finalCrossings = failed.map(result => result.finalCrossings);
  const strategyTotals = {};
  results.forEach(result => {
    Object.entries(result.strategies).forEach(([strategy, count]) => {
      strategyTotals[strategy] = (strategyTotals[strategy] || 0) + count;
    });
  });

  return {
    timestamp: new Date().toISOString(),
    config,
    elapsedMs,
    summary: {
      solved: solved.length,
      failed: failed.length,
      solveRate: results.length ? solved.length / results.length : 0,
      averageMovesPerSolve: successfulMoves.length
        ? successfulMoves.reduce((a, b) => a + b, 0) / successfulMoves.length : null,
      medianMovesPerSolve: percentile(successfulMoves, 0.5),
      longestSuccessfulSolve: successfulMoves.length ? Math.max(...successfulMoves) : null,
      failedMedianFinalCrossings: percentile(finalCrossings, 0.5),
      extensionPlans: plans.length,
      extensionPlansPerPuzzle: plans.length / results.length,
      completedExtensionPlans: plans.filter(plan => plan.completed).length,
      recoveredExtensionPlans: recoveredPlans.length,
      recoveryRate: plans.length ? recoveredPlans.length / plans.length : null,
      solvedWithExtensionPlan: solved.filter(result => result.extensionPlanCount > 0).length,
      largestRecoveredSetback: recoveredPlans.length
        ? Math.max(...recoveredPlans.map(plan => plan.maxSetback)) : null
    },
    strategyTotals,
    longestSolves: solved.slice().sort((a, b) => b.moves - a.moves).slice(0, 10)
      .map(result => ({
        puzzle: result.puzzle,
        moves: result.moves,
        initialCrossings: result.initialCrossings,
        maximumCrossings: result.maximumCrossings,
        extensionPlanCount: result.extensionPlanCount,
        recoveredExtensionPlans: result.recoveredExtensionPlans
      })),
    largestRecoveredSetbacks: recoveredPlans
      .sort((a, b) => b.maxSetback - a.maxSetback)
      .slice(0, 10),
    results
  };
}

const config = {
  puzzles: Number(process.argv[2]) || 100,
  nodes: Number(process.argv[3]) || 30,
  maxMoves: Number(process.argv[4]) || 600,
  seed: Number(process.argv[5]) || 12345
};

Math.random = seededRandom(config.seed);
const startedAt = Date.now();
const results = [];
for (let i = 0; i < config.puzzles; i++) {
  const result = runPuzzle(i, config.nodes, config.maxMoves);
  results.push(result);
  console.log(
    `${result.puzzle}/${config.puzzles} ` +
    `${result.solved ? 'SOLVED' : result.stopReason.toUpperCase()} ` +
    `${result.moves} moves ${result.initialCrossings}->${result.finalCrossings} ` +
    `extensions=${result.extensionPlanCount} recovered=${result.recoveredExtensionPlans}`
  );
}

const report = summarize(results, config, Date.now() - startedAt);
fs.writeFileSync('benchmark-stage2-results.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
console.log('Wrote benchmark-stage2-results.json');
