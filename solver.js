// =============================================================================
// PLANARITY SOLVER
// =============================================================================
//
// Single source of truth for all graph algorithms and solving strategies.
// See ALGO_ARCHIVE.md for algorithmic decisions, disabled strategies, and history.
//
// USAGE:
//   Browser: <script src="solver.js"> → access via window.Solver
//   Node.js: const solver = require('./solver.js')
//
// ACTIVE SURFACES:
//   interactive.html: lead human-in-the-loop workflow
//   solver.html: batch visual evaluator using the same solverStep()
//   index.html: original game with discrete move tools
//   benchmark.js: headless evaluator using the same solverStep()
//
// =============================================================================

(function(exports) {
  
  // ===========================================================================
  // SECTION: CORE GRAPH FUNCTIONS
  // Basic graph operations: intersection detection, graph generation, neighbors
  // ===========================================================================
  
  // cross(a, b): 2D cross product of vectors a and b
  function cross(a, b) {
    return a[0] * b[1] - a[1] * b[0];
  }
  
  // intersect(a, b): Returns true if line segments a and b cross each other
  // Each segment is [point1, point2] where point is [x, y]
  // Uses parametric line intersection with epsilon for numerical stability
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
  
  // intersections(links): Count all edge crossings and mark involved elements
  // SIDE EFFECTS: Sets .intersection = true/false on each link and its endpoints
  // Returns: Total crossing count (the number we're trying to get to zero)
  // Complexity: O(E²) where E = number of edges
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
  
  // planarGraph(n): Generate a random planar graph with n vertices
  // Algorithm: Place random points, then add edges that don't cross existing ones
  // Returns: { nodes: [[x,y], ...], links: [[node1, node2], ...] }
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
  
  // scramble(graph): Randomize vertex positions until there are crossings
  // This creates the puzzle - a planar graph with scrambled positions
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
  
  // getNeighbors(graph, node): Return array of nodes connected to this node
  function getNeighbors(graph, node) {
    var neighbors = [];
    graph.links.forEach(function(link) {
      if (link[0] === node) neighbors.push(link[1]);
      else if (link[1] === node) neighbors.push(link[0]);
    });
    return neighbors;
  }
  
  // ===========================================================================
  // SECTION: ANCHOR SCORING
  // Determines how "fixed" a vertex is based on its neighborhood.
  // High anchor = hard to move (neighbors are spread out, conflict-free)
  // Low anchor = "sore thumb" candidate for escape moves
  // ===========================================================================
  
  // anchorScore(graph, node): Returns 0-1 score of how anchored a vertex is
  // Factors: (1) fraction of yellow neighbors, (2) angular spread, (3) neighbor degree
  // Used by: findEscapeMove (prefer low-anchor vertices)
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
  
  // weightedCentroid(graph, node): Compute ideal position for a vertex
  // Yellow/anchored neighbors pull harder than conflicting/loose ones
  // Returns [x, y] or null if no neighbors
  // Used by: findAnchoredCentroidMove, findEscapeMove, findRelocateMove
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
  
  // ===========================================================================
  // SECTION: INCREMENTAL CROSSING DETECTION
  // Fast evaluation of single-vertex moves without full O(E²) recount.
  // Key optimization: only recount crossings for edges touching the moved vertex.
  // Complexity: O(degree × E) instead of O(E²)
  // ===========================================================================
  
  // getNodeEdges(graph, node): Return edges connected to this node
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
  
  // ===========================================================================
  // SECTION: FAST STRATEGIES (used in main loop)
  // These use incremental evaluation for speed and are called by solverStep.
  // ===========================================================================
  
  // findBestMoveFast: Sample random positions for conflicting vertices
  // ACTIVE in solverStep: Early/Mid game
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
  
  // Which side of an oriented edge is a point on?
  function sideOfEdge(edge, point) {
    return cross(
      [edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]],
      [point[0] - edge[0][0], point[1] - edge[0][1]]
    );
  }

  // Count how many crossings involve each vertex.
  function getCrossingCounts(graph) {
    var counts = graph.nodes.map(function() { return 0; });
    var links = graph.links;

    for (var i = 0; i < links.length; i++) {
      for (var j = i + 1; j < links.length; j++) {
        if (!intersect(links[i], links[j])) continue;

        counts[graph.nodes.indexOf(links[i][0])]++;
        counts[graph.nodes.indexOf(links[i][1])]++;
        counts[graph.nodes.indexOf(links[j][0])]++;
        counts[graph.nodes.indexOf(links[j][1])]++;
      }
    }

    return counts;
  }

  function recordCrossingHistory(state, crossingCount) {
    state.crossingHistory = state.crossingHistory || [];
    var lastHistory = state.crossingHistory[state.crossingHistory.length - 1];
    if (lastHistory !== crossingCount) {
      state.crossingHistory.push(crossingCount);
      if (state.crossingHistory.length > 20) state.crossingHistory.shift();
    }
  }

  // Analyze the current drawing without changing vertex positions.
  // The optional state object supplies recent solver history for progress and
  // oscillation diagnosis.
  function analyzeGraphState(graph, state) {
    state = state || {};
    var crossingCount = intersections(graph.links);
    var crossingCounts = getCrossingCounts(graph);
    var cleanIndices = [];
    var cleanSet = {};
    var adjacency = graph.nodes.map(function() { return []; });

    for (var i = 0; i < graph.nodes.length; i++) {
      if (!graph.nodes[i].intersection) {
        cleanIndices.push(i);
        cleanSet[i] = true;
      }
    }

    for (var i = 0; i < graph.links.length; i++) {
      var a = graph.nodes.indexOf(graph.links[i][0]);
      var b = graph.nodes.indexOf(graph.links[i][1]);
      if (a === b) continue;
      adjacency[a].push(b);
      adjacency[b].push(a);
    }

    // Graph-connected regions induced by vertices with no crossing incident edge.
    var visited = {};
    var cleanRegions = [];
    for (var i = 0; i < cleanIndices.length; i++) {
      var start = cleanIndices[i];
      if (visited[start]) continue;
      var queue = [start];
      var region = [];
      visited[start] = true;

      while (queue.length > 0) {
        var current = queue.shift();
        region.push(current);
        for (var j = 0; j < adjacency[current].length; j++) {
          var neighbor = adjacency[current][j];
          if (cleanSet[neighbor] && !visited[neighbor]) {
            visited[neighbor] = true;
            queue.push(neighbor);
          }
        }
      }
      cleanRegions.push(region);
    }
    cleanRegions.sort(function(a, b) { return b.length - a.length; });

    var concentration = crossingCounts.map(function(count, index) {
      return {
        vertex: index,
        crossings: count,
        degree: adjacency[index].length,
        score: count / Math.max(1, adjacency[index].length)
      };
    }).filter(function(item) {
      return item.crossings > 0;
    }).sort(function(a, b) {
      return b.crossings - a.crossings || b.score - a.score;
    });

    var totalVertexCrossingIncidence = crossingCounts.reduce(function(sum, count) {
      return sum + count;
    }, 0);
    var topCrossingShare = concentration.length > 0 && totalVertexCrossingIncidence > 0
      ? concentration[0].crossings / totalVertexCrossingIncidence
      : 0;

    recordCrossingHistory(state, crossingCount);
    var recent = state.crossingHistory.slice(-6);
    var recentImprovement = recent.length > 1 ? recent[0] - recent[recent.length - 1] : 0;

    var repeatedMoves = {};
    (state.recentMoves || []).forEach(function(move) {
      repeatedMoves[move.nodeIndex] = (repeatedMoves[move.nodeIndex] || 0) + 1;
    });
    var oscillatingVertices = Object.keys(repeatedMoves).filter(function(index) {
      return repeatedMoves[index] >= 3;
    }).map(function(index) {
      return +index;
    });

    return {
      crossings: crossingCount,
      cleanVertices: cleanIndices.length,
      cleanRatio: graph.nodes.length > 0 ? cleanIndices.length / graph.nodes.length : 1,
      cleanRegions: cleanRegions,
      largestCleanRegion: cleanRegions.length > 0 ? cleanRegions[0].length : 0,
      crossingConcentration: concentration.slice(0, 5),
      topCrossingShare: topCrossingShare,
      recentCrossings: recent,
      recentImprovement: recentImprovement,
      stalled: crossingCount > 0 && recent.length >= 3 && recentImprovement <= 0,
      oscillatingVertices: oscillatingVertices,
      lastMinimizeAttempt: state.lastMinimizeAttempt || null,
      lastSideFlipAttempt: state.lastSideFlipAttempt || null,
      sideFlipMoves: state.sideFlipMoves || 0
    };
  }

  function cloneGraph(graph) {
    var nodes = graph.nodes.map(function(node) { return [node[0], node[1]]; });
    var links = graph.links.map(function(link) {
      return [nodes[graph.nodes.indexOf(link[0])], nodes[graph.nodes.indexOf(link[1])]];
    });
    return { nodes: nodes, links: links };
  }

  function pointInTriangle(point, a, b, c) {
    var s1 = sideOfEdge([a, b], point);
    var s2 = sideOfEdge([b, c], point);
    var s3 = sideOfEdge([c, a], point);
    var epsilon = 1e-8;
    var hasNegative = s1 < -epsilon || s2 < -epsilon || s3 < -epsilon;
    var hasPositive = s1 > epsilon || s2 > epsilon || s3 > epsilon;
    return !(hasNegative && hasPositive);
  }

  // Find crossing-free triangles whose removal separates the abstract graph.
  function findSeparatingTriangles(graph) {
    intersections(graph.links);
    var n = graph.nodes.length;
    var adjacency = graph.nodes.map(function() { return {}; });
    var edgeMap = {};

    for (var i = 0; i < graph.links.length; i++) {
      var a = graph.nodes.indexOf(graph.links[i][0]);
      var b = graph.nodes.indexOf(graph.links[i][1]);
      if (a === b) continue;
      adjacency[a][b] = true;
      adjacency[b][a] = true;
      edgeMap[Math.min(a, b) + ',' + Math.max(a, b)] = graph.links[i];
    }

    var triangles = [];
    for (var a = 0; a < n; a++) {
      var neighbors = Object.keys(adjacency[a]).map(Number).filter(function(b) {
        return b > a;
      });
      for (var ni = 0; ni < neighbors.length; ni++) {
        var b = neighbors[ni];
        for (var nj = ni + 1; nj < neighbors.length; nj++) {
          var c = neighbors[nj];
          if (!adjacency[b][c]) continue;

          var triangleEdges = [
            edgeMap[a + ',' + b],
            edgeMap[Math.min(b, c) + ',' + Math.max(b, c)],
            edgeMap[a + ',' + c]
          ];
          if (triangleEdges.some(function(edge) { return edge.intersection; })) continue;
          if (Math.abs(sideOfEdge([graph.nodes[a], graph.nodes[b]], graph.nodes[c])) < 1e-6) {
            continue;
          }

          var removed = {};
          removed[a] = removed[b] = removed[c] = true;
          var visited = {};
          var components = [];

          for (var start = 0; start < n; start++) {
            if (removed[start] || visited[start]) continue;
            var queue = [start];
            var component = [];
            visited[start] = true;
            while (queue.length > 0) {
              var current = queue.shift();
              component.push(current);
              Object.keys(adjacency[current]).forEach(function(key) {
                var next = +key;
                if (!removed[next] && !visited[next]) {
                  visited[next] = true;
                  queue.push(next);
                }
              });
            }
            components.push(component);
          }
          if (components.length < 2) continue;

          var triPoints = [graph.nodes[a], graph.nodes[b], graph.nodes[c]];
          var classified = components.map(function(component) {
            var inside = component.filter(function(index) {
              return pointInTriangle(graph.nodes[index], triPoints[0], triPoints[1], triPoints[2]);
            }).length;
            return {
              vertices: component,
              insideCount: inside,
              outsideCount: component.length - inside,
              side: inside === component.length ? 'inside' :
                inside === 0 ? 'outside' : 'straddling'
            };
          });

          triangles.push({
            vertices: [a, b, c],
            components: classified
          });
        }
      }
    }

    triangles.sort(function(x, y) {
      var xStraddling = x.components.filter(function(c) { return c.side === 'straddling'; }).length;
      var yStraddling = y.components.filter(function(c) { return c.side === 'straddling'; }).length;
      return yStraddling - xStraddling ||
        Math.min.apply(null, x.components.map(function(c) { return c.vertices.length; })) -
        Math.min.apply(null, y.components.map(function(c) { return c.vertices.length; }));
    });
    return triangles;
  }

  function transformComponent(graph, component, target, targetCenter, scale) {
    var center = [0, 0];
    component.forEach(function(index) {
      center[0] += graph.nodes[index][0];
      center[1] += graph.nodes[index][1];
    });
    center[0] /= component.length;
    center[1] /= component.length;

    return component.map(function(index) {
      var x = targetCenter[0] + (graph.nodes[index][0] - center[0]) * scale;
      var y = targetCenter[1] + (graph.nodes[index][1] - center[1]) * scale;
      return {
        index: index,
        x: Math.max(0.02, Math.min(0.98, x)),
        y: Math.max(0.02, Math.min(0.98, y))
      };
    });
  }

  function applyGroupPositions(graph, positions) {
    positions.forEach(function(position) {
      graph.nodes[position.index][0] = position.x;
      graph.nodes[position.index][1] = position.y;
    });
  }

  // Suggest a separating-triangle component move. Candidates are evaluated by
  // their downstream result after a bounded Stage 1 simulation.
  function suggestStage2Move(graph, options) {
    options = options || {};
    var baseCrossings = intersections(graph.links);
    if (baseCrossings === 0) {
      return {
        baseCrossings: 0,
        separatingTriangles: 0,
        candidatesTested: 0,
        best: null,
        candidates: [],
        triangles: []
      };
    }

    var baseClean = graph.nodes.filter(function(node) { return !node.intersection; }).length;
    var triangles = findSeparatingTriangles(graph).slice(0, options.triangleLimit || 12);
    var candidates = [];
    var candidateLimit = options.candidateLimit || 24;
    var simulationSteps = options.simulationSteps || 15;

    for (var ti = 0; ti < triangles.length && candidates.length < candidateLimit; ti++) {
      var triangle = triangles[ti];
      var triPoints = triangle.vertices.map(function(index) { return graph.nodes[index]; });
      var triCenter = [
        (triPoints[0][0] + triPoints[1][0] + triPoints[2][0]) / 3,
        (triPoints[0][1] + triPoints[1][1] + triPoints[2][1]) / 3
      ];

      for (var ci = 0; ci < triangle.components.length && candidates.length < candidateLimit; ci++) {
        var component = triangle.components[ci];
        var componentCenter = [0, 0];
        component.vertices.forEach(function(index) {
          componentCenter[0] += graph.nodes[index][0];
          componentCenter[1] += graph.nodes[index][1];
        });
        componentCenter[0] /= component.vertices.length;
        componentCenter[1] /= component.vertices.length;

        var requestedSides = [];
        if (triangle.components.length === 2) {
          var other = triangle.components[ci === 0 ? 1 : 0];
          if (component.side === 'straddling' && other.side !== 'straddling') {
            requestedSides.push(other.side === 'inside' ? 'outside' : 'inside');
          } else if (component.side === 'straddling' && other.side === 'straddling') {
            var smaller = component.vertices.length <= other.vertices.length;
            requestedSides.push(smaller ? 'inside' : 'outside');
          } else if (component.side === other.side) {
            if (component.side === 'outside' &&
                component.vertices.length <= other.vertices.length) {
              requestedSides.push('inside');
            } else if (component.side === 'inside' &&
                component.vertices.length >= other.vertices.length) {
              requestedSides.push('outside');
            }
          }
        } else if (component.side === 'straddling') {
          requestedSides.push('inside', 'outside');
        } else {
          var hasInside = triangle.components.some(function(item) {
            return item.side === 'inside';
          });
          var hasOutside = triangle.components.some(function(item) {
            return item.side === 'outside';
          });
          var sizes = triangle.components.map(function(item) {
            return item.vertices.length;
          });
          if (!hasInside && component.side === 'outside' &&
              component.vertices.length === Math.min.apply(null, sizes)) {
            requestedSides.push('inside');
          } else if (!hasOutside && component.side === 'inside' &&
              component.vertices.length === Math.max.apply(null, sizes)) {
            requestedSides.push('outside');
          }
        }

        var targets = [];
        if (requestedSides.indexOf('inside') >= 0) {
          targets.push({
            side: 'inside',
            center: triCenter,
            scale: Math.min(0.35, 0.8 / Math.sqrt(component.vertices.length))
          });
        }
        if (requestedSides.indexOf('outside') >= 0) {
          var dx = componentCenter[0] - triCenter[0];
          var dy = componentCenter[1] - triCenter[1];
          var length = Math.sqrt(dx * dx + dy * dy);
          if (length < 0.01) {
            dx = triCenter[0] < 0.5 ? 1 : -1;
            dy = triCenter[1] < 0.5 ? 1 : -1;
            length = Math.sqrt(dx * dx + dy * dy);
          }
          targets.push({
            side: 'outside',
            center: [
              Math.max(0.1, Math.min(0.9, triCenter[0] + dx / length * 0.45)),
              Math.max(0.1, Math.min(0.9, triCenter[1] + dy / length * 0.45))
            ],
            scale: Math.min(0.65, 1.2 / Math.sqrt(component.vertices.length))
          });
        }

        for (var targetIndex = 0; targetIndex < targets.length; targetIndex++) {
          var target = targets[targetIndex];
          var positions = transformComponent(
            graph, component.vertices, target.side, target.center, target.scale);
          var insideFlags = positions.map(function(position) {
            return pointInTriangle(
              [position.x, position.y], triPoints[0], triPoints[1], triPoints[2]);
          });
          var allInside = insideFlags.every(function(inside) { return inside; });
          var anyInside = insideFlags.some(function(inside) { return inside; });
          if ((target.side === 'inside' && !allInside) ||
              (target.side === 'outside' && anyInside)) {
            continue;
          }
          var simulation = cloneGraph(graph);
          applyGroupPositions(simulation, positions);
          var immediateCrossings = intersections(simulation.links);
          var simulationState = {};
          var steps = 0;
          while (steps < simulationSteps) {
            var result = minimizeStep(simulation, simulationState);
            if (!result.move) break;
            steps++;
          }
          var finalCrossings = intersections(simulation.links);
          var finalClean = simulation.nodes.filter(function(node) { return !node.intersection; }).length;
          var downstreamImprovement = baseCrossings - finalCrossings;
          var immediateDamage = Math.max(0, immediateCrossings - baseCrossings);
          var score = downstreamImprovement * 10 + (finalClean - baseClean) * 2 -
            component.vertices.length - immediateDamage * 0.2;

          candidates.push({
            strategy: 'separating-triangle-component',
            triangle: triangle.vertices,
            component: component.vertices,
            fromSide: component.side,
            toSide: target.side,
            positions: positions,
            immediateCrossings: immediateCrossings,
            immediateDamage: immediateDamage,
            finalCrossings: finalCrossings,
            downstreamImprovement: downstreamImprovement,
            cleanDelta: finalClean - baseClean,
            simulationSteps: steps,
            score: score
          });
        }
      }
    }

    candidates.sort(function(a, b) { return b.score - a.score; });
    return {
      baseCrossings: baseCrossings,
      separatingTriangles: triangles.length,
      candidatesTested: candidates.length,
      best: candidates.length > 0 &&
        candidates[0].downstreamImprovement > 0 &&
        candidates[0].score > 0
        ? candidates[0] : null,
      candidates: candidates.slice(0, 5),
      triangles: triangles.slice(0, 5)
    };
  }

  function applyStage2Suggestion(graph, suggestion) {
    if (!suggestion || !suggestion.positions) return false;
    applyGroupPositions(graph, suggestion.positions);
    intersections(graph.links);
    return true;
  }

  function reflectPointAcrossEdge(point, edge, extraDistance) {
    var ax = edge[0][0], ay = edge[0][1];
    var bx = edge[1][0], by = edge[1][1];
    var dx = bx - ax, dy = by - ay;
    var lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-10) return null;

    var t = ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared;
    var projectionX = ax + t * dx;
    var projectionY = ay + t * dy;
    var reflectedX = projectionX * 2 - point[0];
    var reflectedY = projectionY * 2 - point[1];
    var length = Math.sqrt(lengthSquared);
    var side = sideOfEdge(edge, point) >= 0 ? -1 : 1;

    return [
      Math.max(0.02, Math.min(0.98, reflectedX + (-dy / length) * side * extraDistance)),
      Math.max(0.02, Math.min(0.98, reflectedY + (dx / length) * side * extraDistance))
    ];
  }

  // Bounded Stage 2 basin-escape search. It does not try to identify the final
  // topology; it only looks for a small justified perturbation that allows the
  // adaptive Stage 1 descent to reach a better local minimum.
  function suggestStage2Restart(graph, options) {
    options = options || {};
    var startedAt = Date.now();
    var timeBudgetMs = options.timeBudgetMs || 75;
    var candidateLimit = options.candidateLimit || 8;
    var vertexLimit = options.vertexLimit || 3;
    var simulationSteps = options.simulationSteps || 8;
    var baseCrossings = intersections(graph.links);
    var baseClean = graph.nodes.filter(function(node) { return !node.intersection; }).length;
    var requiredImprovement = options.requiredImprovement || 1;

    if (baseCrossings === 0) {
      return {
        type: 'restart',
        baseCrossings: 0,
        requiredImprovement: 0,
        candidateVertices: [],
        lowDegreeCandidates: [],
        candidatesGenerated: 0,
        candidatesTested: 0,
        elapsedMs: 0,
        timeBudgetMs: timeBudgetMs,
        timedOut: false,
        best: null,
        candidates: []
      };
    }

    var crossingCounts = getCrossingCounts(graph);
    var adjacency = graph.nodes.map(function() { return {}; });
    for (var linkIndex = 0; linkIndex < graph.links.length; linkIndex++) {
      var linkA = graph.nodes.indexOf(graph.links[linkIndex][0]);
      var linkB = graph.nodes.indexOf(graph.links[linkIndex][1]);
      if (linkA === linkB) continue;
      adjacency[linkA][linkB] = true;
      adjacency[linkB][linkA] = true;
    }
    var lowDegree = crossingCounts.map(function(count, index) {
      var neighbors = Object.keys(adjacency[index]).map(Number);
      var averageLength = 0;
      neighbors.forEach(function(neighborIndex) {
        var dx = graph.nodes[index][0] - graph.nodes[neighborIndex][0];
        var dy = graph.nodes[index][1] - graph.nodes[neighborIndex][1];
        averageLength += Math.sqrt(dx * dx + dy * dy);
      });
      averageLength /= Math.max(1, neighbors.length);
      return {
        index: index,
        crossings: count,
        degree: neighbors.length,
        neighbors: neighbors,
        score: averageLength * 10 + count / Math.max(1, neighbors.length)
      };
    }).filter(function(item) {
      return item.crossings > 0 && item.degree >= 3 && item.degree <= 5;
    }).sort(function(a, b) {
      return b.score - a.score;
    }).slice(0, 4);
    var ranked = crossingCounts.map(function(count, index) {
      return { index: index, crossings: count };
    }).filter(function(item) {
      return item.crossings > 0;
    }).sort(function(a, b) {
      return b.crossings - a.crossings;
    }).slice(0, vertexLimit);
    var rankedSet = {};
    ranked.forEach(function(item) { rankedSet[item.index] = true; });

    var conflicts = {};
    ranked.forEach(function(item) { conflicts[item.index] = []; });
    for (var i = 0; i < graph.links.length; i++) {
      for (var j = i + 1; j < graph.links.length; j++) {
        if (!intersect(graph.links[i], graph.links[j])) continue;
        var endpointsA = [
          graph.nodes.indexOf(graph.links[i][0]),
          graph.nodes.indexOf(graph.links[i][1])
        ];
        var endpointsB = [
          graph.nodes.indexOf(graph.links[j][0]),
          graph.nodes.indexOf(graph.links[j][1])
        ];
        endpointsA.forEach(function(index) {
          if (rankedSet[index]) {
            conflicts[index].push({ incident: graph.links[i], opposing: graph.links[j] });
          }
        });
        endpointsB.forEach(function(index) {
          if (rankedSet[index]) {
            conflicts[index].push({ incident: graph.links[j], opposing: graph.links[i] });
          }
        });
      }
    }

    var generated = [];
    var seen = {};

    function addCandidate(strategy, component, positions, reason) {
      if (generated.length >= candidateLimit) return;
      var key = component.slice().sort(function(a, b) { return a - b; }).join(',') +
        ':' + positions.map(function(p) {
          return p.x.toFixed(2) + ',' + p.y.toFixed(2);
        }).join(';');
      if (seen[key]) return;
      seen[key] = true;
      generated.push({
        strategy: strategy,
        component: component,
        positions: positions,
        reason: reason
      });
    }

    // First priority: low-degree outliers whose neighbors already describe a
    // local triangular enclosure. These are often visually obvious even when
    // the vertex does not dominate the total crossing count.
    for (var li = 0; li < lowDegree.length && generated.length < candidateLimit; li++) {
      var local = lowDegree[li];
      var localNode = graph.nodes[local.index];
      var neighbors = local.neighbors;

      for (var a = 0; a < neighbors.length && generated.length < candidateLimit; a++) {
        for (var b = a + 1; b < neighbors.length && generated.length < candidateLimit; b++) {
          var neighborA = neighbors[a];
          var neighborB = neighbors[b];
          if (!adjacency[neighborA][neighborB]) continue;

          var edge = [graph.nodes[neighborA], graph.nodes[neighborB]];
          var vertexSide = sideOfEdge(edge, localNode);
          var sameSide = 0;
          var oppositeSide = 0;
          for (var otherIndex = 0; otherIndex < neighbors.length; otherIndex++) {
            var neighbor = neighbors[otherIndex];
            if (neighbor === neighborA || neighbor === neighborB) continue;
            var otherSide = sideOfEdge(edge, graph.nodes[neighbor]);
            if (Math.abs(otherSide) < 1e-8 || Math.abs(vertexSide) < 1e-8) continue;
            if (otherSide * vertexSide > 0) sameSide++;
            else oppositeSide++;
          }

          // If the low-degree vertex is opposite most of its other neighbors,
          // try flipping it across this neighbor-neighbor edge.
          if (oppositeSide > sameSide) {
            var flipped = reflectPointAcrossEdge(localNode, edge, 0.025);
            if (flipped) {
              addCandidate('restart-local-side-flip', [local.index], [
                { index: local.index, x: flipped[0], y: flipped[1] }
              ], 'flip low-degree outlier v' + local.index +
                ' across neighbor edge v' + neighborA + '-v' + neighborB);
            }
          }

          // A triangle of mutually adjacent neighbors is a strong local
          // enclosure candidate, especially for degree-3 vertices.
          for (var c = b + 1; c < neighbors.length &&
              generated.length < candidateLimit; c++) {
            var neighborC = neighbors[c];
            if (!adjacency[neighborA][neighborC] || !adjacency[neighborB][neighborC]) {
              continue;
            }
            var triangleA = graph.nodes[neighborA];
            var triangleB = graph.nodes[neighborB];
            var triangleC = graph.nodes[neighborC];
            if (pointInTriangle(localNode, triangleA, triangleB, triangleC)) continue;
            addCandidate('restart-neighbor-triangle', [local.index], [{
              index: local.index,
              x: (triangleA[0] + triangleB[0] + triangleC[0]) / 3,
              y: (triangleA[1] + triangleB[1] + triangleC[1]) / 3
            }], 'place low-degree outlier v' + local.index +
              ' inside neighbor triangle [' + neighborA + ',' + neighborB + ',' +
              neighborC + ']');
          }
        }
      }
    }

    for (var ri = 0; ri < ranked.length && generated.length < candidateLimit; ri++) {
      var vertexIndex = ranked[ri].index;
      var node = graph.nodes[vertexIndex];
      var vertexConflicts = conflicts[vertexIndex] || [];
      for (var oi = 0; oi < Math.min(2, vertexConflicts.length) &&
          generated.length < candidateLimit; oi++) {
        var conflict = vertexConflicts[oi];
        var target = reflectPointAcrossEdge(node, conflict.opposing, 0.04);
        if (!target) continue;
        var dx = target[0] - node[0];
        var dy = target[1] - node[1];

        addCandidate('restart-edge-jump', [vertexIndex], [
          { index: vertexIndex, x: target[0], y: target[1] }
        ], 'move v' + vertexIndex + ' across an edge crossing its incident edges');

        var incidentNeighbor = conflict.incident[0] === node
          ? conflict.incident[1] : conflict.incident[0];
        var incidentNeighborIndex = graph.nodes.indexOf(incidentNeighbor);
        if (incidentNeighborIndex >= 0 && incidentNeighborIndex !== vertexIndex) {
          addCandidate('restart-crossing-edge-pair',
            [vertexIndex, incidentNeighborIndex], [
            { index: vertexIndex, x: target[0], y: target[1] },
            {
              index: incidentNeighborIndex,
              x: Math.max(0.02, Math.min(0.98, incidentNeighbor[0] + dx)),
              y: Math.max(0.02, Math.min(0.98, incidentNeighbor[1] + dy))
            }
          ], 'translate both endpoints of a directly crossing edge');
        }
      }
    }

    var tested = [];
    var best = null;
    var timedOut = false;

    function deterministicMinimizeStep(simulation, state) {
      var move = findAdaptiveMinimizeMove(simulation, state, {
        candidateLimit: 8,
        randomSamples: 0,
        strongImprovement: Infinity
      });
      if (!move) return false;
      move.node[0] = move.toX;
      move.node[1] = move.toY;
      recordMove(state, move.nodeIndex, move.toX, move.toY);
      intersections(simulation.links);
      return true;
    }

    for (var ci = 0; ci < generated.length; ci++) {
      if (Date.now() - startedAt >= timeBudgetMs) {
        timedOut = true;
        break;
      }

      var candidate = generated[ci];
      var simulation = cloneGraph(graph);
      applyGroupPositions(simulation, candidate.positions);
      var immediateCrossings = intersections(simulation.links);
      var immediateDamage = Math.max(0, immediateCrossings - baseCrossings);
      var catastrophicLimit = Math.max(20, Math.ceil(baseCrossings * 0.75));
      if (immediateDamage > catastrophicLimit) continue;

      var simulationState = {};
      var steps = 0;
      while (steps < simulationSteps && Date.now() - startedAt < timeBudgetMs) {
        if (!deterministicMinimizeStep(simulation, simulationState)) break;
        steps++;
      }
      if (Date.now() - startedAt >= timeBudgetMs) timedOut = true;

      var finalCrossings = intersections(simulation.links);
      var finalClean = simulation.nodes.filter(function(node) { return !node.intersection; }).length;
      var downstreamImprovement = baseCrossings - finalCrossings;
      var cleanDelta = finalClean - baseClean;
      var accepted = downstreamImprovement >= requiredImprovement;
      var scored = {
        type: 'restart',
        strategy: candidate.strategy,
        component: candidate.component,
        positions: candidate.positions,
        reason: candidate.reason,
        immediateCrossings: immediateCrossings,
        immediateDamage: immediateDamage,
        finalCrossings: finalCrossings,
        downstreamImprovement: downstreamImprovement,
        cleanDelta: cleanDelta,
        simulationSteps: steps,
        score: downstreamImprovement * 10 + cleanDelta * 2 -
          candidate.component.length - immediateDamage * 0.2,
        accepted: accepted
      };
      tested.push(scored);

      if (accepted && (!best || scored.score > best.score)) best = scored;
      if (accepted && downstreamImprovement >= requiredImprovement * 2) break;
      if (timedOut) break;
    }

    tested.sort(function(a, b) { return b.score - a.score; });
    return {
      type: 'restart',
      baseCrossings: baseCrossings,
      requiredImprovement: requiredImprovement,
      candidateVertices: lowDegree.map(function(item) { return item.index; })
        .concat(ranked.map(function(item) { return item.index; }))
        .filter(function(index, position, all) { return all.indexOf(index) === position; }),
      lowDegreeCandidates: lowDegree.map(function(item) {
        return { vertex: item.index, degree: item.degree, crossings: item.crossings };
      }),
      candidatesGenerated: generated.length,
      candidatesTested: tested.length,
      elapsedMs: Date.now() - startedAt,
      timeBudgetMs: timeBudgetMs,
      timedOut: timedOut,
      best: best,
      candidates: tested.slice(0, 5)
    };
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
  
  // ===========================================================================
  // SECTION: MANUAL-ONLY STRATEGIES (buttons in interactive mode)
  // These are NOT called by solverStep - available as manual tools only.
  // Removed from auto loop because they were causing issues (see ALGO_ARCHIVE.md)
  // ===========================================================================
  
  // findCompactMove: Move yellow vertices toward local cluster centroids
  // MANUAL ONLY - was causing solver to get stuck faster
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

  // Build a compact final embedding, then reach it one vertex at a time.
  // Uniformly scaling the final embedding preserves planarity; the scheduler's
  // job is to order individual moves through temporary directional constraints.
  function createConsolidationState(graph, factor) {
    factor = factor || 2.5;
    var cx = 0, cy = 0;
    for (var i = 0; i < graph.nodes.length; i++) {
      cx += graph.nodes[i][0];
      cy += graph.nodes[i][1];
    }
    cx /= graph.nodes.length;
    cy /= graph.nodes.length;

    return {
      factor: factor,
      center: [cx, cy],
      targetPositions: graph.nodes.map(function(node) {
        return [
          cx + (node[0] - cx) / factor,
          cy + (node[1] - cy) / factor
        ];
      }),
      finished: {},
      finishedAxes: {},
      moves: [],
      initialCrossings: intersections(graph.links)
    };
  }

  function consolidationBlockers(graph, nodeIndex, toX, toY) {
    var node = graph.nodes[nodeIndex];
    var fromX = node[0], fromY = node[1];
    var moveX = toX - fromX, moveY = toY - fromY;
    var moveLength = Math.sqrt(moveX * moveX + moveY * moveY) || 1;
    var incident = [];
    var blockers = {};

    for (var i = 0; i < graph.links.length; i++) {
      if (graph.links[i][0] === node || graph.links[i][1] === node) {
        incident.push(i);
      }
    }

    node[0] = toX;
    node[1] = toY;
    for (var a = 0; a < incident.length; a++) {
      var incidentIndex = incident[a];
      var movedEdge = graph.links[incidentIndex];
      for (var b = 0; b < graph.links.length; b++) {
        if (b === incidentIndex || incident.indexOf(b) >= 0) continue;
        var edge = graph.links[b];
        if (!intersect(movedEdge, edge)) continue;

        var edgeX = edge[1][0] - edge[0][0];
        var edgeY = edge[1][1] - edge[0][1];
        var edgeLength = Math.sqrt(edgeX * edgeX + edgeY * edgeY) || 1;
        var alignment = Math.abs((moveX * edgeX + moveY * edgeY) /
          (moveLength * edgeLength));
        blockers[b] = {
          edgeIndex: b,
          vertices: [graph.nodes.indexOf(edge[0]), graph.nodes.indexOf(edge[1])],
          alignment: alignment,
          orthogonal: alignment < 0.5
        };
      }
    }
    node[0] = fromX;
    node[1] = fromY;

    return Object.keys(blockers).map(function(key) { return blockers[key]; });
  }

  function findDirectionalConsolidateMove(graph, state) {
    if (!state || !state.targetPositions) return null;
    var currentCrossings = intersections(graph.links);
    var candidates = [];

    for (var i = 0; i < graph.nodes.length; i++) {
      if (state.finished[i]) continue;
      var node = graph.nodes[i];
      var target = state.targetPositions[i];
      var axes = state.finishedAxes[i] || (state.finishedAxes[i] = {});

      ['x', 'y'].forEach(function(axis) {
        if (axes[axis]) return;
        var axisIndex = axis === 'x' ? 0 : 1;
        var distance = Math.abs(target[axisIndex] - node[axisIndex]);
        if (distance < 1e-5) {
          axes[axis] = true;
          return;
        }

        var fromX = node[0], fromY = node[1];
        var toX = axis === 'x' ? target[0] : fromX;
        var toY = axis === 'y' ? target[1] : fromY;
        var blockers = consolidationBlockers(graph, i, toX, toY);
        node[0] = toX;
        node[1] = toY;
        var newCrossings = intersections(graph.links);
        node[0] = fromX;
        node[1] = fromY;

        var orthogonalCount = blockers.filter(function(blocker) {
          return blocker.orthogonal;
        }).length;
        candidates.push({
          node: node,
          nodeIndex: i,
          axis: axis,
          fromX: fromX,
          fromY: fromY,
          toX: toX,
          toY: toY,
          distance: distance,
          crossingsBefore: currentCrossings,
          crossingsAfter: newCrossings,
          crossingDelta: newCrossings - currentCrossings,
          blockers: blockers,
          orthogonalBlockers: orthogonalCount,
          strategy: 'directional-consolidate-' + axis
        });
      });

      if (axes.x && axes.y) state.finished[i] = true;
    }

    intersections(graph.links);
    if (candidates.length === 0) return null;

    // A player first takes moves with little obstruction. Among equally safe
    // moves, larger moves create useful room for the remaining vertices.
    candidates.sort(function(a, b) {
      if (a.crossingsAfter !== b.crossingsAfter) {
        return a.crossingsAfter - b.crossingsAfter;
      }
      if (a.orthogonalBlockers !== b.orthogonalBlockers) {
        return a.orthogonalBlockers - b.orthogonalBlockers;
      }
      return b.distance - a.distance;
    });
    return candidates[0];
  }

  function applyDirectionalConsolidateMove(graph, state, move) {
    if (!move || !state) return false;
    move.node[0] = move.toX;
    move.node[1] = move.toY;
    state.finishedAxes[move.nodeIndex][move.axis] = true;
    if (state.finishedAxes[move.nodeIndex].x && state.finishedAxes[move.nodeIndex].y) {
      state.finished[move.nodeIndex] = true;
    }
    state.moves.push({
      nodeIndex: move.nodeIndex,
      axis: move.axis,
      crossingsBefore: move.crossingsBefore,
      crossingsAfter: intersections(graph.links),
      orthogonalBlockers: move.orthogonalBlockers
    });
    return true;
  }
  
  // ===========================================================================
  // SECTION: STAGE 2 - BARRIER MOVES (topological boundary reasoning)
  // Triggered when single-move strategies fail but before escape.
  // Key insight: Jordan curve theorem - if an edge crosses a boundary,
  // its endpoints must be on opposite sides. Move one to the correct side.
  // ===========================================================================
  
  // findBarrierMove: Try to make non-yellow vertices yellow by moving them
  // Goal: increase yellow count, not just minimize crossings
  function findBarrierMove(graph) {
    var links = graph.links;
    var nodes = graph.nodes;
    intersections(links);  // refresh flags
    
    // Find non-yellow vertices (have at least one crossing edge)
    var nonYellow = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].intersection) {
        nonYellow.push(i);
      }
    }
    
    if (nonYellow.length === 0) return null;
    
    // Get edges for each vertex (for fast lookup)
    var vertexEdges = [];
    for (var i = 0; i < nodes.length; i++) vertexEdges[i] = [];
    for (var i = 0; i < links.length; i++) {
      var a = nodes.indexOf(links[i][0]);
      var b = nodes.indexOf(links[i][1]);
      vertexEdges[a].push(i);
      vertexEdges[b].push(i);
    }
    
    // Calculate net yellow gain if vertex vi moves to (x, y)
    // Returns: positive = net gain, 0 = no change, negative = net loss
    function netYellowGain(vi, x, y) {
      var node = nodes[vi];
      var myEdges = vertexEdges[vi];
      var wasYellow = !node.intersection;
      
      // Check if V would be yellow at new position
      var wouldBeYellow = true;
      var newCrossings = [];  // edges that V's new position would cross
      
      for (var i = 0; i < myEdges.length && wouldBeYellow; i++) {
        var edge = links[myEdges[i]];
        var other = edge[0] === node ? edge[1] : edge[0];
        var ex1 = x, ey1 = y;
        var ex2 = other[0], ey2 = other[1];
        
        for (var j = 0; j < links.length; j++) {
          if (myEdges.indexOf(j) >= 0) continue;
          var otherEdge = links[j];
          if (otherEdge[0] === node || otherEdge[1] === node ||
              otherEdge[0] === other || otherEdge[1] === other) continue;
          
          if (edgesIntersectCoords(ex1, ey1, ex2, ey2,
              otherEdge[0][0], otherEdge[0][1], otherEdge[1][0], otherEdge[1][1])) {
            wouldBeYellow = false;
            newCrossings.push(j);
          }
        }
      }
      
      // Gain from V becoming yellow (if it wasn't already)
      var gain = 0;
      if (wouldBeYellow && !wasYellow) gain = 1;
      if (!wouldBeYellow && wasYellow) gain = -1;
      
      // Check which currently-yellow vertices would become non-yellow
      // These are vertices whose edges would now cross V's new edges
      var yellowVictimsSet = {};
      for (var i = 0; i < myEdges.length; i++) {
        var edge = links[myEdges[i]];
        var other = edge[0] === node ? edge[1] : edge[0];
        var ex1 = x, ey1 = y;
        var ex2 = other[0], ey2 = other[1];
        
        for (var j = 0; j < links.length; j++) {
          if (myEdges.indexOf(j) >= 0) continue;
          var otherEdge = links[j];
          if (otherEdge[0] === node || otherEdge[1] === node ||
              otherEdge[0] === other || otherEdge[1] === other) continue;
          
          // Check if this edge was NOT crossing before but WOULD cross now
          var otherV1 = nodes.indexOf(otherEdge[0]);
          var otherV2 = nodes.indexOf(otherEdge[1]);
          
          // Only care if the other edge's vertices are currently yellow
          if (!nodes[otherV1].intersection) {
            // This vertex is yellow - would our new edge make it non-yellow?
            var oldEx1 = node[0], oldEy1 = node[1];
            var wasIntersecting = edgesIntersectCoords(oldEx1, oldEy1, ex2, ey2,
                otherEdge[0][0], otherEdge[0][1], otherEdge[1][0], otherEdge[1][1]);
            var nowIntersecting = edgesIntersectCoords(ex1, ey1, ex2, ey2,
                otherEdge[0][0], otherEdge[0][1], otherEdge[1][0], otherEdge[1][1]);
            
            if (!wasIntersecting && nowIntersecting) {
              yellowVictimsSet[otherV1] = true;
            }
          }
          if (!nodes[otherV2].intersection && otherV2 !== otherV1) {
            var oldEx1 = node[0], oldEy1 = node[1];
            var wasIntersecting = edgesIntersectCoords(oldEx1, oldEy1, ex2, ey2,
                otherEdge[0][0], otherEdge[0][1], otherEdge[1][0], otherEdge[1][1]);
            var nowIntersecting = edgesIntersectCoords(ex1, ey1, ex2, ey2,
                otherEdge[0][0], otherEdge[0][1], otherEdge[1][0], otherEdge[1][1]);
            
            if (!wasIntersecting && nowIntersecting) {
              yellowVictimsSet[otherV2] = true;
            }
          }
        }
      }
      
      var victims = Object.keys(yellowVictimsSet).length;
      return gain - victims;
    }
    
    // Try each non-yellow vertex
    for (var c = 0; c < Math.min(5, nonYellow.length); c++) {
      var vi = nonYellow[c];
      var node = nodes[vi];
      var origX = node[0], origY = node[1];
      
      // Generate candidate positions: past each neighbor
      var neighbors = [];
      vertexEdges[vi].forEach(function(ei) {
        var edge = links[ei];
        var other = edge[0] === node ? edge[1] : edge[0];
        var ni = nodes.indexOf(other);
        if (neighbors.indexOf(ni) < 0) neighbors.push(ni);
      });
      
      for (var n = 0; n < neighbors.length; n++) {
        var ni = neighbors[n];
        var nx = nodes[ni][0], ny = nodes[ni][1];
        var dx = nx - origX, dy = ny - origY;
        var dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 0.01) continue;
        
        // Try position past the neighbor
        var targetX = nx + dx/dist * 0.05;
        var targetY = ny + dy/dist * 0.05;
        targetX = Math.max(0.03, Math.min(0.97, targetX));
        targetY = Math.max(0.03, Math.min(0.97, targetY));
        
        if (isTooClose(graph, node, targetX, targetY)) continue;
        
        // Check net yellow gain
        var gain = netYellowGain(vi, targetX, targetY);
        if (gain > 0) {
          return {
            node: node,
            nodeIndex: vi,
            toX: targetX,
            toY: targetY,
            improvement: gain,
            strategy: 'barrierMove'
          };
        }
      }
      
      // Also try boundary positions
      var boundaryPos = [
        [0.03, origY], [0.97, origY],
        [origX, 0.03], [origX, 0.97]
      ];
      for (var b = 0; b < boundaryPos.length; b++) {
        var targetX = boundaryPos[b][0];
        var targetY = boundaryPos[b][1];
        if (isTooClose(graph, node, targetX, targetY)) continue;
        
        var gain = netYellowGain(vi, targetX, targetY);
        if (gain > 0) {
          return {
            node: node,
            nodeIndex: vi,
            toX: targetX,
            toY: targetY,
            improvement: gain,
            strategy: 'barrierMove-boundary'
          };
        }
      }
    }
    
    // ========================================================================
    // STAGE 2B: Two-vertex moves
    // When single-vertex moves fail, try moving pairs of connected vertices
    // Key insight: if v1 needs to cross a barrier, its neighbor v2 may need
    // to move with it to prevent v1-v2 edge from crossing the barrier
    // ========================================================================
    
    // Find crossing pairs
    var crossingPairs = [];
    for (var i = 0; i < links.length; i++) {
      if (!links[i].intersection) continue;
      for (var j = i + 1; j < links.length; j++) {
        if (!links[j].intersection) continue;
        var a = nodes.indexOf(links[i][0]), b = nodes.indexOf(links[i][1]);
        var c = nodes.indexOf(links[j][0]), d = nodes.indexOf(links[j][1]);
        if (a === c || a === d || b === c || b === d) continue;
        if (edgesIntersectCoords(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1],
                                  nodes[c][0], nodes[c][1], nodes[d][0], nodes[d][1])) {
          crossingPairs.push({e1: [a, b], e2: [c, d]});
        }
      }
    }
    
    // For each crossing, try 2-vertex moves
    for (var cp = 0; cp < Math.min(3, crossingPairs.length); cp++) {
      var pair = crossingPairs[cp];
      var e1 = pair.e1, e2 = pair.e2;  // e1 = [a,b], e2 = [c,d]
      
      // Use e1 as the "barrier" edge, try to move vertices from e2 to same side
      var barrierA = e1[0], barrierB = e1[1];
      var bx1 = nodes[barrierA][0], by1 = nodes[barrierA][1];
      var bx2 = nodes[barrierB][0], by2 = nodes[barrierB][1];
      
      // Check which vertex of e2 is on "wrong" side (opposite side from the other)
      var sideC = sideOfLine(bx1, by1, bx2, by2, nodes[e2[0]][0], nodes[e2[0]][1]);
      var sideD = sideOfLine(bx1, by1, bx2, by2, nodes[e2[1]][0], nodes[e2[1]][1]);
      
      // They should be on opposite sides (that's why they cross)
      if (sideC * sideD >= 0) continue;  // same side, shouldn't happen
      
      // Move the vertex on negative side to the positive side (where the other vertex is)
      // Note: sideC and sideD have opposite signs, so exactly one is negative
      var moveV = sideC < 0 ? e2[0] : e2[1];
      var targetSide = 1;  // always move to positive side
      var currentSide = sideC < 0 ? sideC : sideD;  // current (wrong) side of moveV
      
      // Find neighbors of moveV that are also on wrong side (negative side)
      var moveVNeighbors = [];
      vertexEdges[moveV].forEach(function(ei) {
        var edge = links[ei];
        var other = edge[0] === nodes[moveV] ? edge[1] : edge[0];
        var ni = nodes.indexOf(other);
        var sideN = sideOfLine(bx1, by1, bx2, by2, other[0], other[1]);
        // If neighbor is also on the negative (wrong) side, include them
        if (sideN < 0) {
          moveVNeighbors.push(ni);
        }
      });
      
      // Try moving moveV with each of its wrong-side neighbors
      for (var nbr = 0; nbr < moveVNeighbors.length; nbr++) {
        var v2 = moveVNeighbors[nbr];
        
        // Count original yellow
        var origYellowCount = 0;
        for (var i = 0; i < nodes.length; i++) {
          if (!nodes[i].intersection) origYellowCount++;
        }
        
        // Save original positions
        var orig1 = [nodes[moveV][0], nodes[moveV][1]];
        var orig2 = [nodes[v2][0], nodes[v2][1]];
        
        // Search grid for best positions (0.05 spacing, full canvas range)
        var bestGain = 0;
        var bestPos1 = null, bestPos2 = null;
        
        for (var x1 = 0.03; x1 <= 0.97; x1 += 0.05) {
          for (var y1 = 0.03; y1 <= 0.97; y1 += 0.05) {
            // Must be on positive side (targetSide = 1)
            var s1 = sideOfLine(bx1, by1, bx2, by2, x1, y1);
            if (s1 <= 0) continue;
            
            // Check not too close to other vertices
            var tooClose1 = false;
            for (var k = 0; k < nodes.length; k++) {
              if (k === moveV || k === v2) continue;
              var dx = nodes[k][0] - x1, dy = nodes[k][1] - y1;
              if (Math.sqrt(dx*dx + dy*dy) < 0.02) { tooClose1 = true; break; }
            }
            if (tooClose1) continue;
            
            for (var x2 = 0.03; x2 <= 0.97; x2 += 0.05) {
              for (var y2 = 0.03; y2 <= 0.97; y2 += 0.05) {
                // Must be on positive side
                var s2 = sideOfLine(bx1, by1, bx2, by2, x2, y2);
                if (s2 <= 0) continue;
                
                // Check not too close
                var tooClose2 = false;
                for (var k = 0; k < nodes.length; k++) {
                  if (k === moveV || k === v2) continue;
                  var dx = nodes[k][0] - x2, dy = nodes[k][1] - y2;
                  if (Math.sqrt(dx*dx + dy*dy) < 0.02) { tooClose2 = true; break; }
                }
                if (tooClose2) continue;
                
                // Check v1 and v2 not too close to each other
                var dxPair = x1 - x2, dyPair = y1 - y2;
                if (Math.sqrt(dxPair*dxPair + dyPair*dyPair) < 0.02) continue;
                
                // Try the moves
                nodes[moveV][0] = x1; nodes[moveV][1] = y1;
                nodes[v2][0] = x2; nodes[v2][1] = y2;
                
                intersections(links);
                var newYellowCount = 0;
                for (var k = 0; k < nodes.length; k++) {
                  if (!nodes[k].intersection) newYellowCount++;
                }
                
                var gain = newYellowCount - origYellowCount;
                if (gain > bestGain) {
                  bestGain = gain;
                  bestPos1 = [x1, y1];
                  bestPos2 = [x2, y2];
                }
                
                // Reset
                nodes[moveV][0] = orig1[0]; nodes[moveV][1] = orig1[1];
                nodes[v2][0] = orig2[0]; nodes[v2][1] = orig2[1];
              }
            }
          }
        }
        
        // Restore original intersection state
        intersections(links);
        
        if (bestGain > 0 && bestPos1 && bestPos2) {
          // Return as a 2-move combo (execute first move, second will be found next iteration)
          return {
            node: nodes[moveV],
            nodeIndex: moveV,
            toX: bestPos1[0],
            toY: bestPos1[1],
            improvement: bestGain,
            strategy: 'barrierMove-2vertex',
            // Store second move for next iteration
            secondMove: {
              nodeIndex: v2,
              toX: bestPos2[0],
              toY: bestPos2[1]
            }
          };
        }
      }
    }
    
    return null;
  }
  
  // Edge intersection test using coordinates directly
  function edgesIntersectCoords(x1, y1, x2, y2, x3, y3, x4, y4) {
    var denom = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
    if (Math.abs(denom) < 1e-10) return false;
    var t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / denom;
    var u = -((x1-x2)*(y1-y3) - (y1-y2)*(x1-x3)) / denom;
    return t > 0 && t < 1 && u > 0 && u < 1;
  }
  
  // Which side of line (x1,y1)-(x2,y2) is point (px,py)?
  // Returns positive, negative, or ~0
  function sideOfLine(x1, y1, x2, y2, px, py) {
    return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  }
  
  // Simple edge intersection test
  
  // ===========================================================================
  // SECTION: ESCAPE STRATEGY (last resort in main loop)
  // Called when all other strategies fail. May increase crossings by up to 5.
  // Targets "sore thumb" vertices: long edges + weak anchor score.
  // ===========================================================================
  
  // findEscapeMove: Reposition a problematic vertex when stuck
  // ACTIVE in solverStep: Fallback after all other strategies fail
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
  
  // ===========================================================================
  // SECTION: MAIN SOLVER LOOP
  // Orchestrates strategy selection based on crossing count (game phase).
  // Includes oscillation detection to prevent strategies from fighting.
  // See ALGO_ARCHIVE.md for disabled strategies and their history.
  // ===========================================================================
  
  // wouldOscillate: Returns true if this move would return vertex to a recent position
  // Prevents infinite loops where strategies keep undoing each other
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

  // Focused Stage 1 descent. Rank a small set of problematic vertices, try
  // deterministic positions first, then spend a small random budget only when
  // needed. Returns null when the bounded search finds no reducing move.
  function findAdaptiveMinimizeMove(graph, state, options) {
    state = state || {};
    options = options || {};

    var count = intersections(graph.links);
    if (count === 0) return null;

    var crossingCounts = getCrossingCounts(graph);
    var candidateLimit = options.candidateLimit || Math.min(8, graph.nodes.length);
    var randomSamples = options.randomSamples === undefined ? 5 : options.randomSamples;
    var strongImprovement = options.strongImprovement ||
      Math.max(3, Math.ceil(count * 0.03));
    var repeatedMoves = {};

    (state.recentMoves || []).forEach(function(move) {
      repeatedMoves[move.nodeIndex] = (repeatedMoves[move.nodeIndex] || 0) + 1;
    });

    var ranked = [];
    for (var i = 0; i < graph.nodes.length; i++) {
      if (crossingCounts[i] === 0) continue;
      var degree = getNodeEdges(graph, graph.nodes[i]).length;
      var repeatPenalty = repeatedMoves[i] || 0;
      ranked.push({
        index: i,
        node: graph.nodes[i],
        crossings: crossingCounts[i],
        degree: degree,
        score: crossingCounts[i] * 2 + crossingCounts[i] / Math.max(1, degree) - repeatPenalty
      });
    }
    ranked.sort(function(a, b) { return b.score - a.score; });
    ranked = ranked.slice(0, candidateLimit);

    var bestMove = null;
    var bestImprovement = 0;
    var positionsTested = 0;
    var deterministicTested = 0;
    var randomTested = 0;
    var verticesTested = 0;

    function testPosition(item, edges, crossingsBefore, x, y, strategy) {
      x = Math.max(0.02, Math.min(0.98, x));
      y = Math.max(0.02, Math.min(0.98, y));
      if (isTooClose(graph, item.node, x, y)) return false;

      var oldX = item.node[0], oldY = item.node[1];
      item.node[0] = x;
      item.node[1] = y;
      var crossingsAfter = countEdgeCrossings(graph, edges);
      item.node[0] = oldX;
      item.node[1] = oldY;

      positionsTested++;
      var improvement = crossingsBefore - crossingsAfter;
      if (improvement > bestImprovement &&
          !wouldOscillate(state, item.index, x, y)) {
        bestImprovement = improvement;
        bestMove = {
          node: item.node,
          nodeIndex: item.index,
          fromX: oldX,
          fromY: oldY,
          toX: x,
          toY: y,
          improvement: improvement,
          strategy: strategy
        };
      }
      return bestImprovement >= strongImprovement;
    }

    // Deterministic pass: centroids and small local moves on ranked vertices.
    for (var r = 0; r < ranked.length; r++) {
      var item = ranked[r];
      var node = item.node;
      var edges = getNodeEdges(graph, node);
      var crossingsBefore = countEdgeCrossings(graph, edges);
      var neighbors = getNeighbors(graph, node);
      verticesTested++;

      if (neighbors.length > 0) {
        var cx = 0, cy = 0;
        for (var n = 0; n < neighbors.length; n++) {
          cx += neighbors[n][0];
          cy += neighbors[n][1];
        }
        cx /= neighbors.length;
        cy /= neighbors.length;

        deterministicTested++;
        if (testPosition(item, edges, crossingsBefore, cx, cy, 'adaptive-centroid')) break;
        deterministicTested++;
        if (testPosition(item, edges, crossingsBefore,
            node[0] + (cx - node[0]) * 0.5,
            node[1] + (cy - node[1]) * 0.5,
            'adaptive-centroid-half')) break;
      }

      var directions = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1]
      ];
      for (var d = 0; d < directions.length; d++) {
        deterministicTested++;
        if (testPosition(item, edges, crossingsBefore,
            node[0] + directions[d][0] * 0.04,
            node[1] + directions[d][1] * 0.04,
            'adaptive-local')) break;
      }
      if (bestImprovement >= strongImprovement) break;
    }

    // Random pass only if deterministic candidates did not find a strong move.
    if (bestImprovement < strongImprovement) {
      for (var r = 0; r < ranked.length; r++) {
        var item = ranked[r];
        var edges = getNodeEdges(graph, item.node);
        var crossingsBefore = countEdgeCrossings(graph, edges);
        for (var s = 0; s < randomSamples; s++) {
          randomTested++;
          if (testPosition(item, edges, crossingsBefore,
              0.05 + Math.random() * 0.9,
              0.05 + Math.random() * 0.9,
              'adaptive-random')) break;
        }
        if (bestImprovement >= strongImprovement) break;
      }
    }

    var attempt = {
      crossingCount: count,
      candidateVertices: ranked.map(function(item) { return item.index; }),
      verticesTested: verticesTested,
      positionsTested: positionsTested,
      deterministicTested: deterministicTested,
      randomTested: randomTested,
      strongImprovementTarget: strongImprovement,
      bestImprovement: bestImprovement,
      exhausted: !bestMove
    };
    state.lastMinimizeAttempt = attempt;
    if (bestMove) bestMove.search = attempt;
    return bestMove;
  }

  // Stage 1b: low-degree "sore thumb" vertices often sit on the wrong side of
  // an edge between two of their neighbors. Test only those topologically
  // motivated side flips and accept only immediate crossing reductions.
  function findReducingSideFlipMove(graph, state, options) {
    state = state || {};
    options = options || {};
    var count = intersections(graph.links);
    if (count === 0) return null;
    state.sideFlipVertices = state.sideFlipVertices || {};
    if ((state.sideFlipMoves || 0) >= (options.moveLimit || 4)) return null;

    var crossingCounts = getCrossingCounts(graph);
    var adjacency = graph.nodes.map(function() { return {}; });
    for (var i = 0; i < graph.links.length; i++) {
      var a = graph.nodes.indexOf(graph.links[i][0]);
      var b = graph.nodes.indexOf(graph.links[i][1]);
      if (a === b) continue;
      adjacency[a][b] = true;
      adjacency[b][a] = true;
    }

    var candidates = crossingCounts.map(function(crossings, index) {
      var neighbors = Object.keys(adjacency[index]).map(Number);
      var averageLength = 0;
      neighbors.forEach(function(neighborIndex) {
        var dx = graph.nodes[index][0] - graph.nodes[neighborIndex][0];
        var dy = graph.nodes[index][1] - graph.nodes[neighborIndex][1];
        averageLength += Math.sqrt(dx * dx + dy * dy);
      });
      return {
        index: index,
        crossings: crossings,
        neighbors: neighbors,
        degree: neighbors.length,
        score: averageLength / Math.max(1, neighbors.length) +
          crossings / Math.max(1, neighbors.length) * 0.02
      };
    }).filter(function(item) {
      return item.crossings > 0 && item.degree >= 2 && item.degree <= 5 &&
        !state.sideFlipVertices[item.index];
    }).sort(function(a, b) {
      return b.score - a.score;
    }).slice(0, options.candidateLimit || 6);

    var best = null;
    var testedEdges = 0;
    var testedPositions = 0;

    for (var ci = 0; ci < candidates.length; ci++) {
      var candidate = candidates[ci];
      var node = graph.nodes[candidate.index];
      var nodeEdges = getNodeEdges(graph, node);
      var incidentBefore = countEdgeCrossings(graph, nodeEdges);

      for (var ni = 0; ni < candidate.neighbors.length; ni++) {
        for (var nj = ni + 1; nj < candidate.neighbors.length; nj++) {
          var neighborA = candidate.neighbors[ni];
          var neighborB = candidate.neighbors[nj];
          if (!adjacency[neighborA][neighborB]) continue;
          testedEdges++;

          var edge = [graph.nodes[neighborA], graph.nodes[neighborB]];
          var vertexSide = sideOfEdge(edge, node);
          var sameSide = 0;
          var oppositeSide = 0;
          for (var otherIndex = 0; otherIndex < candidate.neighbors.length; otherIndex++) {
            var otherNeighbor = candidate.neighbors[otherIndex];
            if (otherNeighbor === neighborA || otherNeighbor === neighborB) continue;
            var otherSide = sideOfEdge(edge, graph.nodes[otherNeighbor]);
            if (Math.abs(vertexSide) < 1e-8 || Math.abs(otherSide) < 1e-8) continue;
            if (vertexSide * otherSide > 0) sameSide++;
            else oppositeSide++;
          }
          // Degree-2 vertices have only one possible neighbor edge. For higher
          // degree vertices, require evidence that the vertex is the outlier.
          if (candidate.degree > 2 && oppositeSide <= sameSide) continue;

          var edgeLength = Math.sqrt(
            Math.pow(edge[1][0] - edge[0][0], 2) +
            Math.pow(edge[1][1] - edge[0][1], 2));
          var offsets = [
            Math.max(0.012, Math.min(0.04, edgeLength * 0.08)),
            Math.max(0.025, Math.min(0.08, edgeLength * 0.16))
          ];

          for (var oi = 0; oi < offsets.length; oi++) {
            var target = reflectPointAcrossEdge(node, edge, offsets[oi]);
            if (!target || isTooClose(graph, node, target[0], target[1]) ||
                wouldOscillate(state, candidate.index, target[0], target[1])) {
              continue;
            }
            testedPositions++;

            var oldX = node[0], oldY = node[1];
            node[0] = target[0];
            node[1] = target[1];
            var incidentAfter = countEdgeCrossings(graph, nodeEdges);
            node[0] = oldX;
            node[1] = oldY;
            var improvement = incidentBefore - incidentAfter;

            if (improvement > 0 && (!best || improvement > best.improvement)) {
              best = {
                node: node,
                nodeIndex: candidate.index,
                fromX: oldX,
                fromY: oldY,
                toX: target[0],
                toY: target[1],
                improvement: improvement,
                strategy: 'stage1b-neighbor-edge-flip',
                search: {
                  crossingCount: count,
                  candidateVertices: candidates.map(function(item) { return item.index; }),
                  testedEdges: testedEdges,
                  testedPositions: testedPositions,
                  neighborEdge: [neighborA, neighborB],
                  degree: candidate.degree,
                  incidentCrossingsBefore: incidentBefore,
                  incidentCrossingsAfter: incidentAfter,
                  bestImprovement: improvement
                }
              };
            }
          }
        }
      }

      // If three neighbors form a triangle, test placing the sore-thumb
      // vertex inside that local enclosure. This can cross multiple boundary
      // edges at once and matches the common visual "belongs in here" move.
      for (var ta = 0; ta < candidate.neighbors.length; ta++) {
        for (var tb = ta + 1; tb < candidate.neighbors.length; tb++) {
          for (var tc = tb + 1; tc < candidate.neighbors.length; tc++) {
            var triangleA = candidate.neighbors[ta];
            var triangleB = candidate.neighbors[tb];
            var triangleC = candidate.neighbors[tc];
            if (!adjacency[triangleA][triangleB] ||
                !adjacency[triangleA][triangleC] ||
                !adjacency[triangleB][triangleC]) {
              continue;
            }
            var targetX = (graph.nodes[triangleA][0] + graph.nodes[triangleB][0] +
              graph.nodes[triangleC][0]) / 3;
            var targetY = (graph.nodes[triangleA][1] + graph.nodes[triangleB][1] +
              graph.nodes[triangleC][1]) / 3;
            if (pointInTriangle(node, graph.nodes[triangleA], graph.nodes[triangleB],
                graph.nodes[triangleC]) ||
                isTooClose(graph, node, targetX, targetY) ||
                wouldOscillate(state, candidate.index, targetX, targetY)) {
              continue;
            }
            testedPositions++;

            var oldX = node[0], oldY = node[1];
            node[0] = targetX;
            node[1] = targetY;
            var incidentAfter = countEdgeCrossings(graph, nodeEdges);
            node[0] = oldX;
            node[1] = oldY;
            var improvement = incidentBefore - incidentAfter;

            if (improvement > 0 && (!best || improvement > best.improvement)) {
              best = {
                node: node,
                nodeIndex: candidate.index,
                fromX: oldX,
                fromY: oldY,
                toX: targetX,
                toY: targetY,
                improvement: improvement,
                strategy: 'stage1b-neighbor-enclosure',
                search: {
                  crossingCount: count,
                  candidateVertices: candidates.map(function(item) { return item.index; }),
                  testedEdges: testedEdges,
                  testedPositions: testedPositions,
                  neighborTriangle: [triangleA, triangleB, triangleC],
                  degree: candidate.degree,
                  incidentCrossingsBefore: incidentBefore,
                  incidentCrossingsAfter: incidentAfter,
                  bestImprovement: improvement
                }
              };
            }
          }
        }
      }
    }

    intersections(graph.links);
    state.lastSideFlipAttempt = {
      crossingCount: count,
      candidateVertices: candidates.map(function(item) { return item.index; }),
      testedEdges: testedEdges,
      testedPositions: testedPositions,
      bestImprovement: best ? best.improvement : 0,
      exhausted: !best
    };
    if (best) best.search.finalAttempt = state.lastSideFlipAttempt;
    return best;
  }

  // Apply one strictly crossing-reducing geometric move.
  // This intentionally excludes structural, escape, clump, and zero-gain moves.
  function minimizeStep(graph, state) {
    state = state || {};
    var count = intersections(graph.links);
    if (count === 0) return { done: true, count: 0 };
    recordCrossingHistory(state, count);

    var best = findAdaptiveMinimizeMove(graph, state);
    if (!best) {
      return { done: false, improved: false, move: null, count: count };
    }

    best.node[0] = best.toX;
    best.node[1] = best.toY;
    recordMove(state, best.nodeIndex, best.toX, best.toY);
    var newCount = intersections(graph.links);
    recordCrossingHistory(state, newCount);
    return { done: false, improved: true, move: best, count: newCount };
  }
  
  // solverStep(graph, state): Execute one solver iteration
  // 
  // FALLBACK CHAIN:
  //   1. Try focused adaptive crossing minimization
  //   2. Try findAnchoredCentroidMove (gentle repositioning)
  //   3. Try Stage 2 / escape behavior
  //   4. Give up if stuck too long
  //
  // RETURNS: { done, improved, move, count, stuck?, wouldEscape? }
  //
  function solverStep(graph, state) {
    state = state || {};
    state.totalMoves = (state.totalMoves || 0) + 1;
    var count = intersections(graph.links);
    recordCrossingHistory(state, count);
    
    if (count === 0) {
      return { done: true, count: 0 };
    }
    
    var best = null;
    
    best = findAdaptiveMinimizeMove(graph, state);
    
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

    // Stage 1b: after ordinary geometric descent is genuinely exhausted, try
    // a few strictly reducing topological side flips, then return to Stage 1.
    best = findReducingSideFlipMove(graph, state);
    if (best) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      recordMove(state, best.nodeIndex, best.toX, best.toY);
      state.sideFlipVertices[best.nodeIndex] = true;
      state.sideFlipMoves = (state.sideFlipMoves || 0) + 1;
      var newCount = intersections(graph.links);
      state.stuckCount = 0;
      state.recentAttempts = {};
      return { done: false, improved: true, move: best, count: newCount };
    }
    
    // Stage 1 is stuck - increment counter
    state.stuckCount = (state.stuckCount || 0) + 1;
    state.recentAttempts = state.recentAttempts || {};
    
    // If pauseBeforeEscape is set, signal that Stage 1 is stuck (before trying Stage 2)
    // This lets interactive mode intervene at the Stage 1 stuck point
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
  
  // ===========================================================================
  // SECTION: CLUMP-BASED STRATEGIES
  // Find and grow clusters of conflict-free (yellow) vertices.
  // findGrowClumpMove is ACTIVE in solverStep (mid/late game).
  // ===========================================================================
  
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
  
  // ===========================================================================
  // SECTION: INTERACTIVE/UI STRATEGIES
  // Simple strategies available as buttons in the UI.
  // findLocalMove and findAnchoredCentroidMove are also used in solverStep.
  // findUncrossMove, findWiggleMove are UI-only.
  // ===========================================================================
  
  // centroid(nodes): Simple average position of a set of nodes
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
  exports.findBestMoveFast = findBestMoveFast;
  exports.findBottleneckMoveFast = findBottleneckMoveFast;
  exports.findGridMove = findGridMove;
  exports.findEscapeMove = findEscapeMove;
  exports.findGrowClumpMove = findGrowClumpMove;
  exports.findClumps = findClumps;
  exports.analyzeGraphState = analyzeGraphState;
  exports.findSeparatingTriangles = findSeparatingTriangles;
  exports.suggestStage2Move = suggestStage2Move;
  exports.suggestStage2Restart = suggestStage2Restart;
  exports.applyStage2Suggestion = applyStage2Suggestion;
  exports.findAdaptiveMinimizeMove = findAdaptiveMinimizeMove;
  exports.findReducingSideFlipMove = findReducingSideFlipMove;
  exports.minimizeStep = minimizeStep;
  exports.solverStep = solverStep;
  exports.solvePuzzle = solvePuzzle;
  exports.evaluateMoveDelta = evaluateMoveDelta;
  exports.getNodeEdges = getNodeEdges;
  exports.findCentroidMove = findCentroidMove;
  exports.findAnchoredCentroidMove = findAnchoredCentroidMove;
  exports.findFinisherMove = findFinisherMove;
  exports.findCompactMove = findCompactMove;
  exports.findRelocateMove = findRelocateMove;
  exports.findConsolidateMove = findConsolidateMove;
  exports.createConsolidationState = createConsolidationState;
  exports.findDirectionalConsolidateMove = findDirectionalConsolidateMove;
  exports.applyDirectionalConsolidateMove = applyDirectionalConsolidateMove;
  exports.findLocalMove = findLocalMove;
  exports.findUncrossMove = findUncrossMove;
  exports.findWiggleMove = findWiggleMove;
  exports.centroid = centroid;
  exports.weightedCentroid = weightedCentroid;
  exports.anchorScore = anchorScore;
  exports.findBarrierMove = findBarrierMove;
  
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Solver = {}));
