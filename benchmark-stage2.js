// Focused Stage 2 benchmark with deterministic graph generation.
// Usage: node benchmark-stage2.js [puzzles=100] [nodes=30] [maxMoves=600] [seed=12345] [--profile] [--deterministic-clock]

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

function cloneGraph(graph) {
  const nodes = graph.nodes.map(node => [node[0], node[1]]);
  const links = graph.links.map(link => [
    nodes[graph.nodes.indexOf(link[0])],
    nodes[graph.nodes.indexOf(link[1])]
  ]);
  return { nodes, links };
}

function graphSignature(graph) {
  const edges = graph.links.map(link => {
    const a = graph.nodes.indexOf(link[0]);
    const b = graph.nodes.indexOf(link[1]);
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }).sort();
  const positions = graph.nodes.map(node =>
    `${node[0].toFixed(6)},${node[1].toFixed(6)}`);
  return `${positions.join('|')}::${edges.join('|')}`;
}

function generateBatch(puzzleCount, nodeCount, seed) {
  Math.random = seededRandom(seed);
  const graphs = [];
  for (let i = 0; i < puzzleCount; i++) {
    graphs.push(solver.scramble(solver.planarGraph(nodeCount)));
  }
  return graphs;
}

function runPuzzle(index, sourceGraph, maxMoves) {
  const graph = cloneGraph(sourceGraph);
  const initialCrossings = solver.intersections(graph.links);
  const state = {};
  if (process.env.ENABLE_CASCADE_TRIGGER === '1') {
    state.enableCascadeTrigger = true;
  }
  if (process.env.ENABLE_ANCHOR_BREAK_AUTO === '1') {
    state.enableAnchorBreakAuto = true;
  }
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

function ms(value) {
  return Math.round(value * 10) / 10;
}

function formatProfile(profile) {
  const total = profile.intersections.elapsedMs +
    profile.edgeCrossings.elapsedMs;
  const sections = Object.entries(profile.sections)
    .map(([name, section]) => ({
      name,
      calls: section.calls,
      elapsedMs: section.elapsedMs,
      intersectionsMs: section.intersections.elapsedMs,
      edgeCrossingsMs: section.edgeCrossings.elapsedMs,
      deltaMs: section.evaluateMoveDelta.elapsedMs,
      pairTests: section.intersections.pairTests +
        section.edgeCrossings.pairTests
    }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
    .slice(0, 12);

  return {
    crossingWorkMs: ms(total),
    intersections: {
      calls: profile.intersections.calls,
      elapsedMs: ms(profile.intersections.elapsedMs),
      pairTests: profile.intersections.pairTests,
      maxEdges: profile.intersections.maxEdges
    },
    incrementalEdgeCrossings: {
      calls: profile.edgeCrossings.calls,
      elapsedMs: ms(profile.edgeCrossings.elapsedMs),
      pairTests: profile.edgeCrossings.pairTests,
      maxEdges: profile.edgeCrossings.maxEdges
    },
    evaluateMoveDelta: {
      calls: profile.evaluateMoveDelta.calls,
      elapsedMs: ms(profile.evaluateMoveDelta.elapsedMs)
    },
    hottestSections: sections.map(section => ({
      name: section.name,
      calls: section.calls,
      elapsedMs: ms(section.elapsedMs),
      intersectionsMs: ms(section.intersectionsMs),
      edgeCrossingsMs: ms(section.edgeCrossingsMs),
      deltaMs: ms(section.deltaMs),
      pairTests: section.pairTests
    }))
  };
}

const config = {
  puzzles: Number(process.argv[2]) || 100,
  nodes: Number(process.argv[3]) || 30,
  maxMoves: Number(process.argv[4]) || 600,
  seed: Number(process.argv[5]) || 12345,
  profile: process.argv.includes('--profile'),
  deterministicClock: process.argv.includes('--deterministic-clock')
};

if (config.profile) {
  solver.resetProfiler();
  solver.setProfilerEnabled(true);
}

const graphBatch = generateBatch(config.puzzles, config.nodes, config.seed);
const graphSignatures = graphBatch.map(graphSignature);
Math.random = seededRandom(config.seed ^ 0x9e3779b9);
const realDateNow = Date.now.bind(Date);
if (config.deterministicClock) {
  solver.setDeterministicClock(true);
} else if (solver.setDeterministicClock) {
  solver.setDeterministicClock(false);
}
const startedAt = realDateNow();
const results = [];
for (let i = 0; i < config.puzzles; i++) {
  const result = runPuzzle(i, graphBatch[i], config.maxMoves);
  results.push(result);
  console.log(
    `${result.puzzle}/${config.puzzles} ` +
    `${result.solved ? 'SOLVED' : result.stopReason.toUpperCase()} ` +
    `${result.moves} moves ${result.initialCrossings}->${result.finalCrossings} ` +
    `extensions=${result.extensionPlanCount} recovered=${result.recoveredExtensionPlans}`
  );
}

if (config.deterministicClock) {
  solver.setDeterministicClock(false);
}
const report = summarize(results, config, realDateNow() - startedAt);
report.graphSignatures = graphSignatures;
if (config.profile) {
  const profile = solver.getProfilerReport();
  report.profile = profile;
  report.profileSummary = formatProfile(profile);
}
fs.writeFileSync('benchmark-stage2-results.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
if (config.profile) {
  console.log(JSON.stringify(report.profileSummary, null, 2));
}
console.log('Wrote benchmark-stage2-results.json');
