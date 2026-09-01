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

function rounded(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(digits)) : value;
}

function summarizeSearchReport(report) {
  if (!report) return null;
  const best = report.best || null;
  return {
    type: report.type || null,
    candidatesTested: report.candidatesTested || 0,
    elapsedMs: rounded(report.elapsedMs || 0, 1),
    timedOut: Boolean(report.timedOut),
    hasBest: Boolean(best),
    bestType: best && (best.type || best.strategy || null),
    bestFinalCrossings: best && best.finalCrossings !== undefined
      ? best.finalCrossings : null,
    bestImmediateCrossings: best && best.immediateCrossings !== undefined
      ? best.immediateCrossings : null,
    bestImmediateDamage: best && best.immediateDamage !== undefined
      ? best.immediateDamage : null,
    bestComponentSize: best && best.component ? best.component.length : null,
    bestReason: best && (best.reason || best.objective || null)
  };
}

function captureMetricSnapshot(graph, solverState, metricState, move, strategy) {
  const analysis = solver.analyzeGraphState(graph, metricState.analysisState);
  const progress = solver.computeProgressMetrics(graph, analysis);
  const story = solver.updateStoryMetrics(
    graph, metricState.storyState, analysis.crossingCounts, analysis.crossings);
  const regime = solver.computeRegimeMetrics(
    graph, analysis, story, metricState.regimeState);
  const topOffenders = (analysis.crossingConcentration || [])
    .slice(0, 5)
    .map(item => ({
      index: item.index !== undefined ? item.index : item.vertex,
      crossings: item.crossings,
      degree: item.degree
    }));

  return {
    move,
    strategy: strategy || null,
    crossings: analysis.crossings,
    cleanVertices: analysis.cleanVertices,
    cleanRatio: rounded(analysis.cleanRatio),
    largestCleanRegion: analysis.largestCleanRegion,
    progress: rounded(progress.progress),
    nearCleanRatio: rounded(progress.nearCleanRatio),
    cleanEdgeRatio: rounded(progress.cleanEdgeRatio),
    topCrossingShare: rounded(progress.topCrossingShare),
    freeze: story ? rounded(story.freeze) : null,
    dwell: story ? story.dwell : null,
    crowd: story ? story.crowd : null,
    trend: story ? story.trend : null,
    thaw: story ? story.thaw : null,
    drop: story ? story.drop : null,
    bulkReduction: regime ? rounded(regime.bulkReduction) : null,
    nucleusBuilding: regime ? rounded(regime.nucleusBuilding) : null,
    nucleusFraction: regime ? rounded(regime.nucleusFraction) : null,
    nucleusSolidity: regime ? rounded(regime.nucleusSolidity) : null,
    nucleusGrowth: regime ? rounded(regime.nucleusGrowth) : null,
    boundaryConcentration: regime ? rounded(regime.boundaryConcentration) : null,
    edgeLengthSlack: regime ? rounded(regime.edgeLengthSlack, 2) : null,
    movesSinceCrossingProgress: solverState.movesSinceCrossingProgress || 0,
    stuckCount: solverState.stuckCount || 0,
    activeStructuralPlan: analysis.activeStructuralPlan,
    lastStructuralPlan: analysis.lastStructuralPlan,
    topOffenders
  };
}

function searchDiagnostics(state) {
  return {
    lastRegionExtensionSearch:
      summarizeSearchReport(state.lastRegionExtensionSearch),
    lastCompactionSearch:
      summarizeSearchReport(state.lastCompactionSearch),
    lastAnchorBreakBarrierSearch:
      summarizeSearchReport(state.lastAnchorBreakBarrierSearch),
    lastBarrierTransferSearch:
      summarizeSearchReport(state.lastBarrierTransferSearch),
    lastContainedTriangleSearch:
      summarizeSearchReport(state.lastContainedTriangleSearch),
    lastProblemChildInversionSearch:
      summarizeSearchReport(state.lastProblemChildInversionSearch),
    lastCascadeTriggerSearch:
      summarizeSearchReport(state.lastCascadeTriggerSearch),
    lastStage1cSearch:
      summarizeSearchReport(state.lastStage1cSearch)
  };
}

function classifyFailure(result) {
  const buckets = [];
  const finalMetrics = result.finalMetrics || {};
  const final = result.finalCrossings;
  const escapeMoves = (result.strategies['escape-random'] || 0) +
    (result.strategies['escape-boundary'] || 0) +
    (result.strategies['escape-centroid'] || 0);

  if (final <= 15) buckets.push('near-endgame');
  if (final >= 50) buckets.push('high-crossing-stall');
  if (result.extensionPlanCount === 0) buckets.push('no-extension-fired');
  if (result.extensionPlanCount > 0 && final > 0) {
    buckets.push('extension-fired-but-not-enough');
  }
  if (finalMetrics.dwell >= 20 && finalMetrics.freeze >= 0.88 &&
      finalMetrics.trend >= -2) {
    buckets.push('wasted-tail');
  }
  if (escapeMoves >= Math.max(20, result.moves * 0.25)) {
    buckets.push('random-escape-heavy');
  }
  if (finalMetrics.nucleusFraction !== null &&
      finalMetrics.nucleusFraction < 0.25 && final >= 50) {
    buckets.push('weak-nucleus');
  }
  if (finalMetrics.boundaryConcentration !== null &&
      finalMetrics.boundaryConcentration >= 0.5 && final > 0) {
    buckets.push('boundary-concentrated');
  }
  return buckets.length ? buckets : ['uncategorized'];
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
  // Anchored shakeup is OFF by default (kept in-tree pending a refactor).
  // Enable it to exercise the tactic; override the size floor if needed.
  if (process.env.ENABLE_ANCHORED_SHAKEUP === '1') {
    state.enableAnchoredShakeup = true;
  }
  // Wide Stage 1 stall rescue is OFF by default. Enable it to exercise it.
  if (process.env.ENABLE_WIDE_STAGE1 === '1') {
    state.enableWideStage1 = true;
  }
  if (process.env.ANCHORED_SHAKEUP_MIN) {
    state.anchoredShakeupMinNodes = Number(process.env.ANCHORED_SHAKEUP_MIN);
  }
  // Dirty-length steering is OFF by default. When on, Stage 1 breaks ties between
  // equally-crossing-reducing positions in favour of shortening dirty edges.
  if (process.env.ENABLE_DIRTY_STEERING === '1') {
    state.enableDirtySteering = true;
  }
  if (process.env.DIRTY_STEERING_MAX) {
    state.dirtySteeringMaxCrossings = Number(process.env.DIRTY_STEERING_MAX);
  }
  const strategies = {};
  const crossingHistory = [initialCrossings];
  const extensionPlans = [];
  const metricState = {
    analysisState: {},
    storyState: solver.createStoryState(),
    regimeState: solver.createRegimeState()
  };
  const metricTail = [];
  let finalMetrics = captureMetricSnapshot(
    graph, state, metricState, 0, 'initial');
  let bestMetrics = finalMetrics;
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
    finalMetrics = captureMetricSnapshot(
      graph, state, metricState, moves, result.move.strategy);
    metricTail.push(finalMetrics);
    if (metricTail.length > 25) metricTail.shift();
    if (finalMetrics.crossings <= bestMetrics.crossings) {
      bestMetrics = finalMetrics;
    }

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
  if (moves === 0 || finalMetrics.crossings !== finalCrossings) {
    finalMetrics = captureMetricSnapshot(
      graph, state, metricState, moves, stopReason);
  }
  if (activeExtension) {
    activeExtension.endMove = moves;
    activeExtension.completed = false;
  }
  extensionPlans.forEach(plan => {
    plan.maxSetback = Math.max(0, plan.setupPeakCrossings - plan.startCrossings);
    plan.netRecovery = plan.startCrossings - plan.bestLaterCrossings;
  });

  const result = {
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
    completedExtensionPlans: extensionPlans.filter(p => p.completed).length,
    finalMetrics,
    bestMetrics,
    failureBuckets: solved ? [] : null,
    searchDiagnostics: searchDiagnostics(state),
    metricTail: solved ? [] : metricTail
  };
  if (!result.solved) result.failureBuckets = classifyFailure(result);
  return result;
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
  const failureBuckets = {};
  failed.forEach(result => {
    result.failureBuckets.forEach(bucket => {
      failureBuckets[bucket] = (failureBuckets[bucket] || 0) + 1;
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
      failedWithNoExtensionPlan:
        failed.filter(result => result.extensionPlanCount === 0).length,
      largestRecoveredSetback: recoveredPlans.length
        ? Math.max(...recoveredPlans.map(plan => plan.maxSetback)) : null
    },
    strategyTotals,
    failureBuckets,
    failureSummaries: failed.map(result => ({
      puzzle: result.puzzle,
      stopReason: result.stopReason,
      moves: result.moves,
      finalCrossings: result.finalCrossings,
      minimumCrossings: result.minimumCrossings,
      extensionPlanCount: result.extensionPlanCount,
      recoveredExtensionPlans: result.recoveredExtensionPlans,
      buckets: result.failureBuckets,
      finalMetrics: result.finalMetrics,
      bestMetrics: result.bestMetrics,
      searchDiagnostics: result.searchDiagnostics
    })),
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
