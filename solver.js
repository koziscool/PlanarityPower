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
  
  // ============ ANCHOR SCORING ============
  // Compute how "anchored" a vertex is - high score means fixed/constraining,
  // low score means free-floating/easily moveable
  
  function anchorScore(graph, node) {
    var neighbors = getNeighbors(graph, node);
    if (neighbors.length === 0) return 0;
    
    // Factor 1: What fraction of neighbors are conflict-free (yellow)?
    var yellowCount = 0;
    for (var i = 0; i < neighbors.length; i++) {
      if (!neighbors[i].intersection) yellowCount++;
    }
    var yellowRatio = yellowCount / neighbors.length;
    
    // Factor 2: How directionally clustered are the neighbors?
    // If all neighbors are in one direction, this vertex is strongly anchored
    var cx = node[0], cy = node[1];
    var angles = [];
    for (var i = 0; i < neighbors.length; i++) {
      var dx = neighbors[i][0] - cx;
      var dy = neighbors[i][1] - cy;
      angles.push(Math.atan2(dy, dx));
    }
    
    // Compute angular spread - low spread = clustered = high anchor
    var directionScore = 0;
    if (angles.length >= 2) {
      angles.sort(function(a, b) { return a - b; });
      var maxGap = 0;
      for (var i = 0; i < angles.length; i++) {
        var next = (i + 1) % angles.length;
        var gap = angles[next] - angles[i];
        if (next === 0) gap += 2 * Math.PI; // wrap around
        if (gap > maxGap) maxGap = gap;
      }
      // maxGap near 2*PI means neighbors clustered in one direction
      // maxGap near PI means neighbors spread evenly
      directionScore = (maxGap - Math.PI) / Math.PI; // 0 to 1
      directionScore = Math.max(0, Math.min(1, directionScore));
    }
    
    // Factor 3: Neighbor degree - high-degree neighbors are more anchoring
    var avgNeighborDegree = 0;
    for (var i = 0; i < neighbors.length; i++) {
      avgNeighborDegree += getNeighbors(graph, neighbors[i]).length;
    }
    avgNeighborDegree /= neighbors.length;
    var degreeScore = Math.min(1, avgNeighborDegree / 10); // normalize to 0-1
    
    // Combine factors: yellow neighbors matter most, then direction, then degree
    var score = yellowRatio * 0.5 + directionScore * 0.3 + degreeScore * 0.2;
    return score;
  }
  
  // Compute weighted centroid - weight neighbors by their anchor score
  // Anchored (yellow, fixed) neighbors pull harder than free-floating ones
  function weightedCentroid(graph, node) {
    var neighbors = getNeighbors(graph, node);
    if (neighbors.length === 0) return null;
    
    var totalWeight = 0;
    var wx = 0, wy = 0;
    
    for (var i = 0; i < neighbors.length; i++) {
      var neighbor = neighbors[i];
      // Base weight: conflict-free neighbors get higher weight
      var weight = neighbor.intersection ? 0.3 : 1.0;
      
      // Boost weight by neighbor's anchor score
      var neighborAnchor = anchorScore(graph, neighbor);
      weight *= (0.5 + neighborAnchor); // range 0.5 to 1.5 multiplier
      
      wx += neighbor[0] * weight;
      wy += neighbor[1] * weight;
      totalWeight += weight;
    }
    
    if (totalWeight === 0) return centroid(neighbors);
    return [wx / totalWeight, wy / totalWeight];
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
  
  // ============ INCREMENTAL CROSSING DETECTION ============
  // Instead of O(E²) full recount, compute delta for a single node move: O(degree × E)
  
  // Get edges connected to a node
  function getNodeEdges(graph, node) {
    var edges = [];
    for (var i = 0; i < graph.links.length; i++) {
      var link = graph.links[i];
      if (link[0] === node || link[1] === node) {
        edges.push(link);
      }
    }
    return edges;
  }
  
  // Count crossings involving a set of edges (against all other edges)
  function countEdgeCrossings(graph, edges) {
    var crossingCount = 0;
    var edgeSet = new Set(edges);
    
    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      for (var j = 0; j < graph.links.length; j++) {
        var other = graph.links[j];
        if (edgeSet.has(other)) continue; // Don't double-count edges in our set
        if (intersect(edge, other)) {
          crossingCount++;
        }
      }
    }
    
    // Also count crossings between edges in the set
    for (var i = 0; i < edges.length; i++) {
      for (var j = i + 1; j < edges.length; j++) {
        if (intersect(edges[i], edges[j])) {
          crossingCount++;
        }
      }
    }
    
    return crossingCount;
  }
  
  // Evaluate a node move incrementally - returns crossing delta (negative = improvement)
  // Much faster than full intersections() call: O(degree × E) vs O(E²)
  function evaluateMoveDelta(graph, node, newX, newY, baseCount) {
    var edges = getNodeEdges(graph, node);
    if (edges.length === 0) return 0;
    
    // Count crossings before move
    var crossingsBefore = countEdgeCrossings(graph, edges);
    
    // Temporarily move node
    var oldX = node[0], oldY = node[1];
    node[0] = newX;
    node[1] = newY;
    
    // Count crossings after move
    var crossingsAfter = countEdgeCrossings(graph, edges);
    
    // Restore
    node[0] = oldX;
    node[1] = oldY;
    
    return crossingsAfter - crossingsBefore; // negative = improvement
  }
  
  // Fast version of findBestMove using incremental evaluation
  function findBestMoveFast(graph, samplesPerNode) {
    samplesPerNode = samplesPerNode || 30;
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var bestMove = null;
    var bestImprovement = 0;
    
    // Only check nodes involved in crossings
    var candidates = graph.nodes.filter(function(n) { return n.intersection; });
    
    candidates.forEach(function(node) {
      var i = graph.nodes.indexOf(node);
      var origX = node[0], origY = node[1];
      
      // Sample random positions
      for (var s = 0; s < samplesPerNode; s++) {
        var newX = 0.02 + Math.random() * 0.96;
        var newY = 0.02 + Math.random() * 0.96;
        
        if (isTooClose(graph, node, newX, newY)) continue;
        
        var delta = evaluateMoveDelta(graph, node, newX, newY, count);
        var improvement = -delta; // delta is negative when improving
        
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
            strategy: 'random-fast'
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
        
        if (!isTooClose(graph, node, cx, cy)) {
          var delta = evaluateMoveDelta(graph, node, cx, cy, count);
          var improvement = -delta;
          
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
              strategy: 'centroid-fast'
            };
          }
        }
      }
    });
    
    return bestMove;
  }
  
  // Fast bottleneck move finder
  function findBottleneckMoveFast(graph, samplesPerNode) {
    samplesPerNode = samplesPerNode || 20;
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var crossingCounts = getCrossingCounts(graph);
    
    // Score each intersecting vertex
    var scored = [];
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (!node.intersection) continue;
      var neighbors = getNeighbors(graph, node);
      var cc = crossingCounts[i];
      var score = cc / (neighbors.length + 1);
      scored.push({ node: node, index: i, crossingCount: cc, score: score });
    }
    
    scored.sort(function(a, b) { return b.score - a.score; });
    
    var bestMove = null;
    var bestImprovement = 0;
    var numToCheck = Math.min(10, scored.length);
    
    for (var si = 0; si < numToCheck; si++) {
      var item = scored[si];
      var node = item.node;
      var idx = item.index;
      var origX = node[0], origY = node[1];
      var neighbors = getNeighbors(graph, node);
      
      // Try neighbor centroid first (usually best for bottlenecks)
      if (neighbors.length > 0) {
        var cx = 0, cy = 0;
        neighbors.forEach(function(n) { cx += n[0]; cy += n[1]; });
        cx /= neighbors.length;
        cy /= neighbors.length;
        cx = Math.max(0.02, Math.min(0.98, cx));
        cy = Math.max(0.02, Math.min(0.98, cy));
        
        if (!isTooClose(graph, node, cx, cy)) {
          var delta = evaluateMoveDelta(graph, node, cx, cy, count);
          var improvement = -delta;
          
          if (improvement > bestImprovement) {
            bestImprovement = improvement;
            bestMove = {
              node: node,
              nodeIndex: idx,
              fromX: origX,
              fromY: origY,
              toX: cx,
              toY: cy,
              improvement: improvement,
              strategy: 'bottleneck-centroid-fast'
            };
          }
        }
      }
      
      // Sample random positions
      for (var s = 0; s < samplesPerNode; s++) {
        var newX = 0.15 + Math.random() * 0.7;
        var newY = 0.15 + Math.random() * 0.7;
        
        if (isTooClose(graph, node, newX, newY)) continue;
        
        var delta = evaluateMoveDelta(graph, node, newX, newY, count);
        var improvement = -delta;
        
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestMove = {
            node: node,
            nodeIndex: idx,
            fromX: origX,
            fromY: origY,
            toX: newX,
            toY: newY,
            improvement: improvement,
            strategy: 'bottleneck-sample-fast'
          };
        }
      }
    }
    
    return bestMove;
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
    
    // Early game (many crossings): use fast incremental evaluation
    if (count > 50) {
      best = findBottleneckMoveFast(graph, 25);
      if (!best || best.improvement <= 0) {
        best = findBestMoveFast(graph, 30);
      }
    }
    // Mid game: balance strategies
    else if (count > 15) {
      best = findBottleneckMoveFast(graph, 20);
      if (!best || best.improvement <= 0) {
        best = findBestMoveFast(graph, 25);
      }
      if (!best || best.improvement <= 0) {
        best = findGrowClumpMove(graph); // clump growing for mid-game
      }
    }
    // Late game: grid search becomes viable, can afford O(n²) calls
    else {
      best = findGridMove(graph);
      if (!best || best.improvement <= 0) {
        best = findGrowClumpMove(graph);
      }
      if (!best || best.improvement <= 0) {
        best = findBottleneckMoveFast(graph, 15);
      }
      if (!best || best.improvement <= 0) {
        best = findBestMoveFast(graph, 30);
      }
    }
    
    if (best && best.improvement > 0) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      var newCount = intersections(graph.links);
      state.stuckCount = 0;
      return { done: false, improved: true, move: best, count: newCount };
    }
    
    // Before escaping, try anchored centroid move
    // This uses weighted centroid that prioritizes fixed/yellow neighbors
    best = findAnchoredCentroidMove(graph);
    if (best && best.improvement >= 0) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      var newCount = intersections(graph.links);
      // Don't reset stuck count for zero-improvement moves
      if (best.improvement > 0) state.stuckCount = 0;
      return { done: false, improved: best.improvement > 0, move: best, count: newCount };
    }
    
    // Stuck - try escape
    state.stuckCount = (state.stuckCount || 0) + 1;
    
    if (state.stuckCount > 50) {
      return { done: false, stuck: true, count: count };
    }
    
    // If pauseBeforeEscape is set, signal that we would escape instead of doing it
    if (state.pauseBeforeEscape) {
      return { done: false, wouldEscape: true, count: count, stuckCount: state.stuckCount };
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
  
  // ============ INTERACTIVE STRATEGIES ============
  // Moved from planarity.js - simpler strategies for interactive mode
  
  // Helper: calculate centroid of a set of nodes
  function centroid(nodes) {
    if (nodes.length === 0) return null;
    var cx = 0, cy = 0;
    for (var i = 0; i < nodes.length; i++) {
      cx += nodes[i][0];
      cy += nodes[i][1];
    }
    return [cx / nodes.length, cy / nodes.length];
  }
  
  // Strategy: Move toward centroid of neighbors
  function findCentroidMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var bestMove = null;
    var bestScore = -Infinity;
    
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (!node.intersection) continue;
      
      var neighbors = getNeighbors(graph, node);
      if (neighbors.length === 0) continue;
      
      var target = centroid(neighbors);
      var originalX = node[0];
      var originalY = node[1];
      
      var dx = target[0] - node[0];
      var dy = target[1] - node[1];
      var dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < 0.01) continue;
      
      var moveAmount = Math.min(0.1, dist * 0.5);
      var newX = node[0] + (dx / dist) * moveAmount;
      var newY = node[1] + (dy / dist) * moveAmount;
      newX = Math.max(0.02, Math.min(0.98, newX));
      newY = Math.max(0.02, Math.min(0.98, newY));
      
      // Use fast incremental evaluation
      var delta = evaluateMoveDelta(graph, node, newX, newY, count);
      var improvement = -delta;
      var score = improvement * 10 + (1 - dist);
      
      if (improvement > 0 || (improvement === 0 && dist > 0.05)) {
        if (score > bestScore) {
          bestScore = score;
          bestMove = {
            node: node,
            nodeIndex: i,
            fromX: originalX,
            fromY: originalY,
            toX: newX,
            toY: newY,
            improvement: improvement,
            strategy: 'centroid'
          };
        }
      }
    }
    
    return bestMove;
  }
  
  // Strategy: Move toward WEIGHTED centroid (anchored neighbors pull harder)
  function findAnchoredCentroidMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var bestMove = null;
    var bestScore = -Infinity;
    
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (!node.intersection) continue;
      
      var neighbors = getNeighbors(graph, node);
      if (neighbors.length === 0) continue;
      
      // Use weighted centroid instead of simple centroid
      var target = weightedCentroid(graph, node);
      if (!target) continue;
      
      var originalX = node[0];
      var originalY = node[1];
      
      var dx = target[0] - node[0];
      var dy = target[1] - node[1];
      var dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < 0.01) continue;
      
      // Move more aggressively toward weighted centroid
      var moveAmount = Math.min(0.15, dist * 0.7);
      var newX = node[0] + (dx / dist) * moveAmount;
      var newY = node[1] + (dy / dist) * moveAmount;
      newX = Math.max(0.02, Math.min(0.98, newX));
      newY = Math.max(0.02, Math.min(0.98, newY));
      
      // Evaluate the move
      var delta = evaluateMoveDelta(graph, node, newX, newY, count);
      var improvement = -delta;
      
      // Score: improvement matters most, but also consider the anchor score of this node
      // Low-anchor nodes are easier to move, so slight preference for moving them
      var nodeAnchor = anchorScore(graph, node);
      var score = improvement * 10 + (1 - nodeAnchor) * 2 + (1 - dist);
      
      // Accept moves that improve OR that move low-anchor nodes toward their weighted centroid
      if (improvement > 0 || (improvement >= 0 && nodeAnchor < 0.3 && dist > 0.05)) {
        if (score > bestScore) {
          bestScore = score;
          bestMove = {
            node: node,
            nodeIndex: i,
            fromX: originalX,
            fromY: originalY,
            toX: newX,
            toY: newY,
            improvement: improvement,
            strategy: 'anchored-centroid'
          };
        }
      }
    }
    
    return bestMove;
  }
  
  // Strategy: Local refinement - try small movements in 8 directions
  function findLocalMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var bestMove = null;
    var bestImprovement = 0;
    
    var directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];
    var stepSize = 0.03;
    
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (!node.intersection) continue;
      
      var originalX = node[0];
      var originalY = node[1];
      
      for (var d = 0; d < directions.length; d++) {
        var dir = directions[d];
        var newX = originalX + dir[0] * stepSize;
        var newY = originalY + dir[1] * stepSize;
        newX = Math.max(0.02, Math.min(0.98, newX));
        newY = Math.max(0.02, Math.min(0.98, newY));
        
        var delta = evaluateMoveDelta(graph, node, newX, newY, count);
        var improvement = -delta;
        
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestMove = {
            node: node,
            nodeIndex: i,
            fromX: originalX,
            fromY: originalY,
            toX: newX,
            toY: newY,
            improvement: improvement,
            strategy: 'local'
          };
        }
      }
    }
    
    return bestMove;
  }
  
  // Strategy: Move away from crossing midpoints
  function findUncrossMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var bestMove = null;
    var bestImprovement = 0;
    
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (!node.intersection) continue;
      
      var originalX = node[0];
      var originalY = node[1];
      
      // Find crossing midpoints to avoid
      var avoidX = 0, avoidY = 0, avoidCount = 0;
      
      for (var li = 0; li < graph.links.length; li++) {
        var link = graph.links[li];
        if ((link[0] === node || link[1] === node) && link.intersection) {
          for (var oj = 0; oj < graph.links.length; oj++) {
            var other = graph.links[oj];
            if (other !== link && intersect(link, other)) {
              avoidX += (other[0][0] + other[1][0]) / 2;
              avoidY += (other[0][1] + other[1][1]) / 2;
              avoidCount++;
            }
          }
        }
      }
      
      if (avoidCount === 0) continue;
      
      avoidX /= avoidCount;
      avoidY /= avoidCount;
      
      var dx = node[0] - avoidX;
      var dy = node[1] - avoidY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < 0.001) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        dist = Math.sqrt(dx * dx + dy * dy);
      }
      
      var moveAmount = 0.08;
      var newX = node[0] + (dx / dist) * moveAmount;
      var newY = node[1] + (dy / dist) * moveAmount;
      newX = Math.max(0.02, Math.min(0.98, newX));
      newY = Math.max(0.02, Math.min(0.98, newY));
      
      var delta = evaluateMoveDelta(graph, node, newX, newY, count);
      var improvement = -delta;
      
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        bestMove = {
          node: node,
          nodeIndex: i,
          fromX: originalX,
          fromY: originalY,
          toX: newX,
          toY: newY,
          improvement: improvement,
          strategy: 'uncross'
        };
      }
    }
    
    return bestMove;
  }
  
  // Strategy: Wiggle - random perturbation to escape local minima
  function findWiggleMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var candidates = graph.nodes.filter(function(n) { return n.intersection; });
    if (candidates.length === 0) return null;
    
    var node = candidates[Math.floor(Math.random() * candidates.length)];
    var i = graph.nodes.indexOf(node);
    
    var originalX = node[0];
    var originalY = node[1];
    
    var bestMove = null;
    var bestImprovement = -Infinity;
    
    for (var t = 0; t < 20; t++) {
      var angle = Math.random() * Math.PI * 2;
      var dist = 0.05 + Math.random() * 0.15;
      var newX = originalX + Math.cos(angle) * dist;
      var newY = originalY + Math.sin(angle) * dist;
      newX = Math.max(0.02, Math.min(0.98, newX));
      newY = Math.max(0.02, Math.min(0.98, newY));
      
      var delta = evaluateMoveDelta(graph, node, newX, newY, count);
      var improvement = -delta;
      
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        bestMove = {
          node: node,
          nodeIndex: i,
          fromX: originalX,
          fromY: originalY,
          toX: newX,
          toY: newY,
          improvement: improvement,
          strategy: 'wiggle'
        };
      }
    }
    
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
  exports.findBestMoveFast = findBestMoveFast;
  exports.findBottleneckMove = findBottleneckMove;
  exports.findBottleneckMoveFast = findBottleneckMoveFast;
  exports.getCrossingCounts = getCrossingCounts;
  exports.findGridMove = findGridMove;
  exports.findEscapeMove = findEscapeMove;
  exports.findGrowClumpMove = findGrowClumpMove;
  exports.findMoveClumpMove = findMoveClumpMove;
  exports.findClumps = findClumps;
  exports.solverStep = solverStep;
  exports.solvePuzzle = solvePuzzle;
  exports.evaluateMoveDelta = evaluateMoveDelta;
  exports.getNodeEdges = getNodeEdges;
  exports.findCentroidMove = findCentroidMove;
  exports.findAnchoredCentroidMove = findAnchoredCentroidMove;
  exports.findLocalMove = findLocalMove;
  exports.findUncrossMove = findUncrossMove;
  exports.findWiggleMove = findWiggleMove;
  exports.centroid = centroid;
  exports.weightedCentroid = weightedCentroid;
  exports.anchorScore = anchorScore;
  
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Solver = {}));
