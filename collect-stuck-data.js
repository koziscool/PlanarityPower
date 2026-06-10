#!/usr/bin/env node
// Collects graph state snapshots at "stuck points" for Stage 2 pattern analysis
// Run: node collect-stuck-data.js [vertexCount] [numPuzzles]

const fs = require('fs');
const solver = require('./solver.js');

const vertexCount = parseInt(process.argv[2]) || 20;
const numPuzzles = parseInt(process.argv[3]) || 100;
const outputFile = `stuck-data-${vertexCount}v.jsonl`;

console.log(`Collecting stuck-point data: ${numPuzzles} puzzles with ${vertexCount} vertices`);
console.log(`Output: ${outputFile}\n`);

let solved = 0;
let stuck = 0;
let totalMoves = 0;
const startTime = Date.now();

// Clear output file
fs.writeFileSync(outputFile, '');

for (let i = 0; i < numPuzzles; i++) {
  const graph = solver.scramble(solver.planarGraph(vertexCount));
  const initialCrossings = solver.intersections(graph.links);
  
  const state = { pauseBeforeEscape: true };
  let moves = 0;
  const maxMoves = 300;
  
  // Run until first escape trigger or solved
  while (moves < maxMoves) {
    const result = solver.solverStep(graph, state);
    
    if (result.done) {
      solved++;
      totalMoves += moves;
      break;
    }
    
    if (result.wouldEscape) {
      // Capture snapshot at stuck point
      stuck++;
      totalMoves += moves;
      
      const snapshot = captureSnapshot(graph, state, moves, initialCrossings, result.count);
      fs.appendFileSync(outputFile, JSON.stringify(snapshot) + '\n');
      break;
    }
    
    moves++;
  }
  
  // Progress indicator
  if ((i + 1) % 10 === 0) {
    const pct = ((i + 1) / numPuzzles * 100).toFixed(0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r${pct}% (${i + 1}/${numPuzzles}) - ${elapsed}s`);
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
console.log(`\n\nDone in ${elapsed}s`);
console.log(`Solved: ${solved}/${numPuzzles} (${(solved/numPuzzles*100).toFixed(1)}%)`);
console.log(`Stuck:  ${stuck}/${numPuzzles} (${(stuck/numPuzzles*100).toFixed(1)}%)`);
console.log(`Avg moves: ${(totalMoves/numPuzzles).toFixed(1)}`);

if (stuck > 0) {
  console.log(`\nStuck snapshots saved to ${outputFile}`);
}

// Capture rich graph state for pattern analysis
function captureSnapshot(graph, state, moves, initialCrossings, currentCrossings) {
  // Refresh intersection info
  solver.intersections(graph.links);
  
  const nodes = graph.nodes;
  const links = graph.links;
  
  // Node data
  const nodeData = nodes.map((n, i) => {
    const neighbors = [];
    links.forEach(link => {
      if (link[0] === n) neighbors.push(nodes.indexOf(link[1]));
      else if (link[1] === n) neighbors.push(nodes.indexOf(link[0]));
    });
    
    return {
      idx: i,
      x: n[0],
      y: n[1],
      yellow: !n.intersection,
      degree: neighbors.length,
      neighbors: neighbors
    };
  });
  
  // Edge data with crossing info
  const edgeData = links.map((link, i) => {
    const srcIdx = nodes.indexOf(link[0]);
    const tgtIdx = nodes.indexOf(link[1]);
    const dx = link[1][0] - link[0][0];
    const dy = link[1][1] - link[0][1];
    const length = Math.sqrt(dx*dx + dy*dy);
    
    return {
      idx: i,
      src: srcIdx,
      tgt: tgtIdx,
      length: length,
      hasCrossing: link.intersection || false
    };
  });
  
  // Find which edges cross which
  const crossingPairs = [];
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      if (edgesIntersect(links[i], links[j])) {
        crossingPairs.push([i, j]);
      }
    }
  }
  
  // Cluster analysis - yellow vertices that are spatially close
  const yellowIdxs = nodeData.filter(n => n.yellow).map(n => n.idx);
  const clumps = findClumpsSimple(nodes, yellowIdxs, 0.12);
  
  // Anchor scores (simplified - based on yellow neighbor count)
  const anchorScores = nodeData.map(n => {
    let score = 0;
    n.neighbors.forEach(nidx => {
      if (nodeData[nidx].yellow) score++;
    });
    return score / Math.max(1, n.degree);
  });
  
  return {
    vertexCount: nodes.length,
    edgeCount: links.length,
    moves: moves,
    initialCrossings: initialCrossings,
    currentCrossings: currentCrossings,
    yellowCount: yellowIdxs.length,
    clumpCount: clumps.length,
    clumpSizes: clumps.map(c => c.length),
    nodes: nodeData,
    edges: edgeData,
    crossingPairs: crossingPairs,
    anchorScores: anchorScores
  };
}

// Simple edge intersection test
function edgesIntersect(e1, e2) {
  // Skip if edges share a vertex
  if (e1[0] === e2[0] || e1[0] === e2[1] || e1[1] === e2[0] || e1[1] === e2[1]) {
    return false;
  }
  
  const x1 = e1[0][0], y1 = e1[0][1], x2 = e1[1][0], y2 = e1[1][1];
  const x3 = e2[0][0], y3 = e2[0][1], x4 = e2[1][0], y4 = e2[1][1];
  
  const denom = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
  if (Math.abs(denom) < 1e-10) return false;
  
  const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / denom;
  const u = -((x1-x2)*(y1-y3) - (y1-y2)*(x1-x3)) / denom;
  
  return t > 0 && t < 1 && u > 0 && u < 1;
}

// Simple clump finding (union-find on yellow vertices within distance)
function findClumpsSimple(nodes, yellowIdxs, maxDist) {
  if (yellowIdxs.length === 0) return [];
  
  const parent = {};
  yellowIdxs.forEach(i => parent[i] = i);
  
  function find(i) {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }
  
  function union(i, j) {
    const pi = find(i), pj = find(j);
    if (pi !== pj) parent[pi] = pj;
  }
  
  // Union nearby yellow vertices
  for (let i = 0; i < yellowIdxs.length; i++) {
    for (let j = i + 1; j < yellowIdxs.length; j++) {
      const n1 = nodes[yellowIdxs[i]], n2 = nodes[yellowIdxs[j]];
      const dx = n1[0] - n2[0], dy = n1[1] - n2[1];
      if (Math.sqrt(dx*dx + dy*dy) < maxDist) {
        union(yellowIdxs[i], yellowIdxs[j]);
      }
    }
  }
  
  // Group by root
  const groups = {};
  yellowIdxs.forEach(i => {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(i);
  });
  
  return Object.values(groups);
}
