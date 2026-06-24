// Augment an interactive-history JSON with per-move metrics.
// Usage: node annotate-history.js path/to/history.json [output.json]
//
// For each move in history.history, reconstructs the graph at that position,
// runs analyzeGraphState plus a few extra metrics (clean-edge ratio, progress
// composite, etc.), and writes an annotated copy.

const fs = require('fs');
const path = require('path');
const solver = require('./solver.js');

function buildGraph(positions, edges) {
  const nodes = positions.map(p => [p[0], p[1]]);
  const links = edges.map(([a, b]) => [nodes[a], nodes[b]]);
  return { nodes, links };
}

function metricsAtPosition(positions, edges) {
  const graph = buildGraph(positions, edges);
  // intersections() populates .intersection on each node; analyzeGraphState
  // calls it internally.
  const analysis = solver.analyzeGraphState(graph, {});
  const progress = solver.computeProgressMetrics(graph, analysis);

  return Object.assign({}, progress, {
    // A few extra status fields not in the shared metrics block.
    stalled: analysis.stalled,
    recentImprovement: analysis.recentImprovement,
    oscillatingVertices: (analysis.oscillatingVertices || []).length,
  });
}

function annotateHistory(historyFile, outFile) {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  const edges = raw.edges;
  const history = raw.history || [];

  console.log(`Annotating ${history.length} positions from ${historyFile}`);
  const annotated = history.map((entry, idx) => {
    const m = metricsAtPosition(entry.positions, edges);
    if ((idx + 1) % 50 === 0) {
      console.log(`  ${idx + 1}/${history.length} (crossings=${m.crossings}, progress=${m.progress.toFixed(3)})`);
    }
    return Object.assign({}, entry, { metrics: m });
  });

  const out = Object.assign({}, raw, { history: annotated });
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
