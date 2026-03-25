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
        node[0] = 0.02 + Math.random() * 0.96;
        node[1] = 0.02 + Math.random() * 0.96;
        
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
        
        node[0] = Math.max(0.02, Math.min(0.98, cx));
        node[1] = Math.max(0.02, Math.min(0.98, cy));
        
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
          node[0] = 0.05 + gx * 0.06;
          node[1] = 0.05 + gy * 0.06;
          
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
    
    // Just pick a random position
    node[0] = 0.02 + Math.random() * 0.96;
    node[1] = 0.02 + Math.random() * 0.96;
    
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
  
  // Main solver step
  function solverStep(graph, state) {
    state = state || {};
    var count = intersections(graph.links);
    
    if (count === 0) {
      return { done: true, count: 0 };
    }
    
    // For endgame, try grid search first
    var gridMove = null;
    if (count <= 15) {
      gridMove = findGridMove(graph);
    }
    
    // Wide random search
    var randomMove = findBestMove(graph, 30);
    
    // Pick the best
    var best = null;
    if (gridMove && (!randomMove || gridMove.improvement > randomMove.improvement)) {
      best = gridMove;
    } else {
      best = randomMove;
    }
    
    if (best && best.improvement > 0) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      var newCount = intersections(graph.links);
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
  
  // ============ EXPORTS ============
  
  exports.cross = cross;
  exports.intersect = intersect;
  exports.intersections = intersections;
  exports.planarGraph = planarGraph;
  exports.scramble = scramble;
  exports.getNeighbors = getNeighbors;
  exports.findBestMove = findBestMove;
  exports.findGridMove = findGridMove;
  exports.findEscapeMove = findEscapeMove;
  exports.solverStep = solverStep;
  exports.solvePuzzle = solvePuzzle;
  
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Solver = {}));
