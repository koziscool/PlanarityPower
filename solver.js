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
  
  // Finisher strategy - when very close to solved, exhaustively find the exact solution
  // For each crossing, identify exactly which vertex move would resolve it
  function findFinisherMove(graph) {
    var count = intersections(graph.links);
    if (count === 0 || count > 15) return null;  // expanded from 5 to match late game
    
    // Find all crossing pairs and edges involved
    var crossingPairs = [];
    var edgesInCrossings = [];
    for (var i = 0; i < graph.links.length; i++) {
      for (var j = i + 1; j < graph.links.length; j++) {
        if (intersect(graph.links[i], graph.links[j])) {
          crossingPairs.push([graph.links[i], graph.links[j]]);
          if (edgesInCrossings.indexOf(graph.links[i]) === -1) edgesInCrossings.push(graph.links[i]);
          if (edgesInCrossings.indexOf(graph.links[j]) === -1) edgesInCrossings.push(graph.links[j]);
        }
      }
    }
    
    var bestMove = null;
    var bestNewCount = count;
    
    // For each edge in crossings, try moving vertices from one side to the other
    // Prioritize moving the SMALLER group (fewer moves needed)
    for (var ei = 0; ei < edgesInCrossings.length; ei++) {
      var edge = edgesInCrossings[ei];
      
      // Count vertices on each side of this edge (excluding edge endpoints)
      var positiveSide = [];
      var negativeSide = [];
      for (var ni = 0; ni < graph.nodes.length; ni++) {
        var n = graph.nodes[ni];
        if (n === edge[0] || n === edge[1]) continue;
        var side = sideOfEdge(edge, n);
        if (side > 0.001) positiveSide.push(n);
        else if (side < -0.001) negativeSide.push(n);
      }
      
      // Find vertices that are part of edges crossing this one
      var verticesToMove = [];
      for (var cp = 0; cp < crossingPairs.length; cp++) {
        var pair = crossingPairs[cp];
        var crossingEdge = null;
        if (pair[0] === edge) crossingEdge = pair[1];
        else if (pair[1] === edge) crossingEdge = pair[0];
        if (!crossingEdge) continue;
        
        // The vertices of the crossing edge that aren't part of our target edge
        if (crossingEdge[0] !== edge[0] && crossingEdge[0] !== edge[1]) {
          if (verticesToMove.indexOf(crossingEdge[0]) === -1) verticesToMove.push(crossingEdge[0]);
        }
        if (crossingEdge[1] !== edge[0] && crossingEdge[1] !== edge[1]) {
          if (verticesToMove.indexOf(crossingEdge[1]) === -1) verticesToMove.push(crossingEdge[1]);
        }
      }
      
      // Determine which side each vertex-to-move is on, and prefer moving vertices 
      // that are on the SMALLER side (more efficient)
      verticesToMove.sort(function(a, b) {
        var aSide = sideOfEdge(edge, a) > 0 ? positiveSide.length : negativeSide.length;
        var bSide = sideOfEdge(edge, b) > 0 ? positiveSide.length : negativeSide.length;
        return aSide - bSide;  // smaller side first
      });
      
      // Try moving each vertex to the other side of this edge
      for (var vi = 0; vi < verticesToMove.length; vi++) {
        var node = verticesToMove[vi];
        var nodeIdx = graph.nodes.indexOf(node);
        var origX = node[0], origY = node[1];
        
        var side = sideOfEdge(edge, node);
        var targetSign = side > 0 ? -1 : 1;
        
        var edgeDx = edge[1][0] - edge[0][0];
        var edgeDy = edge[1][1] - edge[0][1];
        var edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
        var perpX = -edgeDy / edgeLen * targetSign;
        var perpY = edgeDx / edgeLen * targetSign;
        
        // Try several distances - be more aggressive
        for (var dist = 0.05; dist <= 0.4; dist += 0.03) {
          var newX = origX + perpX * dist;
          var newY = origY + perpY * dist;
          newX = Math.max(0.02, Math.min(0.98, newX));
          newY = Math.max(0.02, Math.min(0.98, newY));
          
          if (isTooClose(graph, node, newX, newY)) continue;
          
          node[0] = newX;
          node[1] = newY;
          
          var newCount = intersections(graph.links);
          
          if (newCount < bestNewCount) {
            bestNewCount = newCount;
            bestMove = {
              node: node,
              nodeIndex: nodeIdx,
              fromX: origX,
              fromY: origY,
              toX: newX,
              toY: newY,
              improvement: count - newCount,
              strategy: 'finisher'
            };
          }
          
          node[0] = origX;
          node[1] = origY;
        }
      }
    }
    
    if (bestMove) {
      intersections(graph.links);
      return bestMove;
    }
    
    // FALLBACK: For each crossing, collect all 4 vertices involved
    var candidateVertices = new Set();
    for (var cp = 0; cp < crossingPairs.length; cp++) {
      var pair = crossingPairs[cp];
      candidateVertices.add(pair[0][0]);
      candidateVertices.add(pair[0][1]);
      candidateVertices.add(pair[1][0]);
      candidateVertices.add(pair[1][1]);
    }
    
    var candidates = [];
    candidateVertices.forEach(function(node) {
      candidates.push(node);
    });
    
    // For each candidate vertex, try moving it to resolve crossings
    for (var ci = 0; ci < candidates.length; ci++) {
      var node = candidates[ci];
      var nodeIdx = graph.nodes.indexOf(node);
      var origX = node[0], origY = node[1];
      
      // Find edges this vertex is part of that have crossings
      var conflictEdges = [];
      for (var li = 0; li < graph.links.length; li++) {
        var link = graph.links[li];
        if ((link[0] === node || link[1] === node) && link.intersection) {
          conflictEdges.push(link);
        }
      }
      
      if (conflictEdges.length === 0) continue;
      
      // For each conflicting edge, find what it crosses and try to get to the other side
      for (var ce = 0; ce < conflictEdges.length; ce++) {
        var myEdge = conflictEdges[ce];
        var otherEnd = myEdge[0] === node ? myEdge[1] : myEdge[0];
        
        // Find edges that cross this one
        for (var oj = 0; oj < graph.links.length; oj++) {
          var crossingEdge = graph.links[oj];
          if (crossingEdge === myEdge) continue;
          if (!intersect(myEdge, crossingEdge)) continue;
          
          // Try moving this vertex to the other side of crossingEdge
          var side = sideOfEdge(crossingEdge, node);
          var targetSign = side > 0 ? -1 : 1;
          
          var edgeDx = crossingEdge[1][0] - crossingEdge[0][0];
          var edgeDy = crossingEdge[1][1] - crossingEdge[0][1];
          var edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
          var perpX = -edgeDy / edgeLen * targetSign;
          var perpY = edgeDx / edgeLen * targetSign;
          
          // Try several distances
          for (var dist = 0.08; dist <= 0.25; dist += 0.04) {
            var newX = node[0] + perpX * dist;
            var newY = node[1] + perpY * dist;
            newX = Math.max(0.02, Math.min(0.98, newX));
            newY = Math.max(0.02, Math.min(0.98, newY));
            
            if (isTooClose(graph, node, newX, newY)) continue;
            
            node[0] = newX;
            node[1] = newY;
            
            var newCount = intersections(graph.links);
            
            if (newCount < bestNewCount) {
              bestNewCount = newCount;
              bestMove = {
                node: node,
                nodeIndex: nodeIdx,
                fromX: origX,
                fromY: origY,
                toX: newX,
                toY: newY,
                improvement: count - newCount,
                strategy: 'finisher'
              };
            }
            
            node[0] = origX;
            node[1] = origY;
          }
        }
      }
      
      // Also try weighted centroid as finisher target
      var wc = weightedCentroid(graph, node);
      if (wc && !isTooClose(graph, node, wc[0], wc[1])) {
        node[0] = wc[0];
        node[1] = wc[1];
        var newCount = intersections(graph.links);
        if (newCount < bestNewCount) {
          bestNewCount = newCount;
          bestMove = {
            node: node,
            nodeIndex: nodeIdx,
            fromX: origX,
            fromY: origY,
            toX: wc[0],
            toY: wc[1],
            improvement: count - newCount,
            strategy: 'finisher'
          };
        }
        node[0] = origX;
        node[1] = origY;
      }
    }
    
    intersections(graph.links);
    return bestMove;
  }
  
  // Grid search for mid/late game - exhaustive position search
  function findGridMove(graph) {
    var count = intersections(graph.links);
    if (count === 0 || count > 40) return null;  // raised threshold for larger graphs
    
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
  
  // Compute total edge length for a vertex (long edges = likely problem)
  function totalEdgeLength(graph, node) {
    var neighbors = getNeighbors(graph, node);
    var total = 0;
    for (var i = 0; i < neighbors.length; i++) {
      var dx = neighbors[i][0] - node[0];
      var dy = neighbors[i][1] - node[1];
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }
  
  // Unblock strategy: when stuck on a vertex, try moving its neighbors/blockers instead
  // Sometimes the solution is to move OTHER vertices to create space
  function findUnblockMove(graph, state) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    state = state || {};
    state.recentAttempts = state.recentAttempts || {};
    
    // Find vertices that have been attempted many times (stuck vertices)
    var stuckVertices = [];
    for (var idx in state.recentAttempts) {
      if (state.recentAttempts[idx] >= 2) {  // lowered from 3 - trigger faster
        stuckVertices.push(parseInt(idx));
      }
    }
    
    if (stuckVertices.length === 0) return null;
    
    // For each stuck vertex, try moving its neighbors or connected vertices
    for (var si = 0; si < stuckVertices.length; si++) {
      var stuckIdx = stuckVertices[si];
      var stuckNode = graph.nodes[stuckIdx];
      if (!stuckNode) continue;
      
      var neighbors = getNeighbors(graph, stuckNode);
      
      // Find low-anchor neighbors that might be blocking
      var moveableNeighbors = [];
      for (var ni = 0; ni < neighbors.length; ni++) {
        var neighbor = neighbors[ni];
        var neighborIdx = graph.nodes.indexOf(neighbor);
        var anchor = anchorScore(graph, neighbor);
        if (anchor < 0.5) {
          moveableNeighbors.push({ node: neighbor, idx: neighborIdx, anchor: anchor });
        }
      }
      
      // Sort by lowest anchor (easiest to move)
      moveableNeighbors.sort(function(a, b) { return a.anchor - b.anchor; });
      
      // Try moving pairs of connected low-anchor neighbors together
      for (var i = 0; i < moveableNeighbors.length; i++) {
        for (var j = i + 1; j < moveableNeighbors.length; j++) {
          var n1 = moveableNeighbors[i];
          var n2 = moveableNeighbors[j];
          
          // Check if these two are connected to each other
          var connected = getNeighbors(graph, n1.node).indexOf(n2.node) >= 0;
          
          var orig1 = [n1.node[0], n1.node[1]];
          var orig2 = [n2.node[0], n2.node[1]];
          
          // Try moving both toward a common target area
          // Use the centroid of their combined neighbors as target
          var allNeighbors = getNeighbors(graph, n1.node).concat(getNeighbors(graph, n2.node));
          var uniqueNeighbors = [];
          for (var k = 0; k < allNeighbors.length; k++) {
            if (uniqueNeighbors.indexOf(allNeighbors[k]) === -1 && 
                allNeighbors[k] !== n1.node && allNeighbors[k] !== n2.node) {
              uniqueNeighbors.push(allNeighbors[k]);
            }
          }
          
          if (uniqueNeighbors.length === 0) continue;
          
          var targetCentroid = centroid(uniqueNeighbors);
          
          // Move both vertices toward this target
          var dx1 = targetCentroid[0] - n1.node[0];
          var dy1 = targetCentroid[1] - n1.node[1];
          var dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
          
          var dx2 = targetCentroid[0] - n2.node[0];
          var dy2 = targetCentroid[1] - n2.node[1];
          var dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
          
          if (dist1 < 0.02 && dist2 < 0.02) continue;
          
          var moveAmt = 0.12;
          var new1X = n1.node[0] + (dx1 / Math.max(dist1, 0.01)) * Math.min(moveAmt, dist1 * 0.5);
          var new1Y = n1.node[1] + (dy1 / Math.max(dist1, 0.01)) * Math.min(moveAmt, dist1 * 0.5);
          var new2X = n2.node[0] + (dx2 / Math.max(dist2, 0.01)) * Math.min(moveAmt, dist2 * 0.5);
          var new2Y = n2.node[1] + (dy2 / Math.max(dist2, 0.01)) * Math.min(moveAmt, dist2 * 0.5);
          
          new1X = Math.max(0.02, Math.min(0.98, new1X));
          new1Y = Math.max(0.02, Math.min(0.98, new1Y));
          new2X = Math.max(0.02, Math.min(0.98, new2X));
          new2Y = Math.max(0.02, Math.min(0.98, new2Y));
          
          // Apply moves
          n1.node[0] = new1X;
          n1.node[1] = new1Y;
          n2.node[0] = new2X;
          n2.node[1] = new2Y;
          
          // Check for collisions
          var valid = !isTooClose(graph, n1.node, new1X, new1Y) || true; // already moved
          var tooCloseToOther = false;
          var d = Math.sqrt(Math.pow(new1X - new2X, 2) + Math.pow(new1Y - new2Y, 2));
          if (d < MIN_NODE_DIST) tooCloseToOther = true;
          
          for (var k = 0; k < graph.nodes.length && !tooCloseToOther; k++) {
            var other = graph.nodes[k];
            if (other === n1.node || other === n2.node) continue;
            var d1 = Math.sqrt(Math.pow(new1X - other[0], 2) + Math.pow(new1Y - other[1], 2));
            var d2 = Math.sqrt(Math.pow(new2X - other[0], 2) + Math.pow(new2Y - other[1], 2));
            if (d1 < MIN_NODE_DIST || d2 < MIN_NODE_DIST) tooCloseToOther = true;
          }
          
          if (tooCloseToOther) {
            n1.node[0] = orig1[0];
            n1.node[1] = orig1[1];
            n2.node[0] = orig2[0];
            n2.node[1] = orig2[1];
            continue;
          }
          
          var newCount = intersections(graph.links);
          var improvement = count - newCount;
          
          if (improvement > 0) {
            // Return move for first vertex, restore second (will be moved next iteration)
            n2.node[0] = orig2[0];
            n2.node[1] = orig2[1];
            
            // Clear stuck tracking for this vertex
            delete state.recentAttempts[n1.idx];
            
            intersections(graph.links);
            return {
              node: n1.node,
              nodeIndex: n1.idx,
              fromX: orig1[0],
              fromY: orig1[1],
              toX: new1X,
              toY: new1Y,
              improvement: improvement,
              strategy: 'unblock-pair'
            };
          }
          
          // Restore both
          n1.node[0] = orig1[0];
          n1.node[1] = orig1[1];
          n2.node[0] = orig2[0];
          n2.node[1] = orig2[1];
        }
      }
      
      // Try moving single neighbors
      for (var ni = 0; ni < moveableNeighbors.length; ni++) {
        var item = moveableNeighbors[ni];
        var node = item.node;
        var nodeIdx = item.idx;
        var origX = node[0], origY = node[1];
        
        // Try moving toward weighted centroid
        var wc = weightedCentroid(graph, node);
        if (!wc) continue;
        
        var dx = wc[0] - node[0];
        var dy = wc[1] - node[1];
        var dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 0.02) continue;
        
        var moveAmt = Math.min(0.15, dist * 0.6);
        var newX = node[0] + (dx / dist) * moveAmt;
        var newY = node[1] + (dy / dist) * moveAmt;
        newX = Math.max(0.02, Math.min(0.98, newX));
        newY = Math.max(0.02, Math.min(0.98, newY));
        
        if (isTooClose(graph, node, newX, newY)) continue;
        
        node[0] = newX;
        node[1] = newY;
        
        var newCount = intersections(graph.links);
        var improvement = count - newCount;
        
        if (improvement > 0) {
          delete state.recentAttempts[nodeIdx];
          intersections(graph.links);
          return {
            node: node,
            nodeIndex: nodeIdx,
            fromX: origX,
            fromY: origY,
            toX: newX,
            toY: newY,
            improvement: improvement,
            strategy: 'unblock-neighbor'
          };
        }
        
        node[0] = origX;
        node[1] = origY;
      }
    }
    
    intersections(graph.links);
    return null;
  }
  
  // Compact strategy: move yellow vertices closer together to free up space
  // Uses LOCAL cluster centroids, not global - creates tight local groups
  var MIN_COMPACT_DIST = 0.02;  // ~8 pixels minimum spacing between vertices
  
  function findCompactMove(graph) {
    var count = intersections(graph.links);
    
    // Use existing clump detection to find local clusters
    var clumps = findClumps(graph, 0.15);  // slightly larger radius for initial grouping
    
    if (clumps.length === 0) return null;
    
    var bestMove = null;
    var bestSpreadReduction = 0;
    
    // For each clump, try to compact its members toward the clump centroid
    for (var c = 0; c < clumps.length; c++) {
      var clump = clumps[c];
      if (clump.length < 2) continue;
      
      // Calculate this clump's centroid
      var cx = 0, cy = 0;
      for (var i = 0; i < clump.length; i++) {
        cx += clump[i][0];
        cy += clump[i][1];
      }
      cx /= clump.length;
      cy /= clump.length;
      
      // Try to compact each member toward this local centroid
      for (var i = 0; i < clump.length; i++) {
        var node = clump[i];
        var nodeIdx = graph.nodes.indexOf(node);
        var origX = node[0], origY = node[1];
        
        // Distance from clump centroid
        var dx = cx - origX;
        var dy = cy - origY;
        var distFromCentroid = Math.sqrt(dx * dx + dy * dy);
        
        if (distFromCentroid < 0.03) continue;  // already close enough
        
        // Move toward centroid - more aggressive movement
        var moveAmount = Math.min(distFromCentroid * 0.6, 0.12);
        var newX = origX + (dx / distFromCentroid) * moveAmount;
        var newY = origY + (dy / distFromCentroid) * moveAmount;
        
        // Check minimum distance to all other vertices
        var tooClose = false;
        for (var j = 0; j < graph.nodes.length; j++) {
          if (j === nodeIdx) continue;
          var other = graph.nodes[j];
          var odx = newX - other[0];
          var ody = newY - other[1];
          var odist = Math.sqrt(odx * odx + ody * ody);
          if (odist < MIN_COMPACT_DIST) {
            tooClose = true;
            break;
          }
        }
        
        if (tooClose) continue;
        
        // Check that this doesn't create crossings
        node[0] = newX;
        node[1] = newY;
        var newCount = intersections(graph.links);
        
        if (newCount <= count) {  // doesn't make things worse
          var spreadReduction = distFromCentroid - Math.sqrt(
            Math.pow(newX - cx, 2) + Math.pow(newY - cy, 2)
          );
          
          if (spreadReduction > bestSpreadReduction) {
            bestSpreadReduction = spreadReduction;
            bestMove = {
              node: node,
              nodeIndex: nodeIdx,
              fromX: origX,
              fromY: origY,
              toX: newX,
              toY: newY,
              improvement: count - newCount,
              strategy: 'compact'
            };
          }
        }
        
        node[0] = origX;
        node[1] = origY;
      }
    }
    
    intersections(graph.links);
    return bestMove;
  }
  
  // Relocate strategy: move yellow vertices toward their IDEAL position
  // (based on neighbors) rather than toward existing geographic clusters.
  // This reorganizes the graph structure, not just tightens local clusters.
  function findRelocateMove(graph) {
    var count = intersections(graph.links);
    
    // Find yellow (conflict-free) vertices
    var yellowVertices = graph.nodes.filter(function(n) { return !n.intersection; });
    if (yellowVertices.length === 0) return null;
    
    // For each yellow vertex, compute displacement from ideal position
    var candidates = [];
    for (var i = 0; i < yellowVertices.length; i++) {
      var node = yellowVertices[i];
      var ideal = weightedCentroid(graph, node);
      if (!ideal) continue;
      
      var dx = ideal[0] - node[0];
      var dy = ideal[1] - node[1];
      var displacement = Math.sqrt(dx * dx + dy * dy);
      
      // Only consider if significantly displaced (> 0.08 = ~30 pixels)
      if (displacement > 0.08) {
        candidates.push({
          node: node,
          ideal: ideal,
          displacement: displacement
        });
      }
    }
    
    if (candidates.length === 0) return null;
    
    // Sort by displacement - most displaced first
    candidates.sort(function(a, b) { return b.displacement - a.displacement; });
    
    // Try to move the most displaced vertices toward their ideal positions
    for (var c = 0; c < Math.min(candidates.length, 5); c++) {
      var cand = candidates[c];
      var node = cand.node;
      var nodeIdx = graph.nodes.indexOf(node);
      var origX = node[0], origY = node[1];
      var ideal = cand.ideal;
      
      // Try moving toward ideal in steps
      var distances = [0.8, 0.6, 0.4, 0.2];
      for (var d = 0; d < distances.length; d++) {
        var frac = distances[d];
        var newX = origX + (ideal[0] - origX) * frac;
        var newY = origY + (ideal[1] - origY) * frac;
        
        // Clamp to valid range
        newX = Math.max(0.02, Math.min(0.98, newX));
        newY = Math.max(0.02, Math.min(0.98, newY));
        
        // Check minimum distance
        var tooClose = false;
        for (var j = 0; j < graph.nodes.length; j++) {
          if (j === nodeIdx) continue;
          var other = graph.nodes[j];
          var odx = newX - other[0];
          var ody = newY - other[1];
          if (Math.sqrt(odx * odx + ody * ody) < MIN_COMPACT_DIST) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        
        node[0] = newX;
        node[1] = newY;
        var newCount = intersections(graph.links);
        
        // Allow small increase in crossings (up to +3) for reorganization
        if (newCount <= count + 3) {
          var move = {
            node: node,
            nodeIndex: nodeIdx,
            fromX: origX,
            fromY: origY,
            toX: newX,
            toY: newY,
            improvement: count - newCount,
            displacement: cand.displacement,
            strategy: 'relocate'
          };
          intersections(graph.links);
          return move;
        }
        
        node[0] = origX;
        node[1] = origY;
      }
    }
    
    intersections(graph.links);
    return null;
  }
  
  // Consolidate: grow the largest geometric cluster by pulling in nearby vertices
  // This intentionally ignores crossing count - we're building structure
  function findConsolidateMove(graph) {
    var MIN_DIST = 0.02;
    
    // Find geometric clusters of ALL vertices (not just yellow)
    var clusterRadius = 0.15;
    var visited = new Set();
    var clusters = [];
    
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (visited.has(i)) continue;
      
      var cluster = [];
      var queue = [i];
      visited.add(i);
      
      while (queue.length > 0) {
        var currIdx = queue.shift();
        var curr = graph.nodes[currIdx];
        cluster.push({ node: curr, index: currIdx });
        
        for (var j = 0; j < graph.nodes.length; j++) {
          if (visited.has(j)) continue;
          var other = graph.nodes[j];
          var dx = curr[0] - other[0];
          var dy = curr[1] - other[1];
          if (dx * dx + dy * dy < clusterRadius * clusterRadius) {
            visited.add(j);
            queue.push(j);
          }
        }
      }
      
      if (cluster.length > 0) clusters.push(cluster);
    }
    
    if (clusters.length === 0) return null;
    
    // Find the largest cluster
    clusters.sort(function(a, b) { return b.length - a.length; });
    var largest = clusters[0];
    
    if (largest.length >= graph.nodes.length * 0.8) {
      // Already mostly consolidated
      return null;
    }
    
    // Calculate cluster centroid
    var cx = 0, cy = 0;
    for (var i = 0; i < largest.length; i++) {
      cx += largest[i].node[0];
      cy += largest[i].node[1];
    }
    cx /= largest.length;
    cy /= largest.length;
    
    // Find cluster member indices for quick lookup
    var inCluster = new Set();
    for (var i = 0; i < largest.length; i++) {
      inCluster.add(largest[i].index);
    }
    
    // Find vertices NOT in the cluster, sorted by distance to centroid
    var candidates = [];
    for (var i = 0; i < graph.nodes.length; i++) {
      if (inCluster.has(i)) continue;
      var node = graph.nodes[i];
      var dx = node[0] - cx;
      var dy = node[1] - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      candidates.push({ node: node, index: i, dist: dist });
    }
    
    // Sort by distance - closest first (easier to pull in)
    candidates.sort(function(a, b) { return a.dist - b.dist; });
    
    // Try to pull the closest candidate toward the cluster
    for (var c = 0; c < Math.min(candidates.length, 10); c++) {
      var cand = candidates[c];
      var node = cand.node;
      var nodeIdx = cand.index;
      var origX = node[0], origY = node[1];
      
      // Move toward cluster centroid
      var dx = cx - origX;
      var dy = cy - origY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < 0.05) continue;  // already close enough
      
      // Move partway toward centroid
      var moveAmount = Math.min(dist * 0.5, 0.1);
      var newX = origX + (dx / dist) * moveAmount;
      var newY = origY + (dy / dist) * moveAmount;
      
      // Clamp to valid range
      newX = Math.max(0.02, Math.min(0.98, newX));
      newY = Math.max(0.02, Math.min(0.98, newY));
      
      // Check minimum distance to other nodes
      var tooClose = false;
      for (var j = 0; j < graph.nodes.length; j++) {
        if (j === nodeIdx) continue;
        var other = graph.nodes[j];
        var odx = newX - other[0];
        var ody = newY - other[1];
        if (Math.sqrt(odx * odx + ody * ody) < MIN_DIST) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      
      // Accept move regardless of crossing change
      return {
        node: node,
        nodeIndex: nodeIdx,
        fromX: origX,
        fromY: origY,
        toX: newX,
        toY: newY,
        improvement: 0,  // we don't care about crossings
        clusterSize: largest.length,
        strategy: 'consolidate'
      };
    }
    
    return null;
  }
  
  // Smart escape - target "sore thumb" vertices (long edges + weak anchor)
  function findEscapeMove(graph) {
    var count = intersections(graph.links);
    var candidates = graph.nodes.filter(function(n) { return n.intersection; });
    if (candidates.length === 0) return null;
    
    // Score candidates: prefer long edges + low anchor score (sore thumbs)
    var scored = candidates.map(function(node) {
      var edgeLen = totalEdgeLength(graph, node);
      var anchor = anchorScore(graph, node);
      // High edge length + low anchor = high sore thumb score
      return { node: node, score: edgeLen * (1.5 - anchor) };
    });
    scored.sort(function(a, b) { return b.score - a.score; });
    
    // Pick top sore thumb (with some randomness to avoid loops)
    var pickIdx = Math.floor(Math.random() * Math.min(3, scored.length));
    var node = scored[pickIdx].node;
    var i = graph.nodes.indexOf(node);
    var origX = node[0], origY = node[1];
    
    // Try boundary positions first (edges often help), then random
    var boundaryPositions = [
      [0.05, 0.5], [0.95, 0.5], [0.5, 0.05], [0.5, 0.95],  // edge centers
      [0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95],  // corners
      [0.25, 0.05], [0.75, 0.05], [0.25, 0.95], [0.75, 0.95],  // more edge points
      [0.05, 0.25], [0.05, 0.75], [0.95, 0.25], [0.95, 0.75]
    ];
    
    var bestMove = null;
    var bestImprovement = -Infinity;
    
    // Try boundary positions
    for (var b = 0; b < boundaryPositions.length; b++) {
      var pos = boundaryPositions[b];
      if (isTooClose(graph, node, pos[0], pos[1])) continue;
      
      node[0] = pos[0];
      node[1] = pos[1];
      var newCount = intersections(graph.links);
      var improvement = count - newCount;
      
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        bestMove = {
          node: node,
          nodeIndex: i,
          fromX: origX,
          fromY: origY,
          toX: pos[0],
          toY: pos[1],
          improvement: improvement,
          strategy: 'escape-boundary'
        };
      }
    }
    
    // Also try weighted centroid as escape target
    var wc = weightedCentroid(graph, node);
    if (wc && !isTooClose(graph, node, wc[0], wc[1])) {
      node[0] = wc[0];
      node[1] = wc[1];
      var newCount = intersections(graph.links);
      var improvement = count - newCount;
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        bestMove = {
          node: node,
          nodeIndex: i,
          fromX: origX,
          fromY: origY,
          toX: wc[0],
          toY: wc[1],
          improvement: improvement,
          strategy: 'escape-centroid'
        };
      }
    }
    
    node[0] = origX;
    node[1] = origY;
    intersections(graph.links);
    
    // Only accept escape moves that don't make things catastrophically worse
    // Allowing small degradation (-5) for escape, but not huge jumps
    if (bestMove && bestMove.improvement >= -5) return bestMove;
    
    // Fallback: try random positions, but still check they don't make things much worse
    for (var r = 0; r < 10; r++) {
      var newX = 0.02 + Math.random() * 0.96;
      var newY = 0.02 + Math.random() * 0.96;
      
      if (isTooClose(graph, node, newX, newY)) continue;
      
      node[0] = newX;
      node[1] = newY;
      var newCount = intersections(graph.links);
      var improvement = count - newCount;
      
      // Restore before deciding
      node[0] = origX;
      node[1] = origY;
      intersections(graph.links);  // restore intersection state too
      
      // Only accept if not catastrophic
      if (improvement >= -5) {
        return {
          node: node,
          nodeIndex: i,
          fromX: origX,
          fromY: origY,
          toX: newX,
          toY: newY,
          improvement: improvement,
          strategy: 'escape-random'
        };
      }
    }
    
    // If nothing acceptable found, return null (will trigger stuck)
    intersections(graph.links);
    return null;
  }
  
  // Determine which side of an edge a point is on
  // Returns positive, negative, or ~0
  function sideOfEdge(edge, point) {
    var ax = edge[0][0], ay = edge[0][1];
    var bx = edge[1][0], by = edge[1][1];
    var px = point[0], py = point[1];
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  }
  
  // Find edges with multiple conflicts where conflicting vertices are on the same side
  // Moving those vertices to the other side would resolve all conflicts at once
  function findEdgeSideMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    // For each edge, collect vertices whose edges cross it
    var edgeConflicts = [];
    
    for (var i = 0; i < graph.links.length; i++) {
      var edge = graph.links[i];
      if (!edge.intersection) continue;
      
      var conflictingVertices = [];
      
      for (var j = 0; j < graph.links.length; j++) {
        if (i === j) continue;
        var other = graph.links[j];
        if (intersect(edge, other)) {
          // The conflicting vertices are the endpoints of 'other' that aren't part of 'edge'
          if (other[0] !== edge[0] && other[0] !== edge[1]) {
            if (conflictingVertices.indexOf(other[0]) === -1) {
              conflictingVertices.push(other[0]);
            }
          }
          if (other[1] !== edge[0] && other[1] !== edge[1]) {
            if (conflictingVertices.indexOf(other[1]) === -1) {
              conflictingVertices.push(other[1]);
            }
          }
        }
      }
      
      if (conflictingVertices.length >= 1) {  // lowered from 2 - even 1 conflict can be edge-side solvable
        edgeConflicts.push({ edge: edge, vertices: conflictingVertices });
      }
    }
    
    // Sort by most conflicts (biggest payoff for fixing)
    edgeConflicts.sort(function(a, b) { return b.vertices.length - a.vertices.length; });
    
    // Try each problematic edge
    for (var ec = 0; ec < Math.min(5, edgeConflicts.length); ec++) {
      var item = edgeConflicts[ec];
      var edge = item.edge;
      var vertices = item.vertices;
      
      // Check if vertices are all on the same side
      var sides = vertices.map(function(v) { return sideOfEdge(edge, v); });
      var allPositive = sides.every(function(s) { return s > 0.001; });
      var allNegative = sides.every(function(s) { return s < -0.001; });
      
      if (!allPositive && !allNegative) continue;  // not all on same side
      
      // Calculate target side (flip the sign)
      var targetSign = allPositive ? -1 : 1;
      
      // Edge midpoint and perpendicular direction
      var edgeDx = edge[1][0] - edge[0][0];
      var edgeDy = edge[1][1] - edge[0][1];
      var edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
      // Perpendicular direction (normalized)
      var perpX = -edgeDy / edgeLen * targetSign;
      var perpY = edgeDx / edgeLen * targetSign;
      
      // Filter to moveable vertices (low anchor score)
      var moveableVertices = vertices.filter(function(v) {
        return anchorScore(graph, v) < 0.6;
      });
      
      if (moveableVertices.length === 0) continue;
      
      // FIRST: Try moving ALL moveable vertices together (group move)
      if (moveableVertices.length >= 2) {
        var origPositions = moveableVertices.map(function(v) { return [v[0], v[1]]; });
        var valid = true;
        
        // Move all vertices to other side
        for (var vi = 0; vi < moveableVertices.length; vi++) {
          var node = moveableVertices[vi];
          var distFromEdge = Math.abs(sideOfEdge(edge, node)) / edgeLen;
          var moveDistance = distFromEdge * 2 + 0.05;
          
          var newX = node[0] + perpX * moveDistance;
          var newY = node[1] + perpY * moveDistance;
          newX = Math.max(0.02, Math.min(0.98, newX));
          newY = Math.max(0.02, Math.min(0.98, newY));
          
          node[0] = newX;
          node[1] = newY;
          
          // Check side
          var newSide = sideOfEdge(edge, node);
          if ((targetSign > 0 && newSide <= 0) || (targetSign < 0 && newSide >= 0)) {
            valid = false;
          }
        }
        
        // Check for too-close violations after all moves
        if (valid) {
          for (var vi = 0; vi < moveableVertices.length && valid; vi++) {
            for (var vj = 0; vj < graph.nodes.length && valid; vj++) {
              var other = graph.nodes[vj];
              if (moveableVertices.indexOf(other) >= 0) continue;
              var dx = moveableVertices[vi][0] - other[0];
              var dy = moveableVertices[vi][1] - other[1];
              if (dx * dx + dy * dy < MIN_NODE_DIST * MIN_NODE_DIST) {
                valid = false;
              }
            }
          }
        }
        
        if (valid) {
          var newCount = intersections(graph.links);
          var improvement = count - newCount;
          
          if (improvement > 0) {
            // Return move for first vertex (others moved as side effect, will be handled next steps)
            var firstNode = moveableVertices[0];
            var firstIdx = graph.nodes.indexOf(firstNode);
            var move = {
              node: firstNode,
              nodeIndex: firstIdx,
              fromX: origPositions[0][0],
              fromY: origPositions[0][1],
              toX: firstNode[0],
              toY: firstNode[1],
              improvement: improvement,
              strategy: 'edge-side-group'
            };
            // Restore other vertices (we only officially "move" one at a time)
            for (var vi = 1; vi < moveableVertices.length; vi++) {
              moveableVertices[vi][0] = origPositions[vi][0];
              moveableVertices[vi][1] = origPositions[vi][1];
            }
            intersections(graph.links);
            return move;
          }
        }
        
        // Restore all
        for (var vi = 0; vi < moveableVertices.length; vi++) {
          moveableVertices[vi][0] = origPositions[vi][0];
          moveableVertices[vi][1] = origPositions[vi][1];
        }
      }
      
      // SECOND: Try moving vertices individually (original approach)
      for (var vi = 0; vi < moveableVertices.length; vi++) {
        var node = moveableVertices[vi];
        var nodeIdx = graph.nodes.indexOf(node);
        var origX = node[0], origY = node[1];
        
        var distFromEdge = Math.abs(sideOfEdge(edge, node)) / edgeLen;
        var moveDistance = distFromEdge * 2 + 0.05;
        
        var newX = origX + perpX * moveDistance;
        var newY = origY + perpY * moveDistance;
        newX = Math.max(0.02, Math.min(0.98, newX));
        newY = Math.max(0.02, Math.min(0.98, newY));
        
        if (isTooClose(graph, node, newX, newY)) continue;
        
        node[0] = newX;
        node[1] = newY;
        var newSide = sideOfEdge(edge, node);
        
        if ((targetSign > 0 && newSide <= 0) || (targetSign < 0 && newSide >= 0)) {
          node[0] = origX;
          node[1] = origY;
          continue;
        }
        
        var newCount = intersections(graph.links);
        var improvement = count - newCount;
        
        if (improvement > 0) {
          var move = {
            node: node,
            nodeIndex: nodeIdx,
            fromX: origX,
            fromY: origY,
            toX: newX,
            toY: newY,
            improvement: improvement,
            strategy: 'edge-side'
          };
          node[0] = origX;
          node[1] = origY;
          intersections(graph.links);
          return move;
        }
        
        node[0] = origX;
        node[1] = origY;
      }
    }
    
    intersections(graph.links);
    return null;
  }
  
  // Find triangles with clean boundaries (no external crossings)
  // These form independent subproblems that are easy to solve
  function findCleanTriangles(graph) {
    var triangles = [];
    var n = graph.nodes.length;
    
    // Build adjacency for fast lookup
    var adj = {};
    for (var i = 0; i < n; i++) adj[i] = {};
    graph.links.forEach(function(link) {
      var a = graph.nodes.indexOf(link[0]);
      var b = graph.nodes.indexOf(link[1]);
      adj[a][b] = true;
      adj[b][a] = true;
    });
    
    // Find all triangles
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (!adj[i][j]) continue;
        for (var k = j + 1; k < n; k++) {
          if (adj[i][k] && adj[j][k]) {
            triangles.push([i, j, k]);
          }
        }
      }
    }
    
    return triangles;
  }
  
  // Check if a triangle has clean boundaries (its edges have no crossings)
  function isCleanTriangle(graph, tri) {
    var triNodes = [graph.nodes[tri[0]], graph.nodes[tri[1]], graph.nodes[tri[2]]];
    var triEdges = [];
    
    // Find the triangle's edges
    graph.links.forEach(function(link) {
      var inTri0 = triNodes.indexOf(link[0]) >= 0;
      var inTri1 = triNodes.indexOf(link[1]) >= 0;
      if (inTri0 && inTri1) triEdges.push(link);
    });
    
    // Check if any triangle edge has a crossing
    for (var i = 0; i < triEdges.length; i++) {
      if (triEdges[i].intersection) return false;
    }
    return true;
  }
  
  // Find vertices inside a triangle
  function findInteriorVertices(graph, tri) {
    var p1 = graph.nodes[tri[0]];
    var p2 = graph.nodes[tri[1]];
    var p3 = graph.nodes[tri[2]];
    
    // Point-in-triangle test using barycentric coordinates
    function inTriangle(p) {
      var d1 = (p[0] - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (p[1] - p2[1]);
      var d2 = (p[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p[1] - p3[1]);
      var d3 = (p[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p[1] - p1[1]);
      var hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      var hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      return !(hasNeg && hasPos);
    }
    
    var interior = [];
    for (var i = 0; i < graph.nodes.length; i++) {
      if (i === tri[0] || i === tri[1] || i === tri[2]) continue;
      if (inTriangle(graph.nodes[i])) {
        interior.push(i);
      }
    }
    return interior;
  }
  
  // Strategy: Find clean triangles and solve their interiors
  function findTriangleSolveMove(graph) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    
    var triangles = findCleanTriangles(graph);
    
    for (var t = 0; t < triangles.length; t++) {
      var tri = triangles[t];
      if (!isCleanTriangle(graph, tri)) continue;
      
      var interior = findInteriorVertices(graph, tri);
      if (interior.length === 0) continue;
      
      // Check if any interior vertex is in conflict
      var conflictingInterior = interior.filter(function(idx) {
        return graph.nodes[idx].intersection;
      });
      
      if (conflictingInterior.length === 0) continue;
      
      // Found a clean triangle with conflicting interior vertices
      // Try to solve by moving interior vertices toward triangle centroid
      var triCentroid = [
        (graph.nodes[tri[0]][0] + graph.nodes[tri[1]][0] + graph.nodes[tri[2]][0]) / 3,
        (graph.nodes[tri[0]][1] + graph.nodes[tri[1]][1] + graph.nodes[tri[2]][1]) / 3
      ];
      
      // Try moving each conflicting interior vertex
      for (var c = 0; c < conflictingInterior.length; c++) {
        var nodeIdx = conflictingInterior[c];
        var node = graph.nodes[nodeIdx];
        var origX = node[0], origY = node[1];
        
        // Try positions within the triangle
        var positions = [
          triCentroid,
          [(graph.nodes[tri[0]][0] + triCentroid[0]) / 2, (graph.nodes[tri[0]][1] + triCentroid[1]) / 2],
          [(graph.nodes[tri[1]][0] + triCentroid[0]) / 2, (graph.nodes[tri[1]][1] + triCentroid[1]) / 2],
          [(graph.nodes[tri[2]][0] + triCentroid[0]) / 2, (graph.nodes[tri[2]][1] + triCentroid[1]) / 2]
        ];
        
        for (var p = 0; p < positions.length; p++) {
          var pos = positions[p];
          if (isTooClose(graph, node, pos[0], pos[1])) continue;
          
          node[0] = pos[0];
          node[1] = pos[1];
          var newCount = intersections(graph.links);
          
          if (newCount < count) {
            var move = {
              node: node,
              nodeIndex: nodeIdx,
              fromX: origX,
              fromY: origY,
              toX: pos[0],
              toY: pos[1],
              improvement: count - newCount,
              strategy: 'triangle-solve'
            };
            node[0] = origX;
            node[1] = origY;
            intersections(graph.links);
            return move;
          }
        }
        
        node[0] = origX;
        node[1] = origY;
      }
    }
    
    intersections(graph.links);
    return null;
  }
  
  // Declutter strategy: push yellow vertices toward boundaries to create space
  // This enables "making space" moves that don't directly reduce crossings
  function findDeclutterMove(graph) {
    var count = intersections(graph.links);
    if (count === 0 || count > 30) return null;  // only useful in mid/late game
    
    // Find yellow (conflict-free) vertices near the center
    var centerX = 0.5, centerY = 0.5;
    var yellowNearCenter = [];
    
    for (var i = 0; i < graph.nodes.length; i++) {
      var node = graph.nodes[i];
      if (node.intersection) continue;  // skip blue vertices
      
      var distFromCenter = Math.sqrt(
        Math.pow(node[0] - centerX, 2) + Math.pow(node[1] - centerY, 2)
      );
      
      if (distFromCenter < 0.35) {  // within center region
        yellowNearCenter.push({ node: node, index: i, dist: distFromCenter });
      }
    }
    
    if (yellowNearCenter.length === 0) return null;
    
    // Sort by closest to center (most blocking)
    yellowNearCenter.sort(function(a, b) { return a.dist - b.dist; });
    
    // Try pushing the most central yellow vertex toward the nearest boundary
    for (var j = 0; j < Math.min(5, yellowNearCenter.length); j++) {
      var candidate = yellowNearCenter[j];
      var node = candidate.node;
      var origX = node[0], origY = node[1];
      
      // Determine which boundary is closest and push toward it
      var pushDirections = [];
      if (origX < 0.5) pushDirections.push([-1, 0]);  // push left
      else pushDirections.push([1, 0]);  // push right
      if (origY < 0.5) pushDirections.push([0, -1]);  // push up
      else pushDirections.push([0, 1]);  // push down
      
      for (var d = 0; d < pushDirections.length; d++) {
        var dir = pushDirections[d];
        var pushAmount = 0.15;
        var newX = Math.max(0.02, Math.min(0.98, origX + dir[0] * pushAmount));
        var newY = Math.max(0.02, Math.min(0.98, origY + dir[1] * pushAmount));
        
        if (isTooClose(graph, node, newX, newY)) continue;
        
        // Check that this doesn't create new crossings
        node[0] = newX;
        node[1] = newY;
        var newCount = intersections(graph.links);
        node[0] = origX;
        node[1] = origY;
        
        if (newCount <= count) {  // doesn't make things worse
          intersections(graph.links);  // restore
          return {
            node: node,
            nodeIndex: candidate.index,
            fromX: origX,
            fromY: origY,
            toX: newX,
            toY: newY,
            improvement: count - newCount,
            strategy: 'declutter'
          };
        }
      }
      
      node[0] = origX;
      node[1] = origY;
    }
    
    intersections(graph.links);
    return null;
  }
  
  // Check if a move would cause oscillation (returning to a recent position)
  function wouldOscillate(state, nodeIndex, toX, toY) {
    if (!state.recentMoves) return false;
    var dominated = 0;
    for (var i = 0; i < state.recentMoves.length; i++) {
      var m = state.recentMoves[i];
      if (m.nodeIndex === nodeIndex) {
        var dx = m.x - toX;
        var dy = m.y - toY;
        if (Math.sqrt(dx * dx + dy * dy) < 0.03) {
          dominated++;
          if (dominated >= 2) return true;  // moved here twice recently
        }
      }
    }
    return false;
  }
  
  // Record a move in recent history
  function recordMove(state, nodeIndex, x, y) {
    state.recentMoves = state.recentMoves || [];
    state.recentMoves.push({ nodeIndex: nodeIndex, x: x, y: y });
    // Keep last 20 moves
    if (state.recentMoves.length > 20) {
      state.recentMoves.shift();
    }
  }
  
  // Helper: try a move, checking oscillation. Returns move if OK, null if blocked/none.
  function tryMove(graph, state, moveFn, arg) {
    var move = arg !== undefined ? moveFn(graph, arg) : moveFn(graph);
    if (!move || move.improvement <= 0) return null;
    if (wouldOscillate(state, move.nodeIndex, move.toX, move.toY)) {
      state.oscillatingVertices = state.oscillatingVertices || {};
      state.oscillatingVertices[move.nodeIndex] = true;
      return null;  // blocked by oscillation, try next strategy
    }
    return move;
  }
  
  // Main solver step - stage-aware strategy selection
  function solverStep(graph, state) {
    state = state || {};
    state.totalMoves = (state.totalMoves || 0) + 1;
    var count = intersections(graph.links);
    
    if (count === 0) {
      return { done: true, count: 0 };
    }
    
    var best = null;
    
    // Try strategies in order - if oscillation blocks one, try the next
    // Early game (many crossings): use fast incremental evaluation
    if (count > 50) {
      best = tryMove(graph, state, findBottleneckMoveFast, 25);
      if (!best) best = tryMove(graph, state, findBestMoveFast, 35);
    }
    // Mid game
    else if (count > 15) {
      best = tryMove(graph, state, findBottleneckMoveFast, 25);
      if (!best) best = tryMove(graph, state, findBestMoveFast, 35);
      if (!best) best = tryMove(graph, state, findGridMove);
      if (!best) best = tryMove(graph, state, findGrowClumpMove);
    }
    // Late game
    else {
      best = tryMove(graph, state, findGridMove);
      if (!best) best = tryMove(graph, state, findFinisherMove);
      if (!best) best = tryMove(graph, state, findLocalMove);  // small nudges
      if (!best) best = tryMove(graph, state, findGrowClumpMove);
      if (!best) best = tryMove(graph, state, findBottleneckMoveFast, 20);
      if (!best) best = tryMove(graph, state, findBestMoveFast, 35);
    }
    
    // If we found a valid move, apply it
    if (best) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      recordMove(state, best.nodeIndex, best.toX, best.toY);
      var newCount = intersections(graph.links);
      state.stuckCount = 0;
      state.recentAttempts = {};
      return { done: false, improved: true, move: best, count: newCount };
    }
    
    // Before escaping, try anchored centroid move
    // This uses weighted centroid that prioritizes fixed/yellow neighbors
    best = findAnchoredCentroidMove(graph);
    if (best && best.improvement >= 0) {
      if (wouldOscillate(state, best.nodeIndex, best.toX, best.toY)) {
        best = null;
      } else {
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        // Don't reset stuck count for zero-improvement moves
        if (best.improvement > 0) state.stuckCount = 0;
        return { done: false, improved: best.improvement > 0, move: best, count: newCount };
      }
    }
    
    // NOTE: findDeclutterMove exists but is disabled for now - needs refinement
    // It pushes yellow vertices to boundaries to make space, but may hurt more than help
    
    // Stuck - increment counter and try escape moves
    state.stuckCount = (state.stuckCount || 0) + 1;
    state.recentAttempts = state.recentAttempts || {};
    
    // If pauseBeforeEscape is set, signal that we would escape instead of doing it
    if (state.pauseBeforeEscape) {
      return { done: false, wouldEscape: true, count: count, stuckCount: state.stuckCount };
    }
    
    // Try escape move
    var escape = findEscapeMove(graph);
    if (escape) {
      // Track this vertex as recently attempted
      state.recentAttempts[escape.nodeIndex] = (state.recentAttempts[escape.nodeIndex] || 0) + 1;
      
      escape.node[0] = escape.toX;
      escape.node[1] = escape.toY;
      var newCount = intersections(graph.links);
      return { done: false, improved: escape.improvement > 0, move: escape, count: newCount };
    }
    
    // No moves found at all - check if we should give up
    // When close to solving, be much more persistent
    var stuckLimit = count <= 5 ? 500 : count <= 15 ? 200 : 50;
    if (state.stuckCount > stuckLimit) {
      return { done: false, stuck: true, count: count };
    }
    
    // Keep trying - return no move but don't give up yet
    return { done: false, improved: false, move: null, count: count };
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
  exports.findDeclutterMove = findDeclutterMove;
  exports.findTriangleSolveMove = findTriangleSolveMove;
  exports.findEdgeSideMove = findEdgeSideMove;
  exports.findFinisherMove = findFinisherMove;
  exports.findUnblockMove = findUnblockMove;
  exports.findCompactMove = findCompactMove;
  exports.findRelocateMove = findRelocateMove;
  exports.findConsolidateMove = findConsolidateMove;
  exports.findCleanTriangles = findCleanTriangles;
  exports.findLocalMove = findLocalMove;
  exports.findUncrossMove = findUncrossMove;
  exports.findWiggleMove = findWiggleMove;
  exports.centroid = centroid;
  exports.weightedCentroid = weightedCentroid;
  exports.anchorScore = anchorScore;
  
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Solver = {}));
