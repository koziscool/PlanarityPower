// Shared solver code for dashboard.html and benchmark.js
// Browser: include via <script src="solver.js">
// Node.js: const solver = require('./solver.js')

(function(exports) {
  
  // ============ CORE GRAPH FUNCTIONS ============
  
  function cross(a, b) {
    return a[0] * b[1] - a[1] * b[0];
  }
  
  function intersect(a, b) {
    if (a[0] === b[0] && a[1] === b[1] || a[0] === b[1] && a[1] === b[0]) return true;
    var p = a[0], r = [a[1][0] - p[0], a[1][1] - p[1]];
    var q = b[0], s = [b[1][0] - q[0], b[1][1] - q[1]];
    var rxs = cross(r, s);
    var q_p = [q[0] - p[0], q[1] - p[1]];
    var t = cross(q_p, s) / rxs;
    var u = cross(q_p, r) / rxs;
    var epsilon = 1e-6;
    return t > epsilon && t < 1 - epsilon && u > epsilon && u < 1 - epsilon;
  }
  
  function intersections(links) {
    var n = links.length, count = 0;
    for (var i = 0; i < n; i++) {
      links[i].intersection = false;
      links[i][0].intersection = false;
      links[i][1].intersection = false;
    }
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
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
    var points = [], links = [];
    for (var i = 0; i < n; i++) points[i] = [Math.random(), Math.random()];
    for (var i = 0; i < n; i++) {
      var link = [points[i], points[~~(Math.random() * n)]];
      if (!links.some(function(to) { return intersect(link, to); })) links.push(link);
    }
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var link = [points[i], points[j]];
        if (!links.some(function(to) { return intersect(link, to); })) links.push(link);
      }
    }
    return { nodes: points, links: links };
  }
  
  function scramble(graph) {
    if (graph.nodes.length < 4) return graph;
    do {
      graph.nodes.forEach(function(node) {
        node[0] = Math.random();
        node[1] = Math.random();
      });
    } while (!intersections(graph.links));
    return graph;
  }
  
  function getNeighbors(graph, node) {
    var neighbors = [];
    graph.links.forEach(function(link) {
      if (link[0] === node) neighbors.push(link[1]);
      else if (link[1] === node) neighbors.push(link[0]);
    });
    return neighbors;
  }
  
  // Check if position is too close to any other node
  var MIN_NODE_DIST = 0.01; // minimum distance between nodes (~4 pixels)
  
  function isTooClose(graph, node, x, y) {
    for (var j = 0; j < graph.nodes.length; j++) {
      var other = graph.nodes[j];
      if (other === node) continue;
      var dx = x - other[0];
      var dy = y - other[1];
      if (dx * dx + dy * dy < MIN_NODE_DIST * MIN_NODE_DIST) {
        return true;
      }
    }
    return false;
  }
  
  // ============ CROSSING COUNT PER VERTEX ============
  
  function getCrossingCounts(graph) {
    var counts = [];
    var links = graph.links;
    
    for (var i = 0; i < graph.nodes.length; i++) {
      counts[i] = 0;
    }
    
    for (var i = 0; i < links.length; i++) {
      for (var j = i + 1; j < links.length; j++) {
        if (intersect(links[i], links[j])) {
          var a0 = graph.nodes.indexOf(links[i][0]);
          var a1 = graph.nodes.indexOf(links[i][1]);
          var b0 = graph.nodes.indexOf(links[j][0]);
          var b1 = graph.nodes.indexOf(links[j][1]);
          counts[a0]++;
          counts[a1]++;
          counts[b0]++;
          counts[b1]++;
        }
      }
    }
    
    return counts;
  }
  
  // ============ BOTTLENECK MOVE ============
  // Find vertices with high crossingCount relative to degree and move them
  
  function findBottleneckMove(graph, samplesPerNode) {
    samplesPerNode = samplesPerNode || 20;
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var crossingCounts = getCrossingCounts(graph);
    
    // Score each vertex: crossingCount / (neighborCount + 1)
    // Higher score = more "bottlenecky" - causing many crossings for its degree
    var scored = graph.nodes.map(function(node, i) {
      var neighbors = getNeighbors(graph, node);
      var cc = crossingCounts[i];
      var score = cc / (neighbors.length + 1);
      return { node: node, index: i, crossingCount: cc, neighborCount: neighbors.length, score: score };
    });
    
    // Sort by score descending - prioritize worst bottlenecks
    scored.sort(function(a, b) { return b.score - a.score; });
    
    var bestMove = null;
    var bestImprovement = 0;
    
    // Focus on top bottlenecks (top 30% or at least 5)
    var numToCheck = Math.max(5, Math.floor(graph.nodes.length * 0.3));
    
    for (var si = 0; si < Math.min(numToCheck, scored.length); si++) {
      var item = scored[si];
      if (item.crossingCount === 0) continue;
      
      var node = item.node;
      var i = item.index;
      var origX = node[0], origY = node[1];
      var neighbors = getNeighbors(graph, node);
      
      // Strategy 1: Move to neighbor centroid (usually very effective for bottlenecks)
      if (neighbors.length > 0) {
        var cx = 0, cy = 0;
        neighbors.forEach(function(n) { cx += n[0]; cy += n[1]; });
        cx /= neighbors.length;
        cy /= neighbors.length;
        cx = Math.max(0.02, Math.min(0.98, cx));
        cy = Math.max(0.02, Math.min(0.98, cy));
        
        if (!isTooClose(graph, node, cx, cy)) {
          node[0] = cx;
          node[1] = cy;
          
          var newCount = intersections(graph.links);
          var improvement = count - newCount;
          
          if (improvement > bestImprovement) {
            bestImprovement = improvement;
            bestMove = {
              node: node,
              nodeIndex: i,
              fromX: origX,
              fromY: origY,
              toX: cx,
              toY: cy,
              improvement: improvement,
              strategy: 'bottleneck-centroid'
            };
          }
          
          node[0] = origX;
          node[1] = origY;
        }
      }
      
      // Strategy 2: Sample positions biased toward graph center
      for (var s = 0; s < samplesPerNode; s++) {
        // Bias toward center (0.3-0.7 range more likely)
        var newX = 0.15 + Math.random() * 0.7;
        var newY = 0.15 + Math.random() * 0.7;
        
        if (isTooClose(graph, node, newX, newY)) continue;
        
        node[0] = newX;
        node[1] = newY;
        
        var newCount = intersections(graph.links);
        var improvement = count - newCount;
        
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestMove = {
            node: node,
            nodeIndex: i,
            fromX: origX,
            fromY: origY,
            toX: newX,
            toY: newY,
            improvement: improvement,
            strategy: 'bottleneck-sample'
          };
        }
        
        node[0] = origX;
        node[1] = origY;
      }
    }
    
    intersections(graph.links);
    return bestMove;
  }
  
  // ============ WIDE GREEDY SOLVER ============
  // Try many random positions for each node, pick the one that reduces crossings most
  
  function findBestMove(graph, samplesPerNode) {
    samplesPerNode = samplesPerNode || 30;
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var bestMove = null;
    var bestImprovement = 0;
    
    // Consider ALL nodes, not just intersecting ones
    graph.nodes.forEach(function(node, i) {
      var origX = node[0], origY = node[1];
      
      // Sample random positions
      for (var s = 0; s < samplesPerNode; s++) {
        var newX = 0.02 + Math.random() * 0.96;
        var newY = 0.02 + Math.random() * 0.96;
        
        // Skip if too close to another node
        if (isTooClose(graph, node, newX, newY)) continue;
        
        node[0] = newX;
        node[1] = newY;
        
        var newCount = intersections(graph.links);
        var improvement = count - newCount;
        
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestMove = {
            node: node,
            nodeIndex: i,
            fromX: origX,
            fromY: origY,
            toX: node[0],
            toY: node[1],
            improvement: improvement,
            strategy: 'random'
          };
        }
      }
      
      // Also try neighbor centroid
      var neighbors = getNeighbors(graph, node);
      if (neighbors.length > 0) {
        var cx = 0, cy = 0;
        neighbors.forEach(function(n) { cx += n[0]; cy += n[1]; });
        cx /= neighbors.length;
        cy /= neighbors.length;
        
        cx = Math.max(0.02, Math.min(0.98, cx));
        cy = Math.max(0.02, Math.min(0.98, cy));
        
        // Skip if too close to another node
        if (isTooClose(graph, node, cx, cy)) {
          node[0] = origX;
          node[1] = origY;
          return;
        }
        
        node[0] = cx;
        node[1] = cy;
        
        var newCount = intersections(graph.links);
        var improvement = count - newCount;
        
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestMove = {
            node: node,
            nodeIndex: i,
            fromX: origX,
            fromY: origY,
            toX: node[0],
            toY: node[1],
            improvement: improvement,
            strategy: 'centroid'
          };
        }
      }
      
      // Restore
      node[0] = origX;
      node[1] = origY;
    });
    
    intersections(graph.links);
    return bestMove;
  }
  
  // Grid search for endgame (low crossings)
  function findGridMove(graph) {
    var count = intersections(graph.links);
    if (count === 0 || count > 15) return null;
    
    var candidates = graph.nodes.filter(function(n) { return n.intersection; });
    var bestMove = null;
    var bestImprovement = 0;
    
    candidates.forEach(function(node) {
      var i = graph.nodes.indexOf(node);
      var origX = node[0], origY = node[1];
      
      // 15x15 grid search
      for (var gx = 0; gx < 15; gx++) {
        for (var gy = 0; gy < 15; gy++) {
          var newX = 0.05 + gx * 0.06;
          var newY = 0.05 + gy * 0.06;
          
          // Skip if too close to another node
          if (isTooClose(graph, node, newX, newY)) continue;
          
          node[0] = newX;
          node[1] = newY;
          
          var newCount = intersections(graph.links);
          var improvement = count - newCount;
          
          if (improvement > bestImprovement) {
            bestImprovement = improvement;
            bestMove = {
              node: node,
              nodeIndex: i,
              fromX: origX,
              fromY: origY,
              toX: node[0],
              toY: node[1],
              improvement: improvement,
              strategy: 'grid'
            };
          }
        }
      }
      
      node[0] = origX;
      node[1] = origY;
    });
    
    intersections(graph.links);
    return bestMove;
  }
  
  // Random escape move when stuck
  function findEscapeMove(graph) {
    var count = intersections(graph.links);
    var candidates = graph.nodes.filter(function(n) { return n.intersection; });
    if (candidates.length === 0) return null;
    
    var node = candidates[Math.floor(Math.random() * candidates.length)];
    var i = graph.nodes.indexOf(node);
    var origX = node[0], origY = node[1];
    
    // Try random positions until we find one not too close to others
    var newX, newY;
    var attempts = 0;
    do {
      newX = 0.02 + Math.random() * 0.96;
      newY = 0.02 + Math.random() * 0.96;
      attempts++;
    } while (isTooClose(graph, node, newX, newY) && attempts < 20);
    
    node[0] = newX;
    node[1] = newY;
    
    var newCount = intersections(graph.links);
    var improvement = count - newCount;
    
    var move = {
      node: node,
      nodeIndex: i,
      fromX: origX,
      fromY: origY,
      toX: node[0],
      toY: node[1],
      improvement: improvement,
      strategy: 'escape'
    };
    
    node[0] = origX;
    node[1] = origY;
    intersections(graph.links);
    
    return move;
  }
  
  // Main solver step - stage-aware strategy selection
  function solverStep(graph, state) {
    state = state || {};
    var count = intersections(graph.links);
    
    if (count === 0) {
      return { done: true, count: 0 };
    }
    
    var best = null;
    
    // Early game (many crossings): prioritize bottleneck moves
    if (count > 50) {
      best = findBottleneckMove(graph, 25);
      if (!best || best.improvement <= 0) {
        best = findGrowClumpMove(graph);
      }
      if (!best || best.improvement <= 0) {
        best = findBestMove(graph, 20);
      }
    }
    // Mid game: balance bottleneck and clump growing
    else if (count > 15) {
      best = findGrowClumpMove(graph);
      if (!best || best.improvement <= 0) {
        best = findBottleneckMove(graph, 20);
      }
      if (!best || best.improvement <= 0) {
        best = findBestMove(graph, 20);
      }
    }
    // Late game: grid search becomes viable
    else {
      best = findGridMove(graph);
      if (!best || best.improvement <= 0) {
        best = findGrowClumpMove(graph);
      }
      if (!best || best.improvement <= 0) {
        best = findBottleneckMove(graph, 15);
      }
      if (!best || best.improvement <= 0) {
        best = findBestMove(graph, 30);
      }
    }
    
    if (best && best.improvement > 0) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      var newCount = intersections(graph.links);
      state.stuckCount = 0;
      return { done: false, improved: true, move: best, count: newCount };
    }
    
    // Stuck - try escape
    state.stuckCount = (state.stuckCount || 0) + 1;
    
    if (state.stuckCount > 50) {
      return { done: false, stuck: true, count: count };
    }
    
    var escape = findEscapeMove(graph);
    if (escape) {
      escape.node[0] = escape.toX;
      escape.node[1] = escape.toY;
      var newCount = intersections(graph.links);
      return { done: false, improved: escape.improvement > 0, move: escape, count: newCount };
    }
    
    return { done: false, stuck: true, count: count };
  }
  
  // Solve a puzzle completely (for benchmarking)
  function solvePuzzle(nodeCount, maxMoves, maxStuck) {
    maxMoves = maxMoves || 500;
    maxStuck = maxStuck || 50;
    
    var graph = scramble(planarGraph(nodeCount));
    var initialCrossings = intersections(graph.links);
    
    var moves = 0;
    var stuckCount = 0;
    var strategyUsage = {};
    var state = {};
    
    while (moves < maxMoves) {
      var result = solverStep(graph, state);
      
      if (result.done) {
        return { solved: true, moves: moves, initialCrossings: initialCrossings, finalCrossings: 0, strategyUsage: strategyUsage };
      }
      
      if (result.stuck) {
        return { solved: false, moves: moves, initialCrossings: initialCrossings, finalCrossings: result.count, strategyUsage: strategyUsage, reason: 'stuck' };
      }
      
      moves++;
      if (result.move) {
        strategyUsage[result.move.strategy] = (strategyUsage[result.move.strategy] || 0) + 1;
        
        if (result.improved) {
          state.stuckCount = 0;
        }
      }
    }
    
    var finalCrossings = intersections(graph.links);
    return { solved: false, moves: moves, initialCrossings: initialCrossings, finalCrossings: finalCrossings, strategyUsage: strategyUsage, reason: 'max-moves' };
  }
  
  // ============ CLUMP-BASED MOVES ============
  
  // Find clumps of conflict-free vertices (spatially connected yellow regions)
  function findClumps(graph, maxDist) {
    maxDist = maxDist || 0.12;
    intersections(graph.links); // ensure intersection flags are fresh
    var yellow = graph.nodes.filter(function(n) { return !n.intersection; });
    var visited = new Set();
    var clumps = [];
    
    yellow.forEach(function(node) {
      if (visited.has(node)) return;
      
      var clump = [];
      var queue = [node];
      visited.add(node);
      
      while (queue.length > 0) {
        var curr = queue.shift();
        clump.push(curr);
        
        yellow.forEach(function(other) {
          if (visited.has(other)) return;
          var dx = curr[0] - other[0];
          var dy = curr[1] - other[1];
          if (dx * dx + dy * dy < maxDist * maxDist) {
            visited.add(other);
            queue.push(other);
          }
        });
      }
      
      if (clump.length > 0) clumps.push(clump);
    });
    
    // Sort by size, largest first
    clumps.sort(function(a, b) { return b.length - a.length; });
    return clumps;
  }
  
  // Find blue vertices that are graph-connected to a clump
  function getClumpBorder(graph, clump) {
    var clumpSet = new Set(clump);
    var border = [];
    
    clump.forEach(function(node) {
      var neighbors = getNeighbors(graph, node);
      neighbors.forEach(function(neighbor) {
        if (neighbor.intersection && border.indexOf(neighbor) === -1) {
          border.push(neighbor);
        }
      });
    });
    
    return border;
  }
  
  // Try to grow the largest clump by placing a border vertex in a conflict-free position
  function findGrowClumpMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var clumps = findClumps(graph);
    if (clumps.length === 0) {
      // No clumps yet - try to create one by finding any vertex that can become conflict-free
      clumps = [[]]; // empty clump, will check all blue vertices
    }
    
    var bestMove = null;
    var bestImprovement = 0;
    
    // Try to grow each clump, prioritizing largest
    for (var ci = 0; ci < Math.min(clumps.length, 3); ci++) {
      var clump = clumps[ci];
      var border = clump.length > 0 ? getClumpBorder(graph, clump) : graph.nodes.filter(function(n) { return n.intersection; });
      
      // For each border vertex, try to find a position that makes it conflict-free
      border.forEach(function(node) {
        var i = graph.nodes.indexOf(node);
        var origX = node[0], origY = node[1];
        
        // If clump exists, try positions near the clump
        if (clump.length > 0) {
          // Calculate clump center
          var cx = 0, cy = 0;
          clump.forEach(function(c) { cx += c[0]; cy += c[1]; });
          cx /= clump.length;
          cy /= clump.length;
          
          // Try positions around the clump edge
          for (var angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
            for (var dist = 0.05; dist <= 0.2; dist += 0.05) {
              var newX = cx + Math.cos(angle) * dist;
              var newY = cy + Math.sin(angle) * dist;
              
              if (newX < 0.02 || newX > 0.98 || newY < 0.02 || newY > 0.98) continue;
              if (isTooClose(graph, node, newX, newY)) continue;
              
              node[0] = newX;
              node[1] = newY;
              
              var newCount = intersections(graph.links);
              var improvement = count - newCount;
              
              // Bonus if this vertex is now conflict-free (joined the clump)
              if (!node.intersection) improvement += 2;
              
              if (improvement > bestImprovement) {
                bestImprovement = improvement;
                bestMove = {
                  node: node,
                  nodeIndex: i,
                  fromX: origX,
                  fromY: origY,
                  toX: newX,
                  toY: newY,
                  improvement: count - newCount,
                  strategy: 'grow'
                };
              }
            }
          }
        }
        
        // Also try neighbor centroid
        var neighbors = getNeighbors(graph, node);
        if (neighbors.length > 0) {
          var ncx = 0, ncy = 0;
          neighbors.forEach(function(n) { ncx += n[0]; ncy += n[1]; });
          ncx /= neighbors.length;
          ncy /= neighbors.length;
          
          if (!isTooClose(graph, node, ncx, ncy)) {
            node[0] = ncx;
            node[1] = ncy;
            
            var newCount = intersections(graph.links);
            var improvement = count - newCount;
            if (!node.intersection) improvement += 2;
            
            if (improvement > bestImprovement) {
              bestImprovement = improvement;
              bestMove = {
                node: node,
                nodeIndex: i,
                fromX: origX,
                fromY: origY,
                toX: ncx,
                toY: ncy,
                improvement: count - newCount,
                strategy: 'grow'
              };
            }
          }
        }
        
        node[0] = origX;
        node[1] = origY;
      });
    }
    
    intersections(graph.links);
    return bestMove;
  }
  
  // Move entire clump as a rigid body to create space
  function findMoveClumpMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var clumps = findClumps(graph);
    if (clumps.length === 0 || clumps[0].length < 2) return null;
    
    var bestMove = null;
    var bestImprovement = 0;
    
    // Try moving the largest clump
    var clump = clumps[0];
    
    // Calculate clump center
    var cx = 0, cy = 0;
    clump.forEach(function(c) { cx += c[0]; cy += c[1]; });
    cx /= clump.length;
    cy /= clump.length;
    
    // Save original positions
    var origPositions = clump.map(function(n) { return [n[0], n[1]]; });
    
    // Try translating in various directions
    var directions = [];
    for (var angle = 0; angle < Math.PI * 2; angle += Math.PI / 6) {
      directions.push([Math.cos(angle), Math.sin(angle)]);
    }
    
    directions.forEach(function(dir) {
      for (var dist = 0.03; dist <= 0.1; dist += 0.02) {
        var dx = dir[0] * dist;
        var dy = dir[1] * dist;
        
        // Move all clump nodes
        var valid = true;
        clump.forEach(function(node, i) {
          var newX = origPositions[i][0] + dx;
          var newY = origPositions[i][1] + dy;
          
          if (newX < 0.02 || newX > 0.98 || newY < 0.02 || newY > 0.98) {
            valid = false;
          }
          node[0] = newX;
          node[1] = newY;
        });
        
        if (valid) {
          var newCount = intersections(graph.links);
          var improvement = count - newCount;
          
          if (improvement > bestImprovement) {
            bestImprovement = improvement;
            bestMove = {
              clump: clump,
              dx: dx,
              dy: dy,
              improvement: improvement,
              strategy: 'shift'
            };
          }
        }
        
        // Restore
        clump.forEach(function(node, i) {
          node[0] = origPositions[i][0];
          node[1] = origPositions[i][1];
        });
      }
    });
    
    intersections(graph.links);
    return bestMove;
  }
  
  // ============ EXPORTS ============
  
  exports.cross = cross;
  exports.intersect = intersect;
  exports.intersections = intersections;
  exports.planarGraph = planarGraph;
  exports.scramble = scramble;
  exports.getNeighbors = getNeighbors;
  exports.findBestMove = findBestMove;
  exports.findBottleneckMove = findBottleneckMove;
  exports.getCrossingCounts = getCrossingCounts;
  exports.findGridMove = findGridMove;
  exports.findEscapeMove = findEscapeMove;
  exports.findGrowClumpMove = findGrowClumpMove;
  exports.findMoveClumpMove = findMoveClumpMove;
  exports.findClumps = findClumps;
  exports.solverStep = solverStep;
  exports.solvePuzzle = solvePuzzle;
  
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Solver = {}));
