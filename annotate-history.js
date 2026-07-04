// Augment a solver/interactive history JSON with per-move metrics, plus a
// retrospective cascade-onset summary. Uses the SAME metric functions the live
// solver/UIs use (solver.js exports), so offline annotation and the real-time
// readout agree. See METRICS.md for definitions.
//
// Usage: node annotate-history.js path/to/history.json [output.json]
//
// Input: { edges:[[i,j]...], history:[{positions:[[x,y]...], crossings, ...}] }
// Output: same shape, each history entry gets `.metrics` (progress + story),
//         and a top-level `.cascade` summary (onset move, descent, etc.).

const fs = require('fs');
const solver = require('./solver.js');

function buildGraph(positions, edges) {
  const nodes = positions.map(p => [p[0], p[1]]);
  const links = edges.map(([a, b]) => [nodes[a], nodes[b]]);
  return { nodes, links };
}

// --- retrospective cascade-onset detection (offline only; needs the future) ---
// Onset = top of the FINAL crossings descent to the global min, found on a
// running-median-smoothed series so spikes/noise don't move it. Mirrors the
// scratchpad prototype that this was validated with (n=150). See METRICS.md.
function runningMedian(a, w) {
  const h = w >> 1, out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(a.length - 1, i + h);
    const s = a.slice(lo, hi + 1).sort((x, y) => x - y);
    out[i] = s[s.length >> 1];
  }
  return out;
}
function findCascadeOnset(crossings) {
  const T = crossings.length;
  if (T < 3) return null;
  const S = runningMedian(crossings, 5);
  const globalMin = Math.min.apply(null, S);
  let ti = T - 1; while (ti > 0 && S[ti] > globalMin) ti--;
  let i = ti, top = ti, flat = 0;
  const MAXFLAT = 4;
  while (i > 0) {
    const rise = S[i - 1] - S[i];      // >0 => descending forward across i-1 -> i
    if (rise >= 0.5) { top = i - 1; flat = 0; i--; }
    else { flat++; if (flat > MAXFLAT) break; i--; }
  }
  const rawMin = Math.min.apply(null, crossings);
  return { onset: top, descentDepth: crossings[top] - rawMin, minCrossings: rawMin };
}

function annotateHistory(historyFile, outFile) {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  const edges = raw.edges;
  const history = raw.history || [];
  console.log(`Annotating ${history.length} positions from ${historyFile}`);

  const story = solver.createStoryState();   // single stateful forward pass
  const regime = solver.createRegimeState ? solver.createRegimeState() : null;
  const crossingsSeries = [];

  const annotated = history.map((entry, idx) => {
    const graph = buildGraph(entry.positions, edges);
    const analysis = solver.analyzeGraphState(graph, {});
    const progress = solver.computeProgressMetrics(graph, analysis);
    const storyM = solver.updateStoryMetrics(
      graph, story, analysis.crossingCounts, analysis.crossings);
    const regimeM = (regime && solver.computeRegimeMetrics)
      ? solver.computeRegimeMetrics(graph, analysis, storyM, regime) : null;
    crossingsSeries.push(analysis.crossings);

    const metrics = Object.assign({}, progress, {
      stalled: analysis.stalled,
      recentImprovement: analysis.recentImprovement,
      oscillatingVertices: (analysis.oscillatingVertices || []).length,
      story: storyM,
      regime: regimeM,
    });
    if ((idx + 1) % 50 === 0) {
      console.log(`  ${idx + 1}/${history.length} (crossings=${metrics.crossings}, ` +
        `freeze=${storyM.freeze.toFixed(2)}, dwell=${storyM.dwell})`);
    }
    return Object.assign({}, entry, { metrics });
  });

  const cascade = findCascadeOnset(crossingsSeries);
  if (cascade) {
    console.log(`Cascade onset @move ${cascade.onset} ` +
      `(descent ${cascade.descentDepth} -> min ${cascade.minCrossings})`);
  }

  const out = Object.assign({}, raw, { history: annotated, cascade });
  fs.writeFileSync(outFile, JSON.stringify(out));
  console.log(`Wrote ${outFile}`);
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node annotate-history.js <history.json> [output.json]');
  process.exit(1);
}
const inFile = args[0];
const outFile = args[1] || inFile.replace(/\.json$/, '.annotated.json');
annotateHistory(inFile, outFile);
