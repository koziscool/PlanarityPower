// Headless benchmark - runs without browser
// Usage: node benchmark.js

const fs = require('fs');

// ============ CORE GRAPH FUNCTIONS ============

function cross(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

function intersect(a, b) {
  if (a[0] === b[0] && a[1] === b[1] || a[0] === b[1] && a[1] === b[0]) return true;
  const p = a[0], r = [a[1][0] - p[0], a[1][1] - p[1]];
  const q = b[0], s = [b[1][0] - q[0], b[1][1] - q[1]];
  const rxs = cross(r, s);
  const q_p = [q[0] - p[0], q[1] - p[1]];
  const t = cross(q_p, s) / rxs;
  const u = cross(q_p, r) / rxs;
  const epsilon = 1e-6;
  return t > epsilon && t < 1 - epsilon && u > epsilon && u < 1 - epsilon;
}

function intersections(links) {
  let count = 0;
  for (let i = 0; i < links.length; i++) {
    links[i].intersection = false;
    links[i][0].intersection = false;
    links[i][1].intersection = false;
  }
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      if (intersect(links[i], links[j])) {
        links[i].intersection = links[i][0].intersection = links[i][1].intersection = true;
        links[j].intersection = links[j][0].intersection = links[j][1].intersection = true;
        count++;
      }
    }
  }
  return count;
}

function planarGraph(n) {
  const points = [];
  const links = [];
  for (let i = 0; i < n; i++) points[i] = [Math.random(), Math.random()];
  for (let i = 0; i < n; i++) {
    const link = [points[i], points[~~(Math.random() * n)]];
    if (!links.some(to => intersect(link, to))) links.push(link);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const link = [points[i], points[j]];
      if (!links.some(to => intersect(link, to))) links.push(link);
    }
  }
  return { nodes: points, links };
}

function scramble(graph) {
  if (graph.nodes.length < 4) return graph;
  do {
    graph.nodes.forEach(node => {
      node[0] = Math.random();
      node[1] = Math.random();
    });
  } while (!intersections(graph.links));
  return graph;
}

function getNeighbors(graph, node) {
  const neighbors = [];
  graph.links.forEach(link => {
    if (link[0] === node) neighbors.push(link[1]);
    else if (link[1] === node) neighbors.push(link[0]);
  });
  return neighbors;
}

// ============ SOLVER STRATEGIES ============

function findCentroidMove(graph) {
  const count = intersections(graph.links);
  let bestMove = null, bestScore = -Infinity;
  
  graph.nodes.forEach((node, i) => {
    if (!node.intersection) return;
    const neighbors = getNeighbors(graph, node);
    if (neighbors.length === 0) return;
    
    let cx = 0, cy = 0;
    neighbors.forEach(n => { cx += n[0]; cy += n[1]; });
    cx /= neighbors.length; cy /= neighbors.length;
    
    const dx = cx - node[0], dy = cy - node[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.01) return;
    
    const origX = node[0], origY = node[1];
    const moveAmt = Math.min(0.1, dist * 0.5);
    node[0] = Math.max(0.02, Math.min(0.98, origX + (dx / dist) * moveAmt));
    node[1] = Math.max(0.02, Math.min(0.98, origY + (dy / dist) * moveAmt));
    
    const newCount = intersections(graph.links);
    const improvement = count - newCount;
    const score = improvement * 10 + (1 - dist);
    
    if ((improvement > 0 || (improvement === 0 && dist > 0.05)) && score > bestScore) {
      bestScore = score;
      bestMove = { node, nodeIndex: i, toX: node[0], toY: node[1], fromX: origX, fromY: origY, improvement, strategy: 'centroid' };
    }
    
    node[0] = origX; node[1] = origY;
  });
  
  intersections(graph.links);
  return bestMove;
}

function findLocalMove(graph) {
  const count = intersections(graph.links);
  let bestMove = null, bestImprovement = 0;
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  
  graph.nodes.forEach((node, i) => {
    if (!node.intersection) return;
    const origX = node[0], origY = node[1];
    
    dirs.forEach(dir => {
      node[0] = Math.max(0.02, Math.min(0.98, origX + dir[0] * 0.03));
      node[1] = Math.max(0.02, Math.min(0.98, origY + dir[1] * 0.03));
      const newCount = intersections(graph.links);
      const improvement = count - newCount;
      
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        bestMove = { node, nodeIndex: i, toX: node[0], toY: node[1], fromX: origX, fromY: origY, improvement, strategy: 'local' };
      }
      node[0] = origX; node[1] = origY;
    });
  });
  
  intersections(graph.links);
  return bestMove;
}

function findSpreadMove(graph) {
  const count = intersections(graph.links);
  let bestMove = null, bestImprovement = 0;
  const minDist = 0.08;
  
  graph.nodes.forEach((node, i) => {
    if (!node.intersection) return;
    const origX = node[0], origY = node[1];
    
    let pushX = 0, pushY = 0, pushCount = 0;
    graph.nodes.forEach((other, j) => {
      if (i === j) return;
      const dx = node[0] - other[0];
      const dy = node[1] - other[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist && dist > 0.001) {
        const force = (minDist - dist) / minDist;
        pushX += (dx / dist) * force;
        pushY += (dy / dist) * force;
        pushCount++;
      }
    });
    
    if (pushCount === 0) return;
    
    const pushMag = Math.sqrt(pushX * pushX + pushY * pushY);
    if (pushMag < 0.001) return;
    
    const moveAmt = Math.min(0.08, pushMag * 0.5);
    node[0] = Math.max(0.02, Math.min(0.98, origX + (pushX / pushMag) * moveAmt));
    node[1] = Math.max(0.02, Math.min(0.98, origY + (pushY / pushMag) * moveAmt));
    
    const newCount = intersections(graph.links);
    const improvement = count - newCount;
    
    if (improvement > bestImprovement) {
      bestImprovement = improvement;
      bestMove = { node, nodeIndex: i, toX: node[0], toY: node[1], fromX: origX, fromY: origY, improvement, strategy: 'spread' };
    }
    
    node[0] = origX; node[1] = origY;
  });
  
  intersections(graph.links);
  return bestMove;
}

function findRotateMove(graph) {
  const count = intersections(graph.links);
  let bestMove = null, bestImprovement = 0;
  
  graph.nodes.forEach((node, i) => {
    if (!node.intersection) return;
    const neighbors = getNeighbors(graph, node);
    if (neighbors.length < 2) return;
    
    const origX = node[0], origY = node[1];
    
    let cx = 0, cy = 0;
    neighbors.forEach(n => { cx += n[0]; cy += n[1]; });
    cx /= neighbors.length; cy /= neighbors.length;
    
    const dx = origX - cx, dy = origY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.02) return;
    
    const angle = Math.atan2(dy, dx);
    const rotations = [0.2, -0.2, 0.4, -0.4, 0.6, -0.6];
    
    rotations.forEach(rot => {
      const newAngle = angle + rot;
      node[0] = Math.max(0.02, Math.min(0.98, cx + Math.cos(newAngle) * dist));
      node[1] = Math.max(0.02, Math.min(0.98, cy + Math.sin(newAngle) * dist));
      
      const newCount = intersections(graph.links);
      const improvement = count - newCount;
      
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        bestMove = { node, nodeIndex: i, toX: node[0], toY: node[1], fromX: origX, fromY: origY, improvement, strategy: 'rotate' };
      }
      
      node[0] = origX; node[1] = origY;
    });
  });
  
  intersections(graph.links);
  return bestMove;
}

function findWiggleMove(graph) {
  const count = intersections(graph.links);
  const candidates = graph.nodes.filter(n => n.intersection);
  if (candidates.length === 0) return null;
  
  const node = candidates[Math.floor(Math.random() * candidates.length)];
  const i = graph.nodes.indexOf(node);
  const origX = node[0], origY = node[1];
  let bestMove = null, bestImprovement = -Infinity;
  
  for (let t = 0; t < 15; t++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 0.05 + Math.random() * 0.1;
    node[0] = Math.max(0.02, Math.min(0.98, origX + Math.cos(angle) * dist));
    node[1] = Math.max(0.02, Math.min(0.98, origY + Math.sin(angle) * dist));
    
    const newCount = intersections(graph.links);
    const improvement = count - newCount;
    
    if (improvement > bestImprovement) {
      bestImprovement = improvement;
      bestMove = { node, nodeIndex: i, toX: node[0], toY: node[1], fromX: origX, fromY: origY, improvement, strategy: 'wiggle' };
    }
    node[0] = origX; node[1] = origY;
  }
  
  intersections(graph.links);
  return bestMove;
}

// ============ SOLVER ============

function solverStep(graph) {
  const count = intersections(graph.links);
  if (count === 0) return { done: true };
  
  const moves = [];
  const c = findCentroidMove(graph); if (c) moves.push(c);
  const l = findLocalMove(graph); if (l) moves.push(l);
  const s = findSpreadMove(graph); if (s) moves.push(s);
  const r = findRotateMove(graph); if (r) moves.push(r);
  
  let best = null;
  moves.forEach(m => {
    if (!best || m.improvement > best.improvement) best = m;
  });
  
  if (!best || best.improvement <= 0) {
    const w = findWiggleMove(graph);
    if (w && w.improvement > 0) best = w;
  }
  
  if (best && best.improvement > 0) {
    best.node[0] = best.toX;
    best.node[1] = best.toY;
    return { done: false, improved: true, strategy: best.strategy, improvement: best.improvement };
  }
  
  // Escape wiggle
  const w = findWiggleMove(graph);
  if (w) {
    w.node[0] = w.toX;
    w.node[1] = w.toY;
    return { done: false, improved: false, strategy: 'escape' };
  }
  
  return { done: false, improved: false };
}

function solvePuzzle(nodeCount, maxMoves = 500, maxStuck = 30) {
  const graph = scramble(planarGraph(nodeCount));
  const initialCrossings = intersections(graph.links);
  
  let moves = 0;
  let stuckCount = 0;
  const strategyUsage = {};
  
  while (moves < maxMoves && stuckCount < maxStuck) {
    const result = solverStep(graph);
    
    if (result.done) {
      return { solved: true, moves, initialCrossings, finalCrossings: 0, strategyUsage };
    }
    
    if (result.improved) {
      moves++;
      stuckCount = 0;
      strategyUsage[result.strategy] = (strategyUsage[result.strategy] || 0) + 1;
    } else {
      stuckCount++;
      if (result.strategy) {
        moves++;
        strategyUsage[result.strategy] = (strategyUsage[result.strategy] || 0) + 1;
      }
    }
  }
  
  const finalCrossings = intersections(graph.links);
  return { solved: false, moves, initialCrossings, finalCrossings, strategyUsage };
}

// ============ BENCHMARK ============

function runBenchmark(numPuzzles = 20, nodeCount = 40) {
  console.log(`Running benchmark: ${numPuzzles} puzzles, ${nodeCount} nodes each...`);
  
  const results = [];
  let solved = 0;
  let totalMoves = 0;
  const strategyTotals = {};
  
  for (let i = 0; i < numPuzzles; i++) {
    const result = solvePuzzle(nodeCount);
    results.push(result);
    
    if (result.solved) {
      solved++;
      totalMoves += result.moves;
    }
    
    Object.keys(result.strategyUsage).forEach(s => {
      strategyTotals[s] = (strategyTotals[s] || 0) + result.strategyUsage[s];
    });
    
    // Progress
    if ((i + 1) % 5 === 0) {
      console.log(`  ${i + 1}/${numPuzzles} complete, ${solved} solved so far...`);
    }
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

// Run
runBenchmark(20, 40);
