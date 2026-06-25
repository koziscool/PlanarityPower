// Offline wasted-tail intervention analyzer.
//
// Usage:
//   node analyze-wasted-tail.js [file-or-dir ...]
//
// If no paths are supplied, scans /home/koz/Downloads for solver/turbosolver
// result and replay JSONs. This script is read-only: it reconstructs graph
// states from exported histories, detects live wasted-tail points using the
// same story metrics as the UI, and asks current candidate tools what they
// would have proposed at those points.

const fs = require('fs');
const path = require('path');
const solver = require('./solver.js');

const DEFAULT_DOWNLOADS = '/home/koz/Downloads';
const CONFIG = {
  minHistory: 12,
  dwell: 25,
  freeze: 0.90,
  trendFloor: -1,
  maxCheckpointsPerPuzzle: 3,
  checkpointStride: 10,
  maxFiles: 20,
  maxPuzzles: 80,
  tools: ['anchor', 'problem', 'stage1c']
};

function parseArgs(argv) {
  const paths = [];
  const config = Object.assign({}, CONFIG, { tools: CONFIG.tools.slice() });
  argv.forEach(arg => {
    if (arg.indexOf('--') !== 0) {
      paths.push(arg);
      return;
    }
    const parts = arg.slice(2).split('=');
    const key = parts[0];
    const value = parts.length > 1 ? parts.slice(1).join('=') : 'true';
    if (key === 'tools') {
      config.tools = value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (key in config) {
      const parsed = Number(value);
      config[key] = Number.isFinite(parsed) ? parsed : value;
    }
  });
  return { paths, config };
}

function listJsonInputs(args, config) {
  const roots = args.length ? args : [DEFAULT_DOWNLOADS];
  const out = [];
  roots.forEach(root => {
    if (!fs.existsSync(root)) return;
    const st = fs.statSync(root);
    if (st.isDirectory()) {
      fs.readdirSync(root).forEach(name => {
        if (!/\.json$/i.test(name)) return;
        if (!/(solver|turbo|interactive|history)/i.test(name)) return;
        out.push(path.join(root, name));
      });
    } else if (/\.json$/i.test(root)) {
      out.push(root);
    }
  });
  return Array.from(new Set(out)).sort().slice(0, config.maxFiles);
}

function buildGraph(positions, edges) {
  const nodes = positions.map(p => [p[0], p[1]]);
  const links = edges.map(([a, b]) => [nodes[a], nodes[b]]);
  return { nodes, links };
}

function graphFromEntry(entry, edges) {
  if (!entry || !Array.isArray(entry.positions) || !Array.isArray(edges)) {
    return null;
  }
  return buildGraph(entry.positions, edges);
}

function normalizeHistory(raw, source, puzzleId) {
  const edges = raw.edges;
  const history = raw.history || raw.snapshots || [];
  if (!Array.isArray(edges) || !Array.isArray(history)) return null;

  const frames = history
    .filter(entry => Array.isArray(entry.positions))
    .map((entry, index) => ({
      source,
      puzzleId,
      index,
      move: entry.moveNumber ?? entry.move ?? entry.number ?? index,
      label: entry.label || entry.strategy || null,
      movingNode: entry.movingNode ?? entry.vertex ??
        (entry.move && entry.move.vertex) ?? null,
      moveRecord: entry.move || null,
      positions: entry.positions,
      crossings: entry.crossings
    }));
  if (frames.length < CONFIG.minHistory) return null;

  return {
    source,
    puzzleId,
    status: raw.status || null,
    edges,
    frames
  };
}

function extractPuzzles(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return [];
  }

  const puzzles = [];
  if (Array.isArray(raw.puzzles)) {
    raw.puzzles.forEach((puzzle, index) => {
      const frames = [];
      const snapshots = Array.isArray(puzzle.snapshots) ? puzzle.snapshots.slice() : [];
      if (puzzle.finalSnapshot && Array.isArray(puzzle.finalSnapshot.positions)) {
        const last = snapshots[snapshots.length - 1];
        if (!last || last.move !== puzzle.finalSnapshot.move ||
            last.crossings !== puzzle.finalSnapshot.crossings) {
          snapshots.push(puzzle.finalSnapshot);
        }
      }
      snapshots.forEach((entry, frameIndex) => {
        if (!Array.isArray(entry.positions)) return;
        frames.push({
          source: file,
          puzzleId: puzzle.id ?? index,
          index: frameIndex,
          move: entry.moveNumber ?? entry.move ?? frameIndex,
          label: (entry.moveRecord && entry.moveRecord.strategy) ||
            entry.strategy || entry.label || null,
          movingNode: entry.movingNode ?? entry.vertex ??
            (entry.moveRecord && entry.moveRecord.vertex) ?? null,
          moveRecord: entry.moveRecord || null,
          positions: entry.positions,
          crossings: entry.crossings
        });
      });
      if (frames.length >= CONFIG.minHistory && Array.isArray(puzzle.edges)) {
        puzzles.push({
          source: file,
          puzzleId: puzzle.id ?? index,
          status: puzzle.status || null,
          edges: puzzle.edges,
          frames
        });
      }
    });
  }

  const normalized = normalizeHistory(raw, file, raw.session || raw.id || 0);
  if (normalized) puzzles.push(normalized);
  return puzzles;
}

function crossingSeries(frames, edges) {
  return frames.map(frame => {
    if (typeof frame.crossings === 'number') return frame.crossings;
    const graph = graphFromEntry(frame, edges);
    return graph ? solver.intersections(graph.links) : Infinity;
  });
}

function runningMedian(values, width) {
  const half = width >> 1;
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    const slice = values.slice(lo, hi + 1).sort((a, b) => a - b);
    return slice[slice.length >> 1];
  });
}

function findCascadeOnset(frames, series) {
  if (series.length < 5) return null;
  const smoothed = runningMedian(series, 5);
  const globalMin = Math.min(...smoothed);
  let minIndex = smoothed.length - 1;
  while (minIndex > 0 && smoothed[minIndex] > globalMin) minIndex--;

  let i = minIndex;
  let top = minIndex;
  let flat = 0;
  while (i > 0) {
    const rise = smoothed[i - 1] - smoothed[i];
    if (rise >= 0.5) {
      top = i - 1;
      flat = 0;
      i--;
    } else {
      flat++;
      if (flat > 4) break;
      i--;
    }
  }

  const rawMin = Math.min(...series);
  return {
    onsetIndex: top,
    onsetMove: frames[top] ? frames[top].move : top,
    minIndex,
    minMove: frames[minIndex] ? frames[minIndex].move : minIndex,
    onsetCrossings: series[top],
    minCrossings: rawMin,
    descentDepth: series[top] - rawMin
  };
}

function inferMovedVertices(prev, next) {
  if (!prev || !next || !Array.isArray(prev.positions) ||
      !Array.isArray(next.positions)) {
    return [];
  }
  const moved = [];
  const n = Math.min(prev.positions.length, next.positions.length);
  for (let i = 0; i < n; i++) {
    const dx = next.positions[i][0] - prev.positions[i][0];
    const dy = next.positions[i][1] - prev.positions[i][1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1e-7) moved.push({ vertex: i, distance: dist });
  }
  moved.sort((a, b) => b.distance - a.distance);
  return moved;
}

function classifyTrigger(frame, prevFrame, graph, analysis) {
  const moved = inferMovedVertices(prevFrame, frame);
  const primary = frame.movingNode ??
    (moved.length ? moved[0].vertex : null);
  const strategy = (frame.moveRecord && frame.moveRecord.strategy) ||
    frame.label || null;
  const cc = analysis.crossingCounts || [];
  const degree = primary === null ? null :
    solver.getNodeEdges(graph, graph.nodes[primary]).length;
  const crossingCount = primary === null ? null : (cc[primary] || 0);
  let kind = 'unknown';

  if (strategy && /stage1c/i.test(strategy)) kind = 'stage1c-reset';
  else if (strategy && /anchor-break|barrier|transfer/i.test(strategy)) {
    kind = 'barrier-transfer';
  } else if (strategy && /problem-child|inversion/i.test(strategy)) {
    kind = 'problem-child-inversion';
  } else if (strategy && /compaction|compact/i.test(strategy)) {
    kind = 'compaction';
  } else if (strategy && /region-extension/i.test(strategy)) {
    kind = 'region-extension';
  } else if (strategy && /escape/i.test(strategy)) {
    kind = 'escape';
  } else if (strategy && /adaptive|centroid|local|side-flip|enclosure/i.test(strategy)) {
    kind = 'ordinary-descent';
  }

  return {
    move: frame.move,
    index: frame.index,
    strategy,
    kind,
    movingNode: primary,
    movedVertices: moved.slice(0, 6),
    degree,
    crossingCount,
    crossings: analysis.crossings,
    metrics: frame._metrics
  };
}

function metricSnapshot(graph) {
  const analysis = solver.analyzeGraphState(graph, {});
  const progress = solver.computeProgressMetrics(graph, analysis);
  return {
    crossings: progress.crossings,
    cleanRatio: progress.cleanRatio,
    largestCleanRegionRatio: progress.largestCleanRegionRatio,
    cleanEdgeRatio: progress.cleanEdgeRatio,
    nearCleanRatio: progress.nearCleanRatio,
    regionFragmentation: progress.regionFragmentation,
    crossingsPerDirtyEdge: progress.crossingsPerDirtyEdge,
    topCrossingShare: progress.topCrossingShare,
    progress: progress.progress,
    cleanVertices: progress.cleanVertices,
    cleanEdges: progress.cleanEdges,
    nearCleanVertices: progress.nearCleanVertices,
    largestCleanRegion: progress.largestCleanRegion
  };
}

function metricDelta(before, after) {
  const keys = Object.keys(before);
  const out = {};
  keys.forEach(key => {
    if (typeof before[key] === 'number' && typeof after[key] === 'number') {
      out[key] = after[key] - before[key];
    }
  });
  return out;
}

function cloneGraph(graph) {
  const nodes = graph.nodes.map(node => [node[0], node[1]]);
  const links = graph.links.map(link => [
    nodes[graph.nodes.indexOf(link[0])],
    nodes[graph.nodes.indexOf(link[1])]
  ]);
  return { nodes, links };
}

function applyPositions(graph, positions) {
  if (!Array.isArray(positions)) return;
  positions.forEach(pos => {
    if (typeof pos.index !== 'number') return;
    graph.nodes[pos.index][0] = pos.x;
    graph.nodes[pos.index][1] = pos.y;
  });
}

function positionsFromSummary(summary) {
  if (!summary) return null;
  if (Array.isArray(summary.positions)) return summary.positions;
  return null;
}

function findWastedTailFrames(puzzle, config) {
  const story = solver.createStoryState();
  const result = [];
  for (let i = 0; i < puzzle.frames.length; i++) {
    const frame = puzzle.frames[i];
    const graph = graphFromEntry(frame, puzzle.edges);
    if (!graph) continue;
    const analysis = solver.analyzeGraphState(graph, {});
    const metrics = solver.updateStoryMetrics(
      graph, story, analysis.crossingCounts, analysis.crossings);
    frame._metrics = metrics;
    frame._crossings = analysis.crossings;
    const wasted =
      i >= CONFIG.minHistory &&
      analysis.crossings > 0 &&
      metrics.dwell >= config.dwell &&
      metrics.freeze >= config.freeze &&
      metrics.trend >= config.trendFloor;
    if (wasted) result.push(frame);
  }
  return result;
}

function annotateFrames(puzzle) {
  const story = solver.createStoryState();
  return puzzle.frames.map((frame, i) => {
    const graph = graphFromEntry(frame, puzzle.edges);
    if (!graph) return frame;
    const analysis = solver.analyzeGraphState(graph, {});
    const metrics = solver.updateStoryMetrics(
      graph, story, analysis.crossingCounts, analysis.crossings);
    frame._metrics = metrics;
    frame._crossings = analysis.crossings;
    frame._analysis = analysis;
    frame._graph = graph;
    if (i > 0) {
      frame._movedVertices = inferMovedVertices(puzzle.frames[i - 1], frame);
    } else {
      frame._movedVertices = [];
    }
    return frame;
  });
}

function chooseCheckpoints(wastedFrames, config) {
  if (!wastedFrames.length) return [];
  const checkpoints = [wastedFrames[0]];
  let lastMove = wastedFrames[0].move;
  for (let i = 1; i < wastedFrames.length; i++) {
    const frame = wastedFrames[i];
    if (checkpoints.length >= config.maxCheckpointsPerPuzzle) break;
    if (frame.move - lastMove >= config.checkpointStride) {
      checkpoints.push(frame);
      lastMove = frame.move;
    }
  }
  return checkpoints;
}

function summarizeCandidate(candidate) {
  if (!candidate) return null;
  return {
    strategy: candidate.strategy || candidate.type || null,
    reason: candidate.reason || candidate.objective || null,
    component: candidate.component || candidate.group || null,
    barrier: candidate.barrier || null,
    vertex: candidate.vertex ?? null,
    referenceVertex: candidate.referenceVertex ?? null,
    immediateCrossings: candidate.immediateCrossings ?? null,
    finalCrossings: candidate.finalCrossings ?? null,
    downstreamImprovement: candidate.downstreamImprovement ?? null,
    immediateDamage: candidate.immediateDamage ?? null,
    netGain: candidate.netGain ?? null,
    score: candidate.score ?? null,
    positions: candidate.positions || candidate.scheduledMoves || null
  };
}

function enrichToolMetrics(result, graph, baseMetrics) {
  if (!result.best) return result;
  const positions = positionsFromSummary(result.best);
  if (!positions) return result;
  const immediateGraph = cloneGraph(graph);
  applyPositions(immediateGraph, positions);
  const immediateMetrics = metricSnapshot(immediateGraph);
  result.immediateMetricDelta = metricDelta(baseMetrics, immediateMetrics);

  // We deliberately do not rerun each tool's custom rollout here. Some reports
  // already contain final crossings from a custom simulation, but not final
  // coordinates. The immediate metric delta is the common comparable surface.
  result.metricScore =
    -(result.immediateMetricDelta.crossings || 0) * 2 +
    (result.immediateMetricDelta.nearCleanRatio || 0) * 20 +
    (result.immediateMetricDelta.cleanEdgeRatio || 0) * 18 +
    (result.immediateMetricDelta.largestCleanRegionRatio || 0) * 15 -
    Math.max(0, result.immediateMetricDelta.topCrossingShare || 0) * 6 -
    Math.max(0, result.immediateMetricDelta.crossingsPerDirtyEdge || 0) * 2;
  return result;
}

function toolResult(name, base, report, best) {
  const summary = summarizeCandidate(best);
  let payoff = 0;
  let solves = false;
  if (summary) {
    const final = typeof summary.finalCrossings === 'number'
      ? summary.finalCrossings : summary.immediateCrossings;
    if (typeof final === 'number') {
      payoff = base - final;
      solves = final === 0;
    } else if (typeof summary.netGain === 'number') {
      payoff = summary.netGain;
    }
  }
  return {
    name,
    tested: report && report.candidatesTested,
    elapsedMs: report && report.elapsedMs,
    timedOut: Boolean(report && report.timedOut),
    useful: Boolean(summary && payoff > 0),
    solves,
    payoff,
    best: summary
  };
}

function evaluateTools(graph, baseCrossings, config) {
  const results = [];
  const baseMetrics = metricSnapshot(graph);

  if (config.tools.indexOf('anchor') >= 0) {
    const anchorBreak = solver.suggestAnchorBreakBarrierTransfer(graph, {
      timeBudgetMs: 100,
      componentLimit: 12,
      barrierLimit: 8,
      keepCandidates: 5
    });
    results.push(enrichToolMetrics(toolResult(
      'anchor-break-barrier', baseCrossings, anchorBreak, anchorBreak.best),
      graph, baseMetrics));
  }

  if (config.tools.indexOf('problem') >= 0) {
    const problemChild = solver.suggestProblemChildInversions(graph, {
      timeBudgetMs: 100,
      vertexLimit: 10,
      candidateLimit: 180,
      rolloutLimit: 8,
      rolloutSteps: 10
    });
    results.push(enrichToolMetrics(toolResult(
      'problem-child-inversion', baseCrossings, problemChild, problemChild.best),
      graph, baseMetrics));
  }

  if (config.tools.indexOf('stage1c') >= 0) {
    const stage1c = solver.suggestStage1cResetPlan(graph, {
      timeBudgetMs: 160,
      seedLimit: 0,
      geometricSeedLimit: 22,
      minGroupSize: 2,
      maxGroupSize: 4,
      scales: [0.75, 1.0],
      targetBlends: [1.0, 1.2],
      maxImmediateDamage: 90,
      cleanupSteps: 20
    });
    results.push(enrichToolMetrics(
      toolResult('stage1c-reset', baseCrossings, stage1c, stage1c.best),
      graph, baseMetrics));
  }

  if (config.tools.indexOf('restart') >= 0) {
    const restart = solver.suggestStage2Restart(graph, {
      timeBudgetMs: 70,
      requiredImprovement: 1
    });
    results.push(enrichToolMetrics(
      toolResult('stage2-restart', baseCrossings, restart, restart.best),
      graph, baseMetrics));
  }

  results.sort((a, b) =>
    Number(b.solves) - Number(a.solves) ||
    b.payoff - a.payoff ||
    (b.metricScore || -Infinity) - (a.metricScore || -Infinity) ||
    Number(b.useful) - Number(a.useful));
  return results;
}

function analyzePuzzle(puzzle, config) {
  annotateFrames(puzzle);
  const series = puzzle.frames.map(frame => frame._crossings);
  const minCrossings = Math.min(...series);
  const finalCrossings = series[series.length - 1];
  const wastedFrames = findWastedTailFrames(puzzle, config);
  const checkpoints = chooseCheckpoints(wastedFrames, config);
  if (!checkpoints.length) return null;

  const checkpointReports = checkpoints.map(frame => {
    const graph = frame._graph || graphFromEntry(frame, puzzle.edges);
    const base = frame._crossings ?? solver.intersections(graph.links);
    const tools = evaluateTools(graph, base, config);
    return {
      move: frame.move,
      index: frame.index,
      crossings: base,
      metrics: frame._metrics,
      usefulTools: tools.filter(tool => tool.useful).length,
      bestTool: tools[0],
      tools
    };
  });

  const cascade = finalCrossings === 0 ? findCascadeOnset(puzzle.frames, series) : null;
  let cascadeTrigger = null;
  if (cascade && cascade.descentDepth >= 5 &&
      cascade.onsetIndex > checkpoints[0].index) {
    let bestIndex = cascade.onsetIndex;
    const lo = Math.max(checkpoints[0].index + 1, cascade.onsetIndex - 3);
    const hi = Math.min(puzzle.frames.length - 1, cascade.onsetIndex + 4);
    let bestScore = -Infinity;
    for (let i = lo; i <= hi; i++) {
      const m = puzzle.frames[i]._metrics || {};
      const score = (m.drop || 0) * 3 + (m.thaw || 0) -
        Math.max(0, (m.trend || 0)) * 0.15 -
        Math.max(0, (puzzle.frames[i]._crossings || 0) -
          (puzzle.frames[i - 1] ? puzzle.frames[i - 1]._crossings || 0 : 0));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    cascadeTrigger = classifyTrigger(
      puzzle.frames[bestIndex],
      puzzle.frames[bestIndex - 1],
      puzzle.frames[bestIndex]._graph,
      puzzle.frames[bestIndex]._analysis);
  }

  return {
    source: puzzle.source,
    puzzleId: puzzle.puzzleId,
    status: puzzle.status,
    frames: puzzle.frames.length,
    minCrossings,
    finalCrossings,
    firstWastedMove: checkpoints[0].move,
    firstWastedCrossings: checkpoints[0]._crossings,
    firstWastedMetrics: checkpoints[0]._metrics,
    cascade,
    cascadeTrigger,
    checkpointReports
  };
}

function summarizeReports(reports) {
  const toolStats = {};
  reports.forEach(report => {
    report.checkpointReports.forEach(checkpoint => {
      checkpoint.tools.forEach(tool => {
        toolStats[tool.name] = toolStats[tool.name] || {
          checkpoints: 0,
          useful: 0,
          solves: 0,
          totalPayoff: 0
        };
        const stat = toolStats[tool.name];
        stat.checkpoints++;
        if (tool.useful) stat.useful++;
        if (tool.solves) stat.solves++;
        stat.totalPayoff += Math.max(0, tool.payoff || 0);
      });
    });
  });

  Object.keys(toolStats).forEach(name => {
    const stat = toolStats[name];
    stat.usefulRate = stat.checkpoints ? stat.useful / stat.checkpoints : 0;
    stat.solveRate = stat.checkpoints ? stat.solves / stat.checkpoints : 0;
    stat.averagePositivePayoff = stat.useful
      ? stat.totalPayoff / stat.useful : 0;
  });
  return toolStats;
}

function summarizeCascadeTriggers(reports) {
  const stats = {};
  reports.forEach(report => {
    if (!report.cascadeTrigger) return;
    const kind = report.cascadeTrigger.kind || 'unknown';
    stats[kind] = stats[kind] || {
      count: 0,
      totalDrop: 0,
      totalThaw: 0,
      totalDescentDepth: 0
    };
    stats[kind].count++;
    stats[kind].totalDrop += report.cascadeTrigger.metrics.drop || 0;
    stats[kind].totalThaw += report.cascadeTrigger.metrics.thaw || 0;
    stats[kind].totalDescentDepth += report.cascade.descentDepth || 0;
  });
  Object.keys(stats).forEach(kind => {
    const stat = stats[kind];
    stat.avgDrop = stat.totalDrop / stat.count;
    stat.avgThaw = stat.totalThaw / stat.count;
    stat.avgDescentDepth = stat.totalDescentDepth / stat.count;
  });
  return stats;
}

function loadBenchmarkPair(enabledFile, disabledFile) {
  if (!fs.existsSync(enabledFile) || !fs.existsSync(disabledFile)) return null;
  const enabled = JSON.parse(fs.readFileSync(enabledFile, 'utf8'));
  const disabled = JSON.parse(fs.readFileSync(disabledFile, 'utf8'));
  const disabledByPuzzle = {};
  (disabled.results || []).forEach(result => {
    disabledByPuzzle[result.puzzle] = result;
  });
  const rows = (enabled.results || [])
    .filter(result => result.strategies &&
      result.strategies['wasted-tail-cascade-trigger'])
    .map(result => {
      const peer = disabledByPuzzle[result.puzzle] || {};
      const moveDelta = result.moves - peer.moves;
      let outcome = 'neutral';
      if (result.solved && !peer.solved) outcome = 'good-enabled-only';
      else if (!result.solved && peer.solved) outcome = 'bad-disabled-only';
      else if (result.solved && peer.solved && moveDelta <= -25) outcome = 'good-faster';
      else if (result.solved && peer.solved && moveDelta >= 25) outcome = 'bad-slower';
      else if (!result.solved && !peer.solved &&
          result.finalCrossings < peer.finalCrossings) {
        outcome = 'good-lower-final';
      } else if (!result.solved && !peer.solved &&
          result.finalCrossings > peer.finalCrossings) {
        outcome = 'bad-higher-final';
      }
      return {
        puzzle: result.puzzle,
        triggerMoves: result.strategies['wasted-tail-cascade-trigger'],
        outcome,
        enabled: {
          solved: result.solved,
          moves: result.moves,
          finalCrossings: result.finalCrossings
        },
        disabled: {
          solved: Boolean(peer.solved),
          moves: peer.moves,
          finalCrossings: peer.finalCrossings
        },
        moveDelta
      };
    });

  const summary = rows.reduce((acc, row) => {
    acc[row.outcome] = (acc[row.outcome] || 0) + 1;
    return acc;
  }, {});
  return {
    enabledFile,
    disabledFile,
    enabledSummary: enabled.summary,
    disabledSummary: disabled.summary,
    triggerFirings: rows.length,
    outcomeSummary: summary,
    rows
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const inputs = listJsonInputs(parsed.paths, parsed.config);
  const puzzles = inputs.flatMap(extractPuzzles).slice(0, parsed.config.maxPuzzles);
  const reports = [];
  puzzles.forEach(puzzle => {
    const report = analyzePuzzle(puzzle, parsed.config);
    if (report) reports.push(report);
  });

  const output = {
    timestamp: new Date().toISOString(),
    config: parsed.config,
    inputs: inputs.length,
    puzzles: puzzles.length,
    wastedTailPuzzles: reports.length,
    toolStats: summarizeReports(reports),
    cascadeTriggerStats: summarizeCascadeTriggers(reports),
    benchmarkPair: loadBenchmarkPair(
      'benchmark-stage2-cascade-enabled.json',
      'benchmark-stage2-cascade-disabled.json'),
    strongestCases: reports
      .slice()
      .sort((a, b) =>
        (b.checkpointReports[0].bestTool.payoff || 0) -
        (a.checkpointReports[0].bestTool.payoff || 0))
      .slice(0, 20)
      .map(report => ({
        source: report.source,
        puzzleId: report.puzzleId,
        status: report.status,
        firstWastedMove: report.firstWastedMove,
        crossings: report.firstWastedCrossings,
        metrics: report.firstWastedMetrics,
        bestTool: report.checkpointReports[0].bestTool
      })),
    reports
  };

  fs.writeFileSync('wasted-tail-analysis.json', JSON.stringify(output, null, 2));

  console.log(`Inputs: ${inputs.length}`);
  console.log(`Puzzles with histories: ${puzzles.length}`);
  console.log(`Wasted-tail puzzles: ${reports.length}`);
  console.log('Tool stats:');
  Object.entries(output.toolStats).forEach(([name, stat]) => {
    console.log(`  ${name}: useful ${stat.useful}/${stat.checkpoints} ` +
      `(${(stat.usefulRate * 100).toFixed(1)}%), solves ${stat.solves}, ` +
      `avg payoff ${stat.averagePositivePayoff.toFixed(1)}`);
  });
  console.log('Cascade trigger stats:');
  Object.entries(output.cascadeTriggerStats).forEach(([kind, stat]) => {
    console.log(`  ${kind}: ${stat.count}, avg drop ${stat.avgDrop.toFixed(1)}, ` +
      `avg thaw ${stat.avgThaw.toFixed(1)}, avg descent ${stat.avgDescentDepth.toFixed(1)}`);
  });
  if (output.benchmarkPair) {
    console.log('Benchmark pair trigger outcomes:');
    Object.entries(output.benchmarkPair.outcomeSummary).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  }
  console.log('Top cases:');
  output.strongestCases.slice(0, 8).forEach(item => {
    console.log(`  ${path.basename(item.source)} #${item.puzzleId} ` +
      `move ${item.firstWastedMove} x=${item.crossings}: ` +
      `${item.bestTool.name} payoff ${item.bestTool.payoff}`);
  });
  console.log('Wrote wasted-tail-analysis.json');
}

main();
