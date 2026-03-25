// Headless benchmark - runs without browser
// Usage: node benchmark.js

const fs = require('fs');
const solver = require('./solver.js');

// ============ BENCHMARK ============

function runBenchmark(numPuzzles, nodeCount) {
  numPuzzles = numPuzzles || 20;
  nodeCount = nodeCount || 30;
  
  console.log(`Running benchmark: ${numPuzzles} puzzles, ${nodeCount} nodes each...`);
  
  const results = [];
  let solved = 0;
  let totalMoves = 0;
  const strategyTotals = {};
  
  for (let i = 0; i < numPuzzles; i++) {
    const result = solver.solvePuzzle(nodeCount);
    results.push(result);
    
    if (result.solved) {
      solved++;
      totalMoves += result.moves;
    }
    
    Object.keys(result.strategyUsage || {}).forEach(s => {
      strategyTotals[s] = (strategyTotals[s] || 0) + result.strategyUsage[s];
    });
    
    // Progress
    const status = result.solved ? 'SOLVED' : `STUCK(${result.reason})`;
    console.log(`  #${i + 1}: ${status} in ${result.moves} moves (${result.initialCrossings}->${result.finalCrossings} crossings)`);
  }
  
  const report = {
    timestamp: new Date().toISOString(),
    config: { numPuzzles, nodeCount },
    summary: {
      solved,
      stuck: numPuzzles - solved,
      solveRate: ((solved / numPuzzles) * 100).toFixed(1) + '%',
      avgMovesPerSolve: solved > 0 ? (totalMoves / solved).toFixed(1) : null
    },
    strategyTotals,
    results: results.map((r, i) => ({
      puzzle: i,
      solved: r.solved,
      moves: r.moves,
      initialCrossings: r.initialCrossings,
      finalCrossings: r.finalCrossings
    }))
  };
  
  // Write results
  fs.writeFileSync('benchmark-results.json', JSON.stringify(report, null, 2));
  
  console.log('\n=== BENCHMARK RESULTS ===');
  console.log(`Solved: ${report.summary.solved}/${numPuzzles} (${report.summary.solveRate})`);
  console.log(`Avg moves per solve: ${report.summary.avgMovesPerSolve || 'N/A'}`);
  console.log('Strategy usage:', strategyTotals);
  console.log('\nResults written to benchmark-results.json');
  
  return report;
}

// Run with args or defaults
const args = process.argv.slice(2);
const numPuzzles = parseInt(args[0]) || 10;
const nodeCount = parseInt(args[1]) || 25;

runBenchmark(numPuzzles, nodeCount);
