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

  var deterministicClock = {
    enabled: false,
    tick: 0,
    stepMs: 1
  };

  function now() {
    if (!deterministicClock.enabled) return Date.now();
    deterministicClock.tick += deterministicClock.stepMs;
    return deterministicClock.tick;
  }

  function setDeterministicClock(enabled, options) {
    options = options || {};
    deterministicClock.enabled = Boolean(enabled);
    deterministicClock.tick = options.startMs || 0;
    deterministicClock.stepMs = options.stepMs || 1;
  }

  function getClockState() {
    return {
      deterministic: deterministicClock.enabled,
      tick: deterministicClock.tick,
      stepMs: deterministicClock.stepMs
    };
  }

  var profiler = {
    enabled: false,
    stack: [],
    data: null
  };

  function profileNow() {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  function emptyProfileData() {
    return {
      startedAt: new Date().toISOString(),
      intersections: {
        calls: 0,
        elapsedMs: 0,
        pairTests: 0,
        maxEdges: 0
      },
      edgeCrossings: {
        calls: 0,
        elapsedMs: 0,
        pairTests: 0,
        maxEdges: 0
      },
      evaluateMoveDelta: {
        calls: 0,
        elapsedMs: 0
      },
      sections: {}
    };
  }

  function resetProfiler() {
    profiler.data = emptyProfileData();
  }

  function setProfilerEnabled(enabled) {
    profiler.enabled = Boolean(enabled);
    if (profiler.enabled && !profiler.data) resetProfiler();
  }

  function currentProfileSection() {
    return profiler.stack.length ?
      profiler.stack[profiler.stack.length - 1] : 'unattributed';
  }

  function ensureProfileSection(name) {
    var sections = profiler.data.sections;
    if (!sections[name]) {
      sections[name] = {
        calls: 0,
        elapsedMs: 0,
        intersections: {
          calls: 0,
          elapsedMs: 0,
          pairTests: 0
        },
        edgeCrossings: {
          calls: 0,
          elapsedMs: 0,
          pairTests: 0
        },
        evaluateMoveDelta: {
          calls: 0,
          elapsedMs: 0
        }
      };
    }
    return sections[name];
  }

  function profileSection(name, fn) {
    if (!profiler.enabled) return fn();
    if (!profiler.data) resetProfiler();
    profiler.stack.push(name);
    var started = profileNow();
    try {
      return fn();
    } finally {
      profiler.stack.pop();
      var elapsed = profileNow() - started;
      var section = ensureProfileSection(name);
      section.calls++;
      section.elapsedMs += elapsed;
    }
  }

  function addProfileCost(kind, elapsedMs, pairTests, edgeCount) {
    if (!profiler.enabled) return;
    if (!profiler.data) resetProfiler();
    var summary = profiler.data[kind];
    summary.calls++;
    summary.elapsedMs += elapsedMs;
    if (pairTests) summary.pairTests += pairTests;
    if (edgeCount && edgeCount > summary.maxEdges) summary.maxEdges = edgeCount;

    var section = ensureProfileSection(currentProfileSection())[kind];
    section.calls++;
    section.elapsedMs += elapsedMs;
    if (pairTests) section.pairTests += pairTests;
  }

  function getProfilerReport() {
    if (!profiler.data) resetProfiler();
    return JSON.parse(JSON.stringify(profiler.data));
  }
  
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
    var ax = a[0][0], ay = a[0][1];
    var rx = a[1][0] - ax, ry = a[1][1] - ay;
    var bx = b[0][0], by = b[0][1];
    var sx = b[1][0] - bx, sy = b[1][1] - by;
    var rxs = rx * sy - ry * sx;
    var qpx = bx - ax, qpy = by - ay;
    var t = (qpx * sy - qpy * sx) / rxs;
    var u = (qpx * ry - qpy * rx) / rxs;
    var epsilon = 1e-6;
    return t > epsilon && t < 1 - epsilon && u > epsilon && u < 1 - epsilon;
  }

  function shareEndpoint(a, b) {
    return a[0] === b[0] || a[0] === b[1] ||
      a[1] === b[0] || a[1] === b[1];
  }

  function nodeIndexOf(graph, node) {
    return graph.nodes.indexOf(node);
  }
  
  // intersections(links): Count all edge crossings and mark involved elements
  // SIDE EFFECTS: Sets .intersection = true/false on each link and its endpoints
  // Returns: Total crossing count (the number we're trying to get to zero)
  // Complexity: O(E²) where E = number of edges
  function intersections(links) {
    var profileActive = profiler.enabled;
    var profileStarted = profileActive ? profileNow() : 0;
    var pairTests = 0;
    var n = links.length, count = 0;
    for (var i = 0; i < n; i++) {
      links[i].intersection = false;
      links[i][0].intersection = false;
      links[i][1].intersection = false;
    }
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (shareEndpoint(links[i], links[j])) continue;
        if (profileActive) pairTests++;
        if (intersect(links[i], links[j])) {
          links[i].intersection = links[i][0].intersection = links[i][1].intersection = true;
          links[j].intersection = links[j][0].intersection = links[j][1].intersection = true;
          count++;
        }
      }
    }
    if (profileActive) {
      addProfileCost('intersections', profileNow() - profileStarted,
        pairTests, n);
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
    if (graph._nodeEdgeCache &&
        graph._nodeEdgeCache.nodeCount === graph.nodes.length &&
        graph._nodeEdgeCache.linkCount === graph.links.length) {
      return graph._nodeEdgeCache.edges[graph.nodes.indexOf(node)] || [];
    }

    var cachedEdges = graph.nodes.map(function() { return []; });
    for (var i = 0; i < graph.links.length; i++) {
      var link = graph.links[i];
      var a = graph.nodes.indexOf(link[0]);
      var b = graph.nodes.indexOf(link[1]);
      if (a >= 0) cachedEdges[a].push(link);
      if (b >= 0 && b !== a) cachedEdges[b].push(link);
    }

    graph._nodeEdgeCache = {
      nodeCount: graph.nodes.length,
      linkCount: graph.links.length,
      edges: cachedEdges
    };
    return cachedEdges[graph.nodes.indexOf(node)] || [];
  }
  
  // Count crossings involving a set of edges (against all other edges)
  function countEdgeCrossings(graph, edges) {
    var profileActive = profiler.enabled;
    var profileStarted = profileActive ? profileNow() : 0;
    var pairTests = 0;
    var crossingCount = 0;
    var edgeSet = new Set(edges);
    
    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      for (var j = 0; j < graph.links.length; j++) {
        var other = graph.links[j];
        if (edgeSet.has(other)) continue; // Don't double-count edges in our set
        if (shareEndpoint(edge, other)) continue;
        if (profileActive) pairTests++;
        if (intersect(edge, other)) {
          crossingCount++;
        }
      }
    }
    
    // Also count crossings between edges in the set
    for (var i = 0; i < edges.length; i++) {
      for (var j = i + 1; j < edges.length; j++) {
        if (shareEndpoint(edges[i], edges[j])) continue;
        if (profileActive) pairTests++;
        if (intersect(edges[i], edges[j])) {
          crossingCount++;
        }
      }
    }
    
    if (profileActive) {
      addProfileCost('edgeCrossings', profileNow() - profileStarted,
        pairTests, graph.links.length);
    }
    return crossingCount;
  }
  
  // Evaluate a node move incrementally - returns crossing delta (negative = improvement)
  // Much faster than full intersections() call: O(degree × E) vs O(E²)
  function evaluateMoveDelta(graph, node, newX, newY, baseCount) {
    var profileActive = profiler.enabled;
    var profileStarted = profileActive ? profileNow() : 0;
    var edges = getNodeEdges(graph, node);
    if (edges.length === 0) {
      if (profileActive) {
        addProfileCost('evaluateMoveDelta', profileNow() - profileStarted);
      }
      return 0;
    }
    
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
    
    if (profileActive) {
      addProfileCost('evaluateMoveDelta', profileNow() - profileStarted);
    }
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
      var i = nodeIndexOf(graph, node);
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

  function median(values) {
    if (values.length === 0) return 0;
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    var middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] :
      (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // Quantify a clean graph-connected region using graph-relative geometry.
  // Good regions are large, internally dense, visible, and geometrically
  // regular without requiring a large pixel footprint.
  function analyzeEstablishedRegion(graph, region) {
    var regionSet = {};
    region.forEach(function(index) { regionSet[index] = true; });
    var internalEdges = [];
    var boundaryEdges = [];
    var idx = new Map();
    for (var ni = 0; ni < graph.nodes.length; ni++) idx.set(graph.nodes[ni], ni);
    var adjSet = {};   // region-internal adjacency (deduped) for triangle finding

    graph.links.forEach(function(link) {
      var a = idx.get(link[0]);
      var b = idx.get(link[1]);
      if (regionSet[a] && regionSet[b]) {
        internalEdges.push([a, b]);
        (adjSet[a] || (adjSet[a] = new Set())).add(b);
        (adjSet[b] || (adjSet[b] = new Set())).add(a);
      } else if (regionSet[a] || regionSet[b]) {
        boundaryEdges.push([a, b]);
      }
    });

    var edgeLengths = internalEdges.map(function(edge) {
      var a = graph.nodes[edge[0]], b = graph.nodes[edge[1]];
      return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2));
    });
    var medianEdgeLength = median(edgeLengths);
    var meanEdgeLength = edgeLengths.length > 0
      ? edgeLengths.reduce(function(sum, value) { return sum + value; }, 0) /
        edgeLengths.length : 0;
    var edgeVariance = edgeLengths.length > 0
      ? edgeLengths.reduce(function(sum, value) {
        return sum + Math.pow(value - meanEdgeLength, 2);
      }, 0) / edgeLengths.length : 0;
    var edgeLengthCV = meanEdgeLength > 1e-8
      ? Math.sqrt(edgeVariance) / meanEdgeLength : 0;

    var nearestDistances = region.map(function(index) {
      var node = graph.nodes[index];
      var nearest = Infinity;
      region.forEach(function(otherIndex) {
        if (otherIndex === index) return;
        var other = graph.nodes[otherIndex];
        nearest = Math.min(nearest,
          Math.sqrt(Math.pow(node[0] - other[0], 2) + Math.pow(node[1] - other[1], 2)));
      });
      return nearest === Infinity ? 0 : nearest;
    });
    var medianNearestSpacing = median(nearestDistances);
    var visibilityRatio = medianEdgeLength > 1e-8
      ? medianNearestSpacing / medianEdgeLength : 0;

    // Triangles = 3-cliques of internal edges. Enumerate via each vertex's
    // region neighbors (common-neighbor test) — O(sum of squared degrees)
    // instead of O(region^3). Counted once through the smallest vertex a<b<c.
    var triangleQualities = [];
    Object.keys(adjSet).forEach(function(aKey) {
      var a = +aKey;
      var neigh = [];
      adjSet[a].forEach(function(x) { if (x > a) neigh.push(x); });
      neigh.sort(function(p, q) { return p - q; });
      var pa = graph.nodes[a];
      for (var i = 0; i < neigh.length; i++) {
        var b = neigh[i], setB = adjSet[b];
        if (!setB) continue;
        var pb = graph.nodes[b];
        for (var j = i + 1; j < neigh.length; j++) {
          var c = neigh[j];
          if (!setB.has(c)) continue;   // need edge (b,c) too
          var pc = graph.nodes[c];
          var ab2 = Math.pow(pa[0] - pb[0], 2) + Math.pow(pa[1] - pb[1], 2);
          var ac2 = Math.pow(pa[0] - pc[0], 2) + Math.pow(pa[1] - pc[1], 2);
          var bc2 = Math.pow(pb[0] - pc[0], 2) + Math.pow(pb[1] - pc[1], 2);
          var denominator = ab2 + ac2 + bc2;
          if (denominator > 1e-10) {
            triangleQualities.push(
              4 * Math.sqrt(3) * (Math.abs(sideOfEdge([pa, pb], pc)) / 2) /
              denominator);
          }
        }
      }
    });

    var dandelions = [];
    region.forEach(function(index) {
      var center = graph.nodes[index];
      var neighbors = getNeighbors(graph, center).filter(function(node) {
        return regionSet[idx.get(node)];
      });
      if (neighbors.length < 7) return;
      var polar = neighbors.map(function(node) {
        var dx = node[0] - center[0], dy = node[1] - center[1];
        return { radius: Math.sqrt(dx * dx + dy * dy), angle: Math.atan2(dy, dx) };
      }).sort(function(a, b) { return a.angle - b.angle; });
      var meanRadius = polar.reduce(function(sum, item) {
        return sum + item.radius;
      }, 0) / polar.length;
      if (meanRadius < 1e-8) return;
      var radiusCV = Math.sqrt(polar.reduce(function(sum, item) {
        return sum + Math.pow(item.radius - meanRadius, 2);
      }, 0) / polar.length) / meanRadius;
      var maxGap = 0;
      for (var i = 0; i < polar.length; i++) {
        var nextAngle = i === polar.length - 1
          ? polar[0].angle + Math.PI * 2 : polar[i + 1].angle;
        maxGap = Math.max(maxGap, nextAngle - polar[i].angle);
      }
      dandelions.push({
        vertex: index,
        degree: neighbors.length,
        quality: Math.max(0, 1 - radiusCV) *
          Math.max(0, 1 - maxGap / (Math.PI * 2))
      });
    });

    var triangleQuality = triangleQualities.length > 0 ? median(triangleQualities) : 0;
    var dandelionQuality = dandelions.length > 0
      ? median(dandelions.map(function(item) { return item.quality; })) : null;
    var density = region.length > 2
      ? internalEdges.length / Math.max(1, 3 * region.length - 6) : 0;
    var establishedScore = region.length + density * 2 + triangleQuality * 2 +
      Math.min(1, visibilityRatio) - edgeLengthCV -
      boundaryEdges.length / Math.max(1, region.length) * 0.25 +
      (dandelionQuality === null ? 0 : dandelionQuality);

    return {
      vertices: region,
      vertexCount: region.length,
      internalEdges: internalEdges.length,
      boundaryEdges: boundaryEdges.length,
      density: density,
      medianEdgeLength: medianEdgeLength,
      edgeLengthCV: edgeLengthCV,
      medianNearestSpacing: medianNearestSpacing,
      visibilityRatio: visibilityRatio,
      triangleCount: triangleQualities.length,
      triangleQuality: triangleQuality,
      dandelionCount: dandelions.length,
      dandelionQuality: dandelionQuality,
      dandelions: dandelions,
      score: establishedScore
    };
  }

  // Partition current crossings into locally related unresolved regions.
  // Crossing events belong together when they share a vertex or when their
  // endpoint sets touch through an abstract graph edge.
  function analyzeConflictRegions(graph) {
    var crossings = [];
    var adjacency = graph.nodes.map(function() { return {}; });
    graph.links.forEach(function(link) {
      var a = graph.nodes.indexOf(link[0]);
      var b = graph.nodes.indexOf(link[1]);
      if (a === b) return;
      adjacency[a][b] = true;
      adjacency[b][a] = true;
    });

    for (var i = 0; i < graph.links.length; i++) {
      for (var j = i + 1; j < graph.links.length; j++) {
        if (!intersect(graph.links[i], graph.links[j])) continue;
        crossings.push({
          edges: [i, j],
          vertices: [
            graph.nodes.indexOf(graph.links[i][0]),
            graph.nodes.indexOf(graph.links[i][1]),
            graph.nodes.indexOf(graph.links[j][0]),
            graph.nodes.indexOf(graph.links[j][1])
          ].filter(function(index, position, all) {
            return all.indexOf(index) === position;
          }),
          center: [
            (graph.links[i][0][0] + graph.links[i][1][0] +
              graph.links[j][0][0] + graph.links[j][1][0]) / 4,
            (graph.links[i][0][1] + graph.links[i][1][1] +
              graph.links[j][0][1] + graph.links[j][1][1]) / 4
          ]
        });
      }
    }

    if (crossings.length > 250) {
      var coarseVertices = {};
      var coarseEdges = {};
      crossings.forEach(function(crossing) {
        crossing.vertices.forEach(function(index) { coarseVertices[index] = true; });
        crossing.edges.forEach(function(index) { coarseEdges[index] = true; });
      });
      return [{
        coarse: true,
        vertices: Object.keys(coarseVertices).map(Number),
        vertexCount: Object.keys(coarseVertices).length,
        crossingEdges: Object.keys(coarseEdges).map(Number),
        crossingCount: crossings.length,
        boundaryVertices: [],
        boundaryVertexCount: 0,
        bounds: null
      }];
    }

    var parent = crossings.map(function(_, index) { return index; });
    function root(index) {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    }
    function union(a, b) {
      var rootA = root(a), rootB = root(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    }
    function related(a, b) {
      var graphAdjacent = false;
      for (var ai = 0; ai < a.vertices.length; ai++) {
        for (var bi = 0; bi < b.vertices.length; bi++) {
          if (a.vertices[ai] === b.vertices[bi]) return true;
          if (adjacency[a.vertices[ai]][b.vertices[bi]]) graphAdjacent = true;
        }
      }
      if (!graphAdjacent) return false;
      var dx = a.center[0] - b.center[0];
      var dy = a.center[1] - b.center[1];
      return dx * dx + dy * dy < 0.12 * 0.12;
    }

    for (var ci = 0; ci < crossings.length; ci++) {
      for (var cj = ci + 1; cj < crossings.length; cj++) {
        if (related(crossings[ci], crossings[cj])) union(ci, cj);
      }
    }

    var grouped = {};
    crossings.forEach(function(crossing, index) {
      var key = root(index);
      grouped[key] = grouped[key] || [];
      grouped[key].push(crossing);
    });

    return Object.keys(grouped).map(function(key) {
      var events = grouped[key];
      var vertexSet = {};
      var edgeSet = {};
      events.forEach(function(event) {
        event.vertices.forEach(function(index) { vertexSet[index] = true; });
        event.edges.forEach(function(index) { edgeSet[index] = true; });
      });
      var vertices = Object.keys(vertexSet).map(Number);
      var boundarySet = {};
      vertices.forEach(function(index) {
        Object.keys(adjacency[index]).map(Number).forEach(function(neighbor) {
          if (!vertexSet[neighbor]) boundarySet[neighbor] = true;
        });
      });
      var xs = vertices.map(function(index) { return graph.nodes[index][0]; });
      var ys = vertices.map(function(index) { return graph.nodes[index][1]; });
      return {
        vertices: vertices,
        vertexCount: vertices.length,
        crossingEdges: Object.keys(edgeSet).map(Number),
        crossingCount: events.length,
        boundaryVertices: Object.keys(boundarySet).map(Number),
        boundaryVertexCount: Object.keys(boundarySet).length,
        bounds: vertices.length > 0 ? {
          minX: Math.min.apply(null, xs),
          maxX: Math.max.apply(null, xs),
          minY: Math.min.apply(null, ys),
          maxY: Math.max.apply(null, ys)
        } : null
      };
    }).sort(function(a, b) {
      return b.crossingCount - a.crossingCount ||
        b.vertexCount - a.vertexCount;
    });
  }

  // Generate a small diagnostic set of coherent directional plans. Vertices
  // are grouped only within one conflict region and only when their cheap
  // outward directions agree. These plans do not execute automatically.
  function suggestDirectionalPlans(graph, conflictRegions, establishedRegion) {
    var crossingCounts = getCrossingCounts(graph);
    var protectedSet = {};
    if (establishedRegion) {
      establishedRegion.vertices.forEach(function(index) {
        protectedSet[index] = true;
      });
    }
    var plans = [];

    conflictRegions.slice(0, 5).forEach(function(region, regionIndex) {
      if (region.coarse || !region.bounds || region.vertexCount < 2) return;
      var center = [
        (region.bounds.minX + region.bounds.maxX) / 2,
        (region.bounds.minY + region.bounds.maxY) / 2
      ];
      var bins = {};

      region.vertices.forEach(function(index) {
        var node = graph.nodes[index];
        var neighbors = getNeighbors(graph, node);
        if (neighbors.length === 0) return;
        var anchorCenter = [0, 0], anchorWeight = 0;
        neighbors.forEach(function(neighbor) {
          var weight = neighbor.intersection ? 0.25 : 1;
          anchorCenter[0] += neighbor[0] * weight;
          anchorCenter[1] += neighbor[1] * weight;
          anchorWeight += weight;
        });
        anchorCenter[0] /= anchorWeight;
        anchorCenter[1] /= anchorWeight;
        var dx = node[0] - anchorCenter[0];
        var dy = node[1] - anchorCenter[1];
        var length = Math.sqrt(dx * dx + dy * dy);
        if (length < 0.02) {
          dx = node[0] - center[0];
          dy = node[1] - center[1];
          length = Math.sqrt(dx * dx + dy * dy);
        }
        if (length < 1e-8) return;
        dx /= length;
        dy /= length;
        var bin = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
        if (bin < 0) bin += 8;
        bins[bin] = bins[bin] || [];
        bins[bin].push({
          vertex: index,
          direction: [dx, dy],
          anchor: anchorScore(graph, node),
          crossings: crossingCounts[index]
        });
      });

      Object.keys(bins).forEach(function(bin) {
        var members = bins[bin];
        if (members.length < 2) return;
        members.sort(function(a, b) {
          return b.crossings - a.crossings || a.anchor - b.anchor;
        });
        members = members.slice(0, 8);
        var direction = members.reduce(function(sum, member) {
          sum[0] += member.direction[0];
          sum[1] += member.direction[1];
          return sum;
        }, [0, 0]);
        var directionLength = Math.sqrt(
          direction[0] * direction[0] + direction[1] * direction[1]);
        if (directionLength < 1e-8) return;
        direction[0] /= directionLength;
        direction[1] /= directionLength;
        var avgAnchor = members.reduce(function(sum, member) {
          return sum + member.anchor;
        }, 0) / members.length;
        var crossingIncidence = members.reduce(function(sum, member) {
          return sum + member.crossings;
        }, 0);
        var width = region.bounds.maxX - region.bounds.minX;
        var height = region.bounds.maxY - region.bounds.minY;
        var congestion = region.vertexCount /
          Math.max(0.02, width * height * graph.nodes.length);
        plans.push({
          type: congestion > 2 ? 'directional-dilation' : 'directional-group',
          conflictRegion: regionIndex,
          vertices: members.map(function(member) { return member.vertex; }),
          protectedVertices: Object.keys(protectedSet).map(Number).filter(function(index) {
            return members.every(function(member) { return member.vertex !== index; });
          }),
          direction: direction,
          averageAnchor: avgAnchor,
          crossingIncidence: crossingIncidence,
          congestion: congestion,
          score: crossingIncidence + members.length * 2 - avgAnchor * members.length
        });
      });
    });

    return plans.sort(function(a, b) { return b.score - a.score; }).slice(0, 5);
  }

  function regionExtensionMetrics(analysis) {
    var conflictVertices = analysis.conflictRegions.length > 0
      ? analysis.conflictRegions[0].vertexCount : 0;
    return {
      crossings: analysis.crossings,
      cleanVertices: analysis.cleanVertices,
      largestCleanRegion: analysis.largestCleanRegion,
      conflictVertices: conflictVertices,
      establishedScore: bestEstablishedScore(analysis)
    };
  }

  function regionExtensionDelta(before, after) {
    return {
      crossings: before.crossings - after.crossings,
      cleanVertices: after.cleanVertices - before.cleanVertices,
      largestCleanRegion: after.largestCleanRegion - before.largestCleanRegion,
      conflictVertices: before.conflictVertices - after.conflictVertices,
      establishedScore: after.establishedScore - before.establishedScore
    };
  }

  // Cheap early/middle-game organization of an already clean region. This
  // moves one lightly anchored internal vertex toward its internal neighbors,
  // while preserving crossings and enough local spacing to remain visible.
  function suggestRegionReorganizationMove(graph, options) {
    options = options || {};
    var baseCrossings = intersections(graph.links);
    if (baseCrossings === 0) return null;

    var analysis = analyzeGraphState(graph, {});
    var region = analysis.bestEstablishedRegion;
    if (!region || region.vertexCount < (options.minRegionSize || 5)) return null;

    var regionSet = {};
    region.vertices.forEach(function(index) { regionSet[index] = true; });
    var dandelionSet = {};
    region.dandelions.forEach(function(item) { dandelionSet[item.vertex] = true; });
    var candidates = [];

    region.vertices.forEach(function(index) {
      if (dandelionSet[index]) return;
      var node = graph.nodes[index];
      var neighbors = getNeighbors(graph, node);
      var internal = neighbors.filter(function(neighbor) {
        return regionSet[graph.nodes.indexOf(neighbor)];
      });
      var boundaryCount = neighbors.length - internal.length;
      if (internal.length < 2 || boundaryCount > 1 || neighbors.length > 6) return;

      var cx = 0, cy = 0;
      internal.forEach(function(neighbor) {
        cx += neighbor[0];
        cy += neighbor[1];
      });
      cx /= internal.length;
      cy /= internal.length;
      var dx = cx - node[0], dy = cy - node[1];
      var displacement = Math.sqrt(dx * dx + dy * dy);
      if (displacement < Math.max(0.025, region.medianEdgeLength * 0.2)) return;
      candidates.push({
        index: index,
        node: node,
        internal: internal,
        boundaryCount: boundaryCount,
        target: [cx, cy],
        displacement: displacement
      });
    });

    candidates.sort(function(a, b) {
      return a.boundaryCount - b.boundaryCount ||
        b.displacement - a.displacement;
    });
    candidates = candidates.slice(0, options.candidateLimit || 5);

    var fractions = options.fractions || [0.25, 0.4];
    var minSpacing = Math.max(
      options.minimumSpacing || 0.014,
      Math.min(0.025, region.medianNearestSpacing * 0.65));
    var best = null;

    candidates.forEach(function(candidate) {
      var node = candidate.node;
      var fromX = node[0], fromY = node[1];
      var oldLength = candidate.internal.reduce(function(sum, neighbor) {
        var dx = neighbor[0] - fromX, dy = neighbor[1] - fromY;
        return sum + Math.sqrt(dx * dx + dy * dy);
      }, 0);

      fractions.forEach(function(fraction) {
        var toX = fromX + (candidate.target[0] - fromX) * fraction;
        var toY = fromY + (candidate.target[1] - fromY) * fraction;
        var nearest = Infinity;
        for (var i = 0; i < graph.nodes.length; i++) {
          if (i === candidate.index) continue;
          var otherDx = graph.nodes[i][0] - toX;
          var otherDy = graph.nodes[i][1] - toY;
          nearest = Math.min(nearest,
            Math.sqrt(otherDx * otherDx + otherDy * otherDy));
        }
        if (nearest < minSpacing) return;

        node[0] = toX;
        node[1] = toY;
        var newCrossings = intersections(graph.links);
        var newLength = candidate.internal.reduce(function(sum, neighbor) {
          var dx = neighbor[0] - toX, dy = neighbor[1] - toY;
          return sum + Math.sqrt(dx * dx + dy * dy);
        }, 0);
        node[0] = fromX;
        node[1] = fromY;
        if (newCrossings !== baseCrossings) return;

        var lengthReduction = oldLength - newLength;
        if (lengthReduction < 0.008) return;
        var score = lengthReduction * 100 + nearest * 2 -
          candidate.boundaryCount * 0.5;
        if (!best || score > best.score) {
          best = {
            node: node,
            nodeIndex: candidate.index,
            fromX: fromX,
            fromY: fromY,
            toX: toX,
            toY: toY,
            improvement: 0,
            strategy: 'early-region-reorganization',
            score: score,
            lengthReduction: lengthReduction,
            nearestSpacing: nearest,
            regionSize: region.vertexCount,
            boundaryAnchors: candidate.boundaryCount
          };
        }
      });
    });

    intersections(graph.links);
    return best;
  }

  function regionBounds(graph, vertices) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    vertices.forEach(function(index) {
      var node = graph.nodes[index];
      minX = Math.min(minX, node[0]);
      minY = Math.min(minY, node[1]);
      maxX = Math.max(maxX, node[0]);
      maxY = Math.max(maxY, node[1]);
    });
    return {
      minX: minX,
      minY: minY,
      maxX: maxX,
      maxY: maxY,
      width: maxX - minX,
      height: maxY - minY,
      area: Math.max(1e-8, (maxX - minX) * (maxY - minY)),
      center: [(minX + maxX) / 2, (minY + maxY) / 2]
    };
  }

  function internalRegionCrossings(graph, vertices) {
    var set = {};
    vertices.forEach(function(index) { set[index] = true; });
    var links = graph.links.filter(function(link) {
      return set[graph.nodes.indexOf(link[0])] &&
        set[graph.nodes.indexOf(link[1])];
    });
    return intersections(links);
  }

  function regionCrossingProfile(graph, vertices) {
    var set = {};
    vertices.forEach(function(index) { set[index] = true; });
    var profile = {
      protectedCrossings: 0,
      boundaryCrossings: 0,
      externalCrossings: 0
    };
    for (var a = 0; a < graph.links.length; a++) {
      for (var b = a + 1; b < graph.links.length; b++) {
        if (shareEndpoint(graph.links[a], graph.links[b])) continue;
        if (!intersect(graph.links[a], graph.links[b])) continue;
        var a0 = graph.nodes.indexOf(graph.links[a][0]);
        var a1 = graph.nodes.indexOf(graph.links[a][1]);
        var b0 = graph.nodes.indexOf(graph.links[b][0]);
        var b1 = graph.nodes.indexOf(graph.links[b][1]);
        var aInternal = set[a0] && set[a1];
        var bInternal = set[b0] && set[b1];
        var aTouches = set[a0] || set[a1];
        var bTouches = set[b0] || set[b1];
        if (aInternal || bInternal) profile.protectedCrossings++;
        else if (aTouches || bTouches) profile.boundaryCrossings++;
        else profile.externalCrossings++;
      }
    }
    profile.total = profile.protectedCrossings +
      profile.boundaryCrossings + profile.externalCrossings;
    return profile;
  }

  // Starting from a known internally planar region, greedily absorb connected
  // vertices whose addition preserves the induced region's internal planarity.
  function growInternallyPlanarRegion(graph, seedVertices) {
    var region = seedVertices.slice();
    var set = {};
    region.forEach(function(index) { set[index] = true; });
    var changed = true;
    while (changed) {
      changed = false;
      var candidates = [];
      graph.links.forEach(function(link) {
        var a = graph.nodes.indexOf(link[0]);
        var b = graph.nodes.indexOf(link[1]);
        if (set[a] && !set[b]) candidates.push(b);
        if (set[b] && !set[a]) candidates.push(a);
      });
      candidates = candidates.filter(function(index, position) {
        return candidates.indexOf(index) === position;
      });
      for (var i = 0; i < candidates.length; i++) {
        var proposed = region.concat([candidates[i]]);
        if (internalRegionCrossings(graph, proposed) === 0) {
          region = proposed;
          set[candidates[i]] = true;
          changed = true;
        }
      }
    }
    return region;
  }

  function compactRegionPositions(graph, vertices, center, scale) {
    var bounds = regionBounds(graph, vertices);
    var positions = [];
    for (var i = 0; i < vertices.length; i++) {
      var index = vertices[i];
      var node = graph.nodes[index];
      var x = center[0] + (node[0] - bounds.center[0]) * scale;
      var y = center[1] + (node[1] - bounds.center[1]) * scale;
      if (x < 0.02 || x > 0.98 || y < 0.02 || y > 0.98) return null;
      positions.push({ index: index, x: x, y: y });
    }
    return positions;
  }

  // Exact affine targets can place an internal edge directly through an
  // exterior edge or vertex. Nudge targets locally while preserving internal
  // planarity, analogous to a player restoring recognizable local triangles.
  function relaxCompactRegionPositions(graph, vertices, positions) {
    var simulation = cloneGraph(graph);
    applyGroupPositions(simulation, positions);
    var targetByVertex = {};
    positions.forEach(function(position) {
      targetByVertex[position.index] = {
        index: position.index,
        x: position.x,
        y: position.y
      };
    });
    var offsets = [[0, 0]];
    [0.015, 0.03, 0.05].forEach(function(radius) {
      for (var direction = 0; direction < 8; direction++) {
        var angle = direction * Math.PI / 4;
        offsets.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
      }
    });

    for (var pass = 0; pass < 3; pass++) {
      vertices.forEach(function(index) {
        var node = simulation.nodes[index];
        var affine = targetByVertex[index];
        var best = null;
        offsets.forEach(function(offset) {
          var x = affine.x + offset[0], y = affine.y + offset[1];
          if (x < 0.02 || x > 0.98 || y < 0.02 || y > 0.98) return;
          var fromX = node[0], fromY = node[1];
          node[0] = x;
          node[1] = y;
          if (internalRegionCrossings(simulation, vertices) !== 0) {
            node[0] = fromX;
            node[1] = fromY;
            return;
          }
          var profile = regionCrossingProfile(simulation, vertices);
          var deviation = Math.sqrt(
            Math.pow(x - affine.x, 2) + Math.pow(y - affine.y, 2));
          var score = profile.protectedCrossings * 100 +
            profile.boundaryCrossings * 4 + profile.total + deviation * 20;
          node[0] = fromX;
          node[1] = fromY;
          if (!best || score < best.score) {
            best = { x: x, y: y, score: score };
          }
        });
        if (best) {
          node[0] = best.x;
          node[1] = best.y;
        }
      });
    }
    return vertices.map(function(index) {
      return {
        index: index,
        x: simulation.nodes[index][0],
        y: simulation.nodes[index][1]
      };
    });
  }

  function regionNeighborMap(graph, vertices) {
    var set = {};
    var neighbors = {};
    vertices.forEach(function(index) {
      set[index] = true;
      neighbors[index] = [];
    });
    graph.links.forEach(function(link) {
      var a = graph.nodes.indexOf(link[0]);
      var b = graph.nodes.indexOf(link[1]);
      if (set[a] && set[b]) {
        neighbors[a].push(b);
        neighbors[b].push(a);
      }
    });
    return neighbors;
  }

  function protectedCrossingVertices(graph, vertices) {
    var set = {};
    var affected = {};
    vertices.forEach(function(index) { set[index] = true; });
    for (var a = 0; a < graph.links.length; a++) {
      for (var b = a + 1; b < graph.links.length; b++) {
        if (shareEndpoint(graph.links[a], graph.links[b])) continue;
        if (!intersect(graph.links[a], graph.links[b])) continue;
        var ends = [
          graph.nodes.indexOf(graph.links[a][0]),
          graph.nodes.indexOf(graph.links[a][1]),
          graph.nodes.indexOf(graph.links[b][0]),
          graph.nodes.indexOf(graph.links[b][1])
        ];
        var aInternal = set[ends[0]] && set[ends[1]];
        var bInternal = set[ends[2]] && set[ends[3]];
        if (!aInternal && !bInternal) continue;
        ends.forEach(function(index) {
          if (set[index]) affected[index] = true;
        });
      }
    }
    return affected;
  }

  // Order moves toward one known compact target. Advance moves prefer vertices
  // supported by already placed neighbors. When the frontier introduces
  // crossings through protected internal edges, repair moves prioritize the
  // remaining vertices incident to that disruption.
  function scheduleRegionCompaction(graph, vertices, positions) {
    var targetByVertex = {};
    positions.forEach(function(position) {
      targetByVertex[position.index] = position;
    });
    var simulation = cloneGraph(graph);
    var neighborMap = regionNeighborMap(simulation, vertices);
    var remaining = {};
    var placed = {};
    vertices.forEach(function(index) { remaining[index] = true; });
    var baseProfile = regionCrossingProfile(simulation, vertices);
    var schedule = [];

    while (Object.keys(remaining).length > 0) {
      var currentProfile = regionCrossingProfile(simulation, vertices);
      var repairVertices = currentProfile.protectedCrossings >
        baseProfile.protectedCrossings
        ? protectedCrossingVertices(simulation, vertices) : {};
      var best = null;

      Object.keys(remaining).forEach(function(key) {
        var index = +key;
        var node = simulation.nodes[index];
        var target = targetByVertex[index];
        var fromX = node[0], fromY = node[1];
        node[0] = target.x;
        node[1] = target.y;
        var profile = regionCrossingProfile(simulation, vertices);
        node[0] = fromX;
        node[1] = fromY;
        var placedNeighbors = neighborMap[index].filter(function(neighbor) {
          return placed[neighbor];
        }).length;
        var remainingNeighbors = neighborMap[index].filter(function(neighbor) {
          return remaining[neighbor] && neighbor !== index;
        }).length;
        var repairPriority = repairVertices[index] ? 1 : 0;
        var score =
          profile.protectedCrossings * 100 +
          profile.boundaryCrossings * 4 +
          profile.total -
          repairPriority * 45 -
          placedNeighbors * 12 -
          remainingNeighbors * 2;
        var candidate = {
          index: index,
          x: target.x,
          y: target.y,
          score: score,
          mode: Object.keys(repairVertices).length > 0 && repairPriority
            ? 'repair' : 'advance',
          placedNeighbors: placedNeighbors,
          protectedCrossings: profile.protectedCrossings,
          boundaryCrossings: profile.boundaryCrossings,
          totalCrossings: profile.total
        };
        if (!best || candidate.score < best.score) best = candidate;
      });

      if (!best) break;
      simulation.nodes[best.index][0] = best.x;
      simulation.nodes[best.index][1] = best.y;
      delete remaining[best.index];
      placed[best.index] = true;
      schedule.push(best);
    }
    return {
      moves: schedule,
      finalProfile: regionCrossingProfile(simulation, vertices),
      finalCrossings: intersections(simulation.links)
    };
  }

  // Suggestion-only region-scale compaction. The final target is a uniformly
  // scaled copy of an internally planar region, so its internal topology is
  // preserved. Temporary full-graph crossings are allowed. Bounded Stage 1
  // rollout estimates whether the cleared space enables region growth.
  function suggestRegionCompactionPlan(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 600;
    var baseAnalysis = analyzeGraphState(graph, {});
    var region = baseAnalysis.bestEstablishedRegion;
    if (!region || region.vertexCount < (options.minRegionSize || 6)) {
      return {
        type: 'region-compaction-search',
        baseCrossings: baseAnalysis.crossings,
        region: region ? region.vertices : [],
        candidatesTested: 0,
        elapsedMs: now() - startedAt,
        timedOut: false,
        best: null,
        candidates: []
      };
    }

    var vertices = region.vertices.slice();
    if (internalRegionCrossings(graph, vertices) !== 0) return null;
    var bounds = regionBounds(graph, vertices);
    var baseProfile = regionCrossingProfile(graph, vertices);
    var baseGrown = growInternallyPlanarRegion(graph, vertices);
    // Manual play repeatedly showed compaction is "translate + tighten",
    // not in-place tighten alone. Cardinal sweep of small translations lets
    // the planner pick a center for the tightened region.
    var directions = options.directions || [
      [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]
    ];
    var scales = options.scales || [0.35, 0.5, 0.65];
    var distances = options.distances || [0.12, 0.2];
    var cleanupLimit = options.cleanupSteps || 12;
    var candidates = [];
    var tested = 0;

    for (var di = 0; di < directions.length &&
        now() - startedAt < timeBudgetMs; di++) {
      var direction = directions[di];
      var directionDistances = di === 0 ? [0] : distances;
      for (var distanceIndex = 0; distanceIndex < directionDistances.length &&
          now() - startedAt < timeBudgetMs; distanceIndex++) {
        var distance = directionDistances[distanceIndex];
        var center = [
          bounds.center[0] + direction[0] * distance,
          bounds.center[1] + direction[1] * distance
        ];
        for (var si = 0; si < scales.length &&
            now() - startedAt < timeBudgetMs; si++) {
          var positions = compactRegionPositions(
            graph, vertices, center, scales[si]);
          if (!positions) continue;
          positions = relaxCompactRegionPositions(graph, vertices, positions);
          var scheduled = scheduleRegionCompaction(graph, vertices, positions);
          var simulation = cloneGraph(graph);
          applyGroupPositions(simulation, positions);
          if (internalRegionCrossings(simulation, vertices) !== 0) continue;

          var setupCrossings = intersections(simulation.links);
          var setupProfile = regionCrossingProfile(simulation, vertices);
          var protectedAllowance = options.protectedCrossingAllowance === undefined
            ? 2 : options.protectedCrossingAllowance;
          if (setupProfile.protectedCrossings >
              baseProfile.protectedCrossings + protectedAllowance) {
            continue;
          }
          var cleanupState = {};
          var cleanupSteps = 0;
          while (cleanupSteps < cleanupLimit &&
              now() - startedAt < timeBudgetMs) {
            var result = minimizeStep(simulation, cleanupState);
            if (!result.move) break;
            cleanupSteps++;
          }
          var finalAnalysis = analyzeGraphState(simulation, {});
          var grown = growInternallyPlanarRegion(simulation, vertices);
          var targetBounds = regionBounds(simulation, vertices);
          var areaReduction = 1 - targetBounds.area / bounds.area;
          var regionGrowth = grown.length - baseGrown.length;
          var crossingRecovery = baseAnalysis.crossings - finalAnalysis.crossings;
          var establishedDelta = bestEstablishedScore(finalAnalysis) -
            bestEstablishedScore(baseAnalysis);
          var score = regionGrowth * 30 + crossingRecovery * 4 +
            establishedDelta * 3 + areaReduction * 12 -
            Math.max(0, setupCrossings - baseAnalysis.crossings) * 0.12 -
            setupProfile.protectedCrossings * 8;
          var accepted = setupProfile.protectedCrossings <=
              baseProfile.protectedCrossings + protectedAllowance &&
            areaReduction >= 0.5;
          tested++;
          candidates.push({
            type: 'region-compaction',
            strategy: 'region-compaction',
            reason: 'compact internally planar region [' + vertices.join(',') +
              '] at scale ' + scales[si].toFixed(2),
            component: vertices,
            positions: positions,
            scheduledMoves: scheduled.moves,
            direction: direction,
            distance: distance,
            scale: scales[si],
            baseCrossings: baseAnalysis.crossings,
            immediateCrossings: setupCrossings,
            immediateDamage: Math.max(0, setupCrossings - baseAnalysis.crossings),
            protectedCrossings: setupProfile.protectedCrossings,
            boundaryCrossings: setupProfile.boundaryCrossings,
            peakScheduledCrossings: scheduled.moves.reduce(function(maximum, move) {
              return Math.max(maximum, move.totalCrossings);
            }, baseAnalysis.crossings),
            finalCrossings: finalAnalysis.crossings,
            downstreamImprovement: baseAnalysis.crossings - finalAnalysis.crossings,
            cleanupSteps: cleanupSteps,
            baseRegionSize: baseGrown.length,
            projectedRegionSize: grown.length,
            regionGrowth: regionGrowth,
            areaReduction: areaReduction,
            establishedDelta: establishedDelta,
            accepted: accepted,
            score: score
          });
        }
      }
    }

    candidates.sort(function(a, b) {
      return b.score - a.score ||
        b.regionGrowth - a.regionGrowth ||
        b.areaReduction - a.areaReduction ||
        a.finalCrossings - b.finalCrossings;
    });
    return {
      type: 'region-compaction-search',
      baseCrossings: baseAnalysis.crossings,
      region: vertices,
      baseRegionSize: baseGrown.length,
      candidatesTested: tested,
      elapsedMs: now() - startedAt,
      timedOut: now() - startedAt >= timeBudgetMs,
      best: candidates.length > 0 && candidates[0].accepted
        ? candidates[0] : null,
      candidates: candidates.slice(0, 5)
    };
  }

  function translateVertices(graph, vertices, direction, distance) {
    var positions = [];
    for (var i = 0; i < vertices.length; i++) {
      var index = vertices[i];
      var node = graph.nodes[index];
      positions.push({
        index: index,
        x: Math.max(0.02, Math.min(0.98, node[0] + direction[0] * distance)),
        y: Math.max(0.02, Math.min(0.98, node[1] + direction[1] * distance))
      });
    }
    return positions;
  }

  // Bounded Stage 2 search for a short coherent translation that grows a
  // solved region or localizes the remaining conflict enough for Stage 1 to
  // resume. Crossing damage is allowed during setup, but the bounded rollout
  // must recover and show clear structural progress before execution.
  function suggestRegionExtensionPlan(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 100;
    var baseAnalysis = analyzeGraphState(graph, {});
    var base = regionExtensionMetrics(baseAnalysis);
    // Manual play repeatedly translated 8-15 vertex coherent groups by
    // 0.15-0.45, accepting damage well above the prior 0.6*base floor of 8.
    var maxGroupSize = options.maxGroupSize || 12;
    var cleanupLimit = options.cleanupSteps || 16;
    var damageLimit = options.damageLimit === undefined
      ? Math.max(15, Math.ceil(base.crossings * 0.8)) : options.damageLimit;
    var plans = baseAnalysis.directionalPlans.slice(0, options.planLimit || 5);
    var distances = options.distances || [0.06, 0.12, 0.2, 0.3, 0.45];
    var candidates = [];
    var tested = 0;

    for (var pi = 0; pi < plans.length &&
        now() - startedAt < timeBudgetMs; pi++) {
      var plan = plans[pi];
      var vertices = plan.vertices.slice(0, maxGroupSize);
      if (vertices.length < 2) continue;

      for (var di = 0; di < distances.length &&
          now() - startedAt < timeBudgetMs; di++) {
        var positions = translateVertices(
          graph, vertices, plan.direction, distances[di]);
        var simulation = cloneGraph(graph);
        applyGroupPositions(simulation, positions);
        var setupAnalysis = analyzeGraphState(simulation, {});
        var setup = regionExtensionMetrics(setupAnalysis);
        var setupDelta = regionExtensionDelta(base, setup);
        var immediateDamage = Math.max(0, setup.crossings - base.crossings);
        tested++;
        if (immediateDamage > damageLimit) continue;

        var cleanupState = {};
        var cleanupSteps = 0;
        while (cleanupSteps < cleanupLimit &&
            now() - startedAt < timeBudgetMs) {
          var result = minimizeStep(simulation, cleanupState);
          if (!result.move) break;
          cleanupSteps++;
        }
        var finalAnalysis = analyzeGraphState(simulation, {});
        var finalMetrics = regionExtensionMetrics(finalAnalysis);
        var finalDelta = regionExtensionDelta(base, finalMetrics);
        var structuralSetup = setupDelta.largestCleanRegion >= 2 ||
          setupDelta.cleanVertices >= 3 ||
          setupDelta.conflictVertices >= 3;
        var productiveHandoff = finalMetrics.crossings < base.crossings &&
          (finalDelta.largestCleanRegion >= 2 ||
            finalDelta.cleanVertices >= 3 ||
            finalDelta.conflictVertices >= 3);
        var score =
          finalDelta.largestCleanRegion * 12 +
          finalDelta.conflictVertices * 9 +
          finalDelta.cleanVertices * 5 +
          finalDelta.establishedScore * 2 +
          finalDelta.crossings * 2 -
          immediateDamage * 0.35 -
          vertices.length * 0.5;

        candidates.push({
          type: 'region-extension',
          strategy: 'stage2-region-extension',
          objective: 'translate compatible-anchor group [' +
            vertices.join(',') + '] to extend/localize solved structure',
          component: vertices,
          positions: positions,
          direction: plan.direction,
          distance: distances[di],
          baseMetrics: base,
          setupMetrics: setup,
          finalMetrics: finalMetrics,
          setupDelta: setupDelta,
          finalDelta: finalDelta,
          immediateDamage: immediateDamage,
          cleanupSteps: cleanupSteps,
          structuralSetup: structuralSetup,
          productiveHandoff: productiveHandoff,
          score: score,
          accepted: productiveHandoff && score >= 50
        });
      }
    }

    candidates.sort(function(a, b) {
      return b.score - a.score ||
        a.immediateDamage - b.immediateDamage ||
        a.component.length - b.component.length;
    });
    return {
      type: 'region-extension-search',
      baseMetrics: base,
      candidatesTested: tested,
      elapsedMs: now() - startedAt,
      timedOut: now() - startedAt >= timeBudgetMs,
      best: candidates.length > 0 && candidates[0].accepted
        ? candidates[0] : null,
      candidates: candidates.slice(0, 5)
    };
  }

  function barrierAnchorCompatibility(graph, component, direction) {
    var componentSet = {};
    component.forEach(function(index) { componentSet[index] = true; });
    var support = 0;
    var conflict = 0;
    var neutral = 0;
    var externalEdges = 0;

    graph.links.forEach(function(link) {
      var a = graph.nodes.indexOf(link[0]);
      var b = graph.nodes.indexOf(link[1]);
      var inside = componentSet[a] ? a : componentSet[b] ? b : -1;
      var outside = inside === a ? b : inside === b ? a : -1;
      if (inside < 0 || outside < 0 || componentSet[outside]) return;

      var dx = graph.nodes[outside][0] - graph.nodes[inside][0];
      var dy = graph.nodes[outside][1] - graph.nodes[inside][1];
      var length = Math.sqrt(dx * dx + dy * dy);
      if (length < 1e-8) return;
      var alignment = (dx * direction[0] + dy * direction[1]) / length;
      var weight = graph.nodes[outside].intersection ? 0.25 : 1;
      externalEdges++;
      if (alignment > 0.3) support += weight * alignment;
      else if (alignment < -0.3) conflict += weight * -alignment;
      else neutral += weight;
    });

    return {
      externalEdges: externalEdges,
      support: support,
      conflict: conflict,
      neutral: neutral,
      compatible: conflict <= support + 2 || conflict <= 2.5
    };
  }

  function barrierTranslationPositions(graph, component, direction, distance) {
    var positions = translateVertices(graph, component, direction, distance);
    var clipped = 0;
    positions.forEach(function(position, index) {
      var node = graph.nodes[component[index]];
      var expectedX = node[0] + direction[0] * distance;
      var expectedY = node[1] + direction[1] * distance;
      if (Math.abs(position.x - expectedX) > 1e-8 ||
          Math.abs(position.y - expectedY) > 1e-8) {
        clipped++;
      }
    });
    return { positions: positions, clipped: clipped };
  }

  // Conservative Stage 3 search for the common late-game case where one edge
  // is the dominant barrier between two otherwise coherent sides. Test moving
  // the complete smaller side as a unit, preserving its internal geometry,
  // and commit only when deterministic cleanup projects a complete solve.
  function suggestDominantBarrierTransfer(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 140;
    var baseCrossings = intersections(graph.links);
    var cleanupLimit = options.cleanupSteps || 20;
    var maxGroupSize = options.maxGroupSize || 10;
    var candidates = [];
    var tested = 0;

    if (baseCrossings === 0 ||
        baseCrossings > (options.crossingLimit || 15)) {
      return {
        type: 'dominant-barrier-transfer-search',
        baseCrossings: baseCrossings,
        barriersInspected: 0,
        candidatesTested: 0,
        elapsedMs: 0,
        timedOut: false,
        best: null,
        candidates: []
      };
    }

    var edgeCrossings = graph.links.map(function(link, index) {
      var count = 0;
      for (var other = 0; other < graph.links.length; other++) {
        if (other !== index && intersect(link, graph.links[other])) count++;
      }
      return { index: index, count: count };
    }).filter(function(item) {
      // Floor of 1 lets the function handle the unambiguous 1-crossing case
      // (a single edge IS the dominant barrier when only one crossing remains).
      return item.count >= Math.max(1, Math.ceil(baseCrossings * 0.5));
    }).sort(function(a, b) {
      return b.count - a.count;
    }).slice(0, options.barrierLimit || 3);

    var directions = [];
    for (var directionIndex = 0; directionIndex < 8; directionIndex++) {
      var angle = directionIndex * Math.PI / 4;
      directions.push([Math.cos(angle), Math.sin(angle)]);
    }

    for (var barrierIndex = 0; barrierIndex < edgeCrossings.length &&
        now() - startedAt < timeBudgetMs; barrierIndex++) {
      var barrierInfo = edgeCrossings[barrierIndex];
      var barrier = graph.links[barrierInfo.index];
      var barrierA = graph.nodes.indexOf(barrier[0]);
      var barrierB = graph.nodes.indexOf(barrier[1]);
      var edgeDx = barrier[1][0] - barrier[0][0];
      var edgeDy = barrier[1][1] - barrier[0][1];
      var edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
      if (edgeLength < 1e-8) continue;
      var normal = [-edgeDy / edgeLength, edgeDx / edgeLength];

      [-1, 1].forEach(function(sideSign) {
        if (now() - startedAt >= timeBudgetMs) return;
        var signedDistances = {};
        var component = [];
        graph.nodes.forEach(function(node, index) {
          if (index === barrierA || index === barrierB) return;
          var signedDistance = sideOfEdge(barrier, node) / edgeLength;
          signedDistances[index] = signedDistance;
          if (Math.sign(signedDistance) === sideSign) component.push(index);
        });
        if (component.length === 0 || component.length > maxGroupSize) return;

        var crossesBarrier = false;
        for (var linkIndex = 0; linkIndex < graph.links.length; linkIndex++) {
          if (linkIndex !== barrierInfo.index &&
              intersect(barrier, graph.links[linkIndex])) {
            var linkA = graph.nodes.indexOf(graph.links[linkIndex][0]);
            var linkB = graph.nodes.indexOf(graph.links[linkIndex][1]);
            if (component.indexOf(linkA) >= 0 || component.indexOf(linkB) >= 0) {
              crossesBarrier = true;
              break;
            }
          }
        }
        if (!crossesBarrier) return;

        var maxDistanceFromBarrier = component.reduce(function(maximum, index) {
          return Math.max(maximum, Math.abs(signedDistances[index]));
        }, 0);
        var acrossDirection = sideSign > 0
          ? [-normal[0], -normal[1]] : normal.slice();
        var placements = [
          { direction: acrossDirection, distance: maxDistanceFromBarrier + 0.025 },
          { direction: acrossDirection, distance: maxDistanceFromBarrier + 0.06 }
        ];
        directions.forEach(function(direction) {
          [0.08, 0.16, 0.28, 0.45].forEach(function(distance) {
            placements.push({ direction: direction, distance: distance });
          });
        });

        for (var placementIndex = 0; placementIndex < placements.length &&
            now() - startedAt < timeBudgetMs; placementIndex++) {
          var placement = placements[placementIndex];
          var anchors = barrierAnchorCompatibility(
            graph, component, placement.direction);
          if (!anchors.compatible) continue;
          var translated = barrierTranslationPositions(
            graph, component, placement.direction, placement.distance);
          var simulation = cloneGraph(graph);
          applyGroupPositions(simulation, translated.positions);
          var immediateCrossings = intersections(simulation.links);
          var cleanupState = {};
          var cleanupSteps = 0;
          while (cleanupSteps < cleanupLimit &&
              now() - startedAt < timeBudgetMs) {
            var cleanup = findAdaptiveMinimizeMove(simulation, cleanupState, {
              candidateLimit: 8,
              randomSamples: 0,
              strongImprovement: Infinity
            });
            if (!cleanup) break;
            cleanup.node[0] = cleanup.toX;
            cleanup.node[1] = cleanup.toY;
            recordMove(cleanupState, cleanup.nodeIndex, cleanup.toX, cleanup.toY);
            intersections(simulation.links);
            cleanupSteps++;
          }
          var finalCrossings = intersections(simulation.links);
          tested++;
          var candidate = {
            type: 'dominant-barrier-transfer',
            strategy: 'stage3-dominant-barrier-transfer',
            objective: 'transfer side [' + component.join(',') +
              '] across dominant barrier v' + barrierA + '-v' + barrierB,
            barrier: [barrierA, barrierB],
            barrierEdgeIndex: barrierInfo.index,
            barrierCrossings: barrierInfo.count,
            barrierShare: barrierInfo.count / baseCrossings,
            component: component,
            positions: translated.positions,
            direction: placement.direction,
            distance: placement.distance,
            clippedVertices: translated.clipped,
            anchors: anchors,
            baseCrossings: baseCrossings,
            immediateCrossings: immediateCrossings,
            immediateDamage: Math.max(0, immediateCrossings - baseCrossings),
            finalCrossings: finalCrossings,
            cleanupSteps: cleanupSteps,
            accepted: finalCrossings === 0,
            score: finalCrossings * 1000 + immediateCrossings * 2 +
              translated.clipped * 3 + component.length
          };
          candidates.push(candidate);
          if (candidate.accepted) break;
        }
      });
    }

    candidates.sort(function(a, b) {
      return a.score - b.score ||
        b.barrierShare - a.barrierShare ||
        a.component.length - b.component.length;
    });
    return {
      type: 'dominant-barrier-transfer-search',
      baseCrossings: baseCrossings,
      barriersInspected: edgeCrossings.length,
      candidatesTested: tested,
      elapsedMs: now() - startedAt,
      timedOut: now() - startedAt >= timeBudgetMs,
      best: candidates.length > 0 && candidates[0].accepted
        ? candidates[0] : null,
      candidates: candidates.slice(0, 5)
    };
  }

  function crossingPairsForGraph(graph) {
    var pairs = [];
    for (var i = 0; i < graph.links.length; i++) {
      for (var j = i + 1; j < graph.links.length; j++) {
        if (shareEndpoint(graph.links[i], graph.links[j])) continue;
        if (!intersect(graph.links[i], graph.links[j])) continue;
        pairs.push({
          edgeA: i,
          edgeB: j
        });
      }
    }
    return pairs;
  }

  function barrierCrossingEdges(barrierIndex, crossingPairs) {
    var result = [];
    crossingPairs.forEach(function(pair) {
      if (pair.edgeA === barrierIndex) result.push(pair.edgeB);
      if (pair.edgeB === barrierIndex) result.push(pair.edgeA);
    });
    return result.filter(function(edgeIndex, index) {
      return result.indexOf(edgeIndex) === index;
    });
  }

  function sameSideComponentFromSeeds(graph, barrier, seeds, sideSign, limit) {
    var queue = seeds.slice();
    var seen = {};
    var component = [];
    seeds.forEach(function(seed) { seen[seed] = true; });

    while (queue.length && component.length < limit) {
      var index = queue.shift();
      var nodeSide = sideOfEdge(barrier, graph.nodes[index]);
      if (Math.abs(nodeSide) < 1e-10 || Math.sign(nodeSide) !== sideSign) {
        continue;
      }
      component.push(index);
      getNeighbors(graph, graph.nodes[index]).forEach(function(neighbor) {
        var neighborIndex = graph.nodes.indexOf(neighbor);
        if (neighborIndex < 0 || seen[neighborIndex]) return;
        var neighborSide = sideOfEdge(barrier, neighbor);
        if (Math.abs(neighborSide) < 1e-10 ||
            Math.sign(neighborSide) !== sideSign) {
          return;
        }
        seen[neighborIndex] = true;
        queue.push(neighborIndex);
      });
    }
    return component;
  }

  function sameSideSeedComponentsFromSeeds(graph, barrier, seeds, sideSign,
      limit) {
    var seen = {};
    var components = [];

    seeds.forEach(function(seed) {
      if (seen[seed]) return;
      var seedSide = sideOfEdge(barrier, graph.nodes[seed]);
      if (Math.abs(seedSide) < 1e-10 || Math.sign(seedSide) !== sideSign) {
        return;
      }

      var queue = [seed];
      var localSeen = {};
      var component = [];
      var overflow = false;
      seen[seed] = true;
      localSeen[seed] = true;

      while (queue.length) {
        var index = queue.shift();
        var nodeSide = sideOfEdge(barrier, graph.nodes[index]);
        if (Math.abs(nodeSide) < 1e-10 ||
            Math.sign(nodeSide) !== sideSign) {
          continue;
        }
        component.push(index);
        if (component.length > limit) {
          overflow = true;
          break;
        }

        getNeighbors(graph, graph.nodes[index]).forEach(function(neighbor) {
          var neighborIndex = graph.nodes.indexOf(neighbor);
          if (neighborIndex < 0 || localSeen[neighborIndex]) return;
          var neighborSide = sideOfEdge(barrier, neighbor);
          if (Math.abs(neighborSide) < 1e-10 ||
              Math.sign(neighborSide) !== sideSign) {
            return;
          }
          localSeen[neighborIndex] = true;
          seen[neighborIndex] = true;
          queue.push(neighborIndex);
        });
      }

      components.push({
        seeds: seeds.filter(function(candidate) {
          return localSeen[candidate];
        }),
        vertices: component,
        overflow: overflow
      });
    });

    return components;
  }

  function crossingCountsFromPairs(graph, crossingPairs) {
    var counts = graph.nodes.map(function() { return 0; });
    crossingPairs.forEach(function(pair) {
      [
        graph.links[pair.edgeA][0], graph.links[pair.edgeA][1],
        graph.links[pair.edgeB][0], graph.links[pair.edgeB][1]
      ].forEach(function(node) {
        var index = graph.nodes.indexOf(node);
        if (index >= 0) counts[index]++;
      });
    });
    return counts;
  }

  function cleanAnchorBreaksForBarrier(graph, barrier, sideSign, crossingPairs) {
    var barrierA = graph.nodes.indexOf(barrier[0]);
    var barrierB = graph.nodes.indexOf(barrier[1]);
    var crossingCounts = crossingCountsFromPairs(graph, crossingPairs);
    var breaks = [];

    graph.nodes.forEach(function(node, index) {
      if (index === barrierA || index === barrierB) return;
      var side = sideOfEdge(barrier, node);
      if (Math.abs(side) < 1e-10 || Math.sign(side) !== sideSign) return;

      var neighbors = getNeighbors(graph, node).map(function(neighbor) {
        return graph.nodes.indexOf(neighbor);
      });

      var sameSideNeighbors = 0;
      var oppositeSideNeighbors = 0;
      var neutralNeighbors = 0;
      neighbors.forEach(function(neighborIndex) {
        if (neighborIndex === barrierA || neighborIndex === barrierB) return;
        var neighborSide = sideOfEdge(barrier, graph.nodes[neighborIndex]);
        if (Math.abs(neighborSide) < 1e-10) neutralNeighbors++;
        else if (Math.sign(neighborSide) === sideSign) sameSideNeighbors++;
        else oppositeSideNeighbors++;
      });

      var incidentCrossings = crossingCounts[index] || 0;
      var clean = incidentCrossings === 0 && oppositeSideNeighbors === 0;
      var touchesBarrier =
        neighbors.indexOf(barrierA) >= 0 && neighbors.indexOf(barrierB) >= 0;
      breaks.push({
        index: index,
        clean: clean,
        touchesBarrier: touchesBarrier,
        incidentCrossings: incidentCrossings,
        sameSideNeighbors: sameSideNeighbors,
        oppositeSideNeighbors: oppositeSideNeighbors,
        neutralNeighbors: neutralNeighbors,
        score: (clean ? 100 : 0) + (touchesBarrier ? 18 : 0) +
          sameSideNeighbors * 4 -
          oppositeSideNeighbors * 12 - incidentCrossings * 8
      });
    });

    breaks.sort(function(a, b) {
      return b.score - a.score ||
        a.incidentCrossings - b.incidentCrossings ||
        b.sameSideNeighbors - a.sameSideNeighbors;
    });
    return breaks;
  }

  function findAnchorBreakRepairMove(graph, componentSet, protectedSet) {
    var count = intersections(graph.links);
    if (count === 0) return null;
    var crossingCounts = getCrossingCounts(graph);
    var candidates = [];

    graph.nodes.forEach(function(node, index) {
      if (protectedSet[index] || crossingCounts[index] === 0) return;
      candidates.push({
        index: index,
        node: node,
        crossings: crossingCounts[index],
        inComponent: !!componentSet[index]
      });
    });

    candidates.sort(function(a, b) {
      return (b.inComponent ? 1 : 0) - (a.inComponent ? 1 : 0) ||
        b.crossings - a.crossings;
    });
    candidates = candidates.slice(0, 10);

    var best = null;
    candidates.forEach(function(candidate) {
      var node = candidate.node;
      var positions = [];
      var neighbors = getNeighbors(graph, node);
      if (neighbors.length > 0) {
        var center = centroid(neighbors);
        positions.push({
          x: center[0],
          y: center[1],
          strategy: 'anchor-break-repair-centroid'
        });
        positions.push({
          x: node[0] + (center[0] - node[0]) * 0.5,
          y: node[1] + (center[1] - node[1]) * 0.5,
          strategy: 'anchor-break-repair-half'
        });
      }
      for (var d = 0; d < 8; d++) {
        var angle = d * Math.PI * 2 / 8;
        positions.push({
          x: node[0] + Math.cos(angle) * 0.035,
          y: node[1] + Math.sin(angle) * 0.035,
          strategy: 'anchor-break-repair-local'
        });
      }

      positions.forEach(function(position) {
        var x = Math.max(0.02, Math.min(0.98, position.x));
        var y = Math.max(0.02, Math.min(0.98, position.y));
        var delta = evaluateMoveDelta(graph, node, x, y, count);
        if (delta >= 0) return;
        var score = delta - (candidate.inComponent ? 0.25 : 0);
        if (!best || score < best.score) {
          best = {
            index: candidate.index,
            x: x,
            y: y,
            delta: delta,
            score: score,
            mode: 'anchor-break-repair',
            strategy: position.strategy
          };
        }
      });
    });

    return best;
  }

  function simulateAnchorBreakTransfer(graph, transferPositions, component,
      barrier, cleanupLimit) {
    var simulation = cloneGraph(graph);
    var peakCrossings = intersections(simulation.links);
    var componentSet = {};
    var protectedSet = {};
    var repairPositions = [];

    component.forEach(function(index) { componentSet[index] = true; });
    barrier.forEach(function(node) {
      var index = graph.nodes.indexOf(node);
      if (index >= 0) protectedSet[index] = true;
    });

    transferPositions.forEach(function(position) {
      simulation.nodes[position.index][0] = position.x;
      simulation.nodes[position.index][1] = position.y;
      peakCrossings = Math.max(peakCrossings, intersections(simulation.links));
    });
    var transferCrossings = intersections(simulation.links);
    peakCrossings = Math.max(peakCrossings, transferCrossings);

    var repairSteps = 0;
    while (repairSteps < cleanupLimit) {
      var repair = findAnchorBreakRepairMove(
        simulation, componentSet, protectedSet);
      if (!repair) break;
      simulation.nodes[repair.index][0] = repair.x;
      simulation.nodes[repair.index][1] = repair.y;
      repairPositions.push({
        index: repair.index,
        x: repair.x,
        y: repair.y,
        mode: repair.mode,
        strategy: repair.strategy
      });
      peakCrossings = Math.max(peakCrossings, intersections(simulation.links));
      repairSteps++;
    }

    return {
      positions: transferPositions.concat(repairPositions),
      transferCrossings: transferCrossings,
      finalCrossings: intersections(simulation.links),
      repairSteps: repairSteps,
      peakCrossings: peakCrossings
    };
  }

  function tryAnchorBreakEndpointRoomMoves(graph, barrier, component, targetSign,
      margin) {
    var barrierA = graph.nodes.indexOf(barrier[0]);
    var barrierB = graph.nodes.indexOf(barrier[1]);
    if (barrierA < 0 || barrierB < 0) return [];

    var edgeDx = barrier[1][0] - barrier[0][0];
    var edgeDy = barrier[1][1] - barrier[0][1];
    var edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
    if (edgeLength < 1e-8) return [];

    var normal = [-edgeDy / edgeLength, edgeDx / edgeLength];
    if (targetSign > 0) normal = [-normal[0], -normal[1]];

    var componentCenter = centroid(component.map(function(index) {
      return graph.nodes[index];
    }));
    var endpointBaseCounts = getCrossingCounts(graph);
    var simulation = cloneGraph(graph);
    var accepted = [];
    var baseTotal = intersections(simulation.links);
    var steps = [margin * 1.2, margin * 2.0, margin * 3.0, 0.025, 0.04];

    [barrierA, barrierB].forEach(function(index) {
      var original = graph.nodes[index];
      var best = null;

      steps.forEach(function(step) {
        var lateral = [
          (componentCenter[0] - original[0]) * 0.08,
          (componentCenter[1] - original[1]) * 0.08
        ];
        var x = Math.max(0.02, Math.min(0.98,
          original[0] + normal[0] * step + lateral[0]));
        var y = Math.max(0.02, Math.min(0.98,
          original[1] + normal[1] * step + lateral[1]));

        var beforeX = simulation.nodes[index][0];
        var beforeY = simulation.nodes[index][1];
        simulation.nodes[index][0] = x;
        simulation.nodes[index][1] = y;
        var counts = getCrossingCounts(simulation);
        var total = intersections(simulation.links);
        simulation.nodes[index][0] = beforeX;
        simulation.nodes[index][1] = beforeY;

        if ((counts[barrierA] || 0) > (endpointBaseCounts[barrierA] || 0) ||
            (counts[barrierB] || 0) > (endpointBaseCounts[barrierB] || 0)) {
          return;
        }
        var score = total - baseTotal - step * 0.01;
        if (!best || score < best.score) {
          best = {
            index: index,
            x: x,
            y: y,
            mode: 'anchor-break-endpoint-room',
            strategy: 'anchor-break-endpoint-room',
            endpointCrossingsBefore: endpointBaseCounts[index] || 0,
            endpointCrossingsAfter: counts[index] || 0,
            totalCrossingsAfter: total,
            score: score
          };
        }
      });

      if (best) {
        simulation.nodes[index][0] = best.x;
        simulation.nodes[index][1] = best.y;
        baseTotal = intersections(simulation.links);
        accepted.push(best);
      }
    });

    return accepted;
  }

  function anchorBreakTransferPositions(graph, barrier, component, targetSign,
      margin) {
    var simulation = cloneGraph(graph);
    var barrierA = graph.nodes.indexOf(barrier[0]);
    var barrierB = graph.nodes.indexOf(barrier[1]);
    var simBarrier = [simulation.nodes[barrierA], simulation.nodes[barrierB]];
    var edgeDx = simBarrier[1][0] - simBarrier[0][0];
    var edgeDy = simBarrier[1][1] - simBarrier[0][1];
    var edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
    if (edgeLength < 1e-8) return null;
    var normal = [-edgeDy / edgeLength, edgeDx / edgeLength];
    if (targetSign < 0) normal = [-normal[0], -normal[1]];

    var ordered = component.slice().sort(function(a, b) {
      return Math.abs(sideOfEdge(barrier, graph.nodes[a])) -
        Math.abs(sideOfEdge(barrier, graph.nodes[b]));
    });
    var positions = tryAnchorBreakEndpointRoomMoves(
      graph, barrier, component, targetSign, margin);
    positions.forEach(function(position) {
      simulation.nodes[position.index][0] = position.x;
      simulation.nodes[position.index][1] = position.y;
    });
    simBarrier = [simulation.nodes[barrierA], simulation.nodes[barrierB]];
    edgeDx = simBarrier[1][0] - simBarrier[0][0];
    edgeDy = simBarrier[1][1] - simBarrier[0][1];
    edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
    if (edgeLength < 1e-8) return null;
    normal = [-edgeDy / edgeLength, edgeDx / edgeLength];
    if (targetSign < 0) normal = [-normal[0], -normal[1]];

    ordered.forEach(function(index) {
      var points = [];
      getNeighbors(simulation, simulation.nodes[index]).forEach(function(neighbor) {
        var neighborIndex = simulation.nodes.indexOf(neighbor);
        if (neighborIndex === barrierA || neighborIndex === barrierB ||
            sideOfEdge(simBarrier, neighbor) * targetSign > 0) {
          points.push(neighbor);
        }
      });
      if (points.length === 0) points.push(simBarrier[0], simBarrier[1]);
      var target = centroid(points);
      var signedDistance = sideOfEdge(simBarrier, target) / edgeLength;
      var needed = margin - signedDistance * targetSign;
      if (needed > 0) {
        target = [
          target[0] + normal[0] * needed,
          target[1] + normal[1] * needed
        ];
      }
      var x = Math.max(0.02, Math.min(0.98, target[0]));
      var y = Math.max(0.02, Math.min(0.98, target[1]));
      simulation.nodes[index][0] = x;
      simulation.nodes[index][1] = y;
      positions.push({
        index: index,
        x: x,
        y: y,
        mode: 'anchor-break-transfer'
      });
    });

    return {
      order: ordered,
      positions: positions
    };
  }

  function suggestAnchorBreakBarrierTransfer(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 120;
    var componentLimit = options.componentLimit || 8;
    var baseCrossings = intersections(graph.links);
    var crossingPairs = crossingPairsForGraph(graph);
    var candidates = [];
    var rejected = [];
    var tested = 0;

    if (baseCrossings === 0 || crossingPairs.length === 0) {
      return {
        type: 'anchor-break-barrier-transfer',
        baseCrossings: baseCrossings,
        candidatesTested: 0,
        elapsedMs: 0,
        timedOut: false,
        best: null,
        candidates: []
      };
    }

    var barrierCounts = {};
    crossingPairs.forEach(function(pair) {
      barrierCounts[pair.edgeA] = (barrierCounts[pair.edgeA] || 0) + 1;
      barrierCounts[pair.edgeB] = (barrierCounts[pair.edgeB] || 0) + 1;
    });
    var barriers = Object.keys(barrierCounts).map(Number)
      .sort(function(a, b) { return barrierCounts[b] - barrierCounts[a]; })
      .slice(0, options.barrierLimit || 4);

    for (var bi = 0; bi < barriers.length &&
        now() - startedAt < timeBudgetMs; bi++) {
      var barrierIndex = barriers[bi];
      var barrier = graph.links[barrierIndex];
      var barrierA = graph.nodes.indexOf(barrier[0]);
      var barrierB = graph.nodes.indexOf(barrier[1]);
      var crossingEdges = barrierCrossingEdges(barrierIndex, crossingPairs);
      if (crossingEdges.length === 0) continue;

      [-1, 1].forEach(function(sourceSign) {
        if (now() - startedAt >= timeBudgetMs) return;
        var sourceAnchorBreaks = cleanAnchorBreaksForBarrier(
          graph, barrier, sourceSign, crossingPairs);
        var targetAnchorBreaks = cleanAnchorBreaksForBarrier(
          graph, barrier, -sourceSign, crossingPairs);
        var seeds = [];
        crossingEdges.forEach(function(edgeIndex) {
          graph.links[edgeIndex].forEach(function(node) {
            var index = graph.nodes.indexOf(node);
            if (index === barrierA || index === barrierB) return;
            var side = sideOfEdge(barrier, node);
            if (Math.abs(side) > 1e-10 && Math.sign(side) === sourceSign &&
                seeds.indexOf(index) < 0) {
              seeds.push(index);
            }
          });
        });
        if (seeds.length === 0) return;

        var components = sameSideSeedComponentsFromSeeds(
          graph, barrier, seeds, sourceSign, componentLimit + 1);
        components.forEach(function(componentInfo) {
          if (now() - startedAt >= timeBudgetMs) return;
          var component = componentInfo.vertices;
          if (component.length === 0) return;
          if (componentInfo.overflow || component.length > componentLimit) {
            rejected.push({
              barrier: [barrierA, barrierB],
              side: sourceSign,
              seeds: componentInfo.seeds,
              size: component.length,
              reason: 'component-limit'
            });
            return;
          }

          var componentSet = {};
          component.forEach(function(index) { componentSet[index] = true; });
          var componentAnchorBreaks = sourceAnchorBreaks.filter(function(item) {
            return componentSet[item.index];
          });
          var cleanComponentAnchorBreaks = componentAnchorBreaks.filter(function(item) {
            return item.clean;
          });
          if (cleanComponentAnchorBreaks.length === 0) {
            rejected.push({
              barrier: [barrierA, barrierB],
              side: sourceSign,
              seeds: componentInfo.seeds,
              component: component,
              reason: 'no-clean-anchor-break'
            });
            return;
          }

          var transfer = anchorBreakTransferPositions(
            graph, barrier, component, -sourceSign,
            options.margin === undefined ? 0.005 : options.margin);
          if (!transfer) {
            rejected.push({
              barrier: [barrierA, barrierB],
              side: sourceSign,
              seeds: componentInfo.seeds,
              component: component,
              reason: 'no-transfer'
            });
            return;
          }

          var simulated = simulateAnchorBreakTransfer(
            graph, transfer.positions, transfer.order, barrier,
            options.cleanupSteps === undefined ? 6 : options.cleanupSteps);
          var transferCrossings = simulated.transferCrossings;
          var finalCrossings = simulated.finalCrossings;
          tested++;

          if (finalCrossings >= baseCrossings) {
            rejected.push({
              barrier: [barrierA, barrierB],
              side: sourceSign,
              seeds: componentInfo.seeds,
              component: transfer.order,
              transferCrossings: transferCrossings,
              finalCrossings: finalCrossings,
              reason: 'no-final-improvement'
            });
          }

          var candidate = {
            type: 'anchor-break-barrier-transfer',
            strategy: 'stage2-anchor-break-barrier-transfer',
            reason: 'transfer chain [' + transfer.order.join(',') +
              '] across barrier v' + barrierA + '-v' + barrierB,
            barrier: [barrierA, barrierB],
            barrierEdgeIndex: barrierIndex,
            barrierCrossings: barrierCounts[barrierIndex],
            crossingEdges: crossingEdges.map(function(edgeIndex) {
              return [
                graph.nodes.indexOf(graph.links[edgeIndex][0]),
                graph.nodes.indexOf(graph.links[edgeIndex][1])
              ];
            }),
            seeds: componentInfo.seeds,
            allSeeds: seeds,
            sourceAnchorBreaks: sourceAnchorBreaks,
            targetAnchorBreaks: targetAnchorBreaks,
            componentAnchorBreaks: componentAnchorBreaks,
            cleanAnchorBreaks: cleanComponentAnchorBreaks,
            component: transfer.order,
            positions: simulated.positions,
            transferPositions: transfer.positions,
            repairSteps: simulated.repairSteps,
            peakCrossings: simulated.peakCrossings,
            baseCrossings: baseCrossings,
            transferCrossings: transferCrossings,
            immediateCrossings: transferCrossings,
            immediateDamage: Math.max(0, transferCrossings - baseCrossings),
            finalCrossings: finalCrossings,
            finalDamage: Math.max(0, finalCrossings - baseCrossings),
            downstreamImprovement: baseCrossings - finalCrossings,
            simulationSteps: simulated.repairSteps,
            cleanDelta: 0,
            accepted: finalCrossings < baseCrossings,
            score: finalCrossings * 100 + transfer.order.length +
              Math.max(0, finalCrossings - baseCrossings) * 10 +
              simulated.repairSteps * 2 -
              cleanComponentAnchorBreaks.length * 35 -
              componentAnchorBreaks.length * 8 +
              Math.max(0, simulated.peakCrossings - baseCrossings) * 0.1
          };
          candidates.push(candidate);
        });
      });
    }

    candidates.sort(function(a, b) {
      return a.score - b.score ||
        b.barrierCrossings - a.barrierCrossings ||
        a.component.length - b.component.length;
    });
    return {
      type: 'anchor-break-barrier-transfer',
      baseCrossings: baseCrossings,
      candidatesTested: tested,
      elapsedMs: now() - startedAt,
      timedOut: now() - startedAt >= timeBudgetMs,
      best: candidates.length && candidates[0].accepted ? candidates[0] : null,
      candidates: candidates.slice(0, options.keepCandidates || 8),
      rejected: rejected.slice(0, options.keepRejected || 12)
    };
  }

  function suggestProblemChildInversions(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 160;
    var candidateLimit = options.candidateLimit || 220;
    var perVertexLimit = options.perVertexLimit || 80;
    var vertexLimit = options.vertexLimit || 10;
    var rolloutLimit = options.rolloutLimit || 10;
    var rolloutSteps = options.rolloutSteps || 12;
    var baseCrossings = intersections(graph.links);
    var baseClean = graph.nodes.filter(function(node) {
      return !node.intersection;
    }).length;
    var crossingCounts = getCrossingCounts(graph);
    var tested = 0;
    var timedOut = false;
    var center = graph.nodes.reduce(function(sum, node) {
      sum[0] += node[0];
      sum[1] += node[1];
      return sum;
    }, [0, 0]);
    center[0] /= Math.max(1, graph.nodes.length);
    center[1] /= Math.max(1, graph.nodes.length);

    if (baseCrossings === 0) {
      return {
        type: 'problem-child-inversion',
        baseCrossings: 0,
        candidatesTested: 0,
        elapsedMs: 0,
        timeBudgetMs: timeBudgetMs,
        timedOut: false,
        best: null,
        candidates: []
      };
    }

    function distance(a, b) {
      var dx = a[0] - b[0];
      var dy = a[1] - b[1];
      return Math.sqrt(dx * dx + dy * dy);
    }

    function normalize(dx, dy) {
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-8) return null;
      return [dx / len, dy / len];
    }

    function addDirection(directions, dx, dy) {
      var dir = normalize(dx, dy);
      if (!dir) return;
      for (var i = 0; i < directions.length; i++) {
        if (directions[i][0] * dir[0] + directions[i][1] * dir[1] > 0.97) {
          return;
        }
      }
      directions.push(dir);
    }

    var ranked = crossingCounts.map(function(count, index) {
      var node = graph.nodes[index];
      var edges = getNodeEdges(graph, node);
      var maxIncidentLength = 0;
      edges.forEach(function(edge) {
        var other = edge[0] === node ? edge[1] : edge[0];
        maxIncidentLength = Math.max(maxIncidentLength, distance(node, other));
      });
      return {
        index: index,
        crossings: count,
        degree: edges.length,
        maxIncidentLength: maxIncidentLength,
        score: count * 4 + count / Math.max(1, edges.length) +
          maxIncidentLength * 2
      };
    }).filter(function(item) {
      return item.crossings > 0 && item.degree > 0;
    }).sort(function(a, b) {
      return b.score - a.score || b.crossings - a.crossings;
    }).slice(0, vertexLimit);

    var candidates = [];
    var seen = {};
    var radii = options.radii || [0.04, 0.06, 0.085, 0.115, 0.15];
    for (var ri = 0; ri < ranked.length &&
        tested < candidateLimit &&
        now() - startedAt < timeBudgetMs; ri++) {
      var item = ranked[ri];
      var vertexIndex = item.index;
      var node = graph.nodes[vertexIndex];
      var vertexTested = 0;
      var neighbors = getNeighbors(graph, node).map(function(neighbor) {
        return graph.nodes.indexOf(neighbor);
      }).filter(function(index) {
        return index >= 0;
      });
      var otherNeighborCenter = [0, 0];
      neighbors.forEach(function(neighborIndex) {
        otherNeighborCenter[0] += graph.nodes[neighborIndex][0];
        otherNeighborCenter[1] += graph.nodes[neighborIndex][1];
      });
      otherNeighborCenter[0] /= Math.max(1, neighbors.length);
      otherNeighborCenter[1] /= Math.max(1, neighbors.length);

      for (var ni = 0; ni < neighbors.length &&
          tested < candidateLimit &&
          vertexTested < perVertexLimit &&
          now() - startedAt < timeBudgetMs; ni++) {
        var referenceIndex = neighbors[ni];
        var reference = graph.nodes[referenceIndex];
        var directions = [];

        // These first directions are the human-readable cases: outside the
        // graph center, away from the current problem child, and away from the
        // rest of the child vertex's neighbor fan.
        addDirection(directions, reference[0] - center[0], reference[1] - center[1]);
        addDirection(directions, reference[0] - node[0], reference[1] - node[1]);
        addDirection(directions,
          reference[0] - otherNeighborCenter[0],
          reference[1] - otherNeighborCenter[1]);

        // Add a coarse full-sector sweep so this remains a topology/side-change
        // diagnostic rather than a hard-coded "outside viewport" move.
        for (var sector = 0; sector < 12; sector++) {
          var angle = Math.PI * 2 * sector / 12;
          addDirection(directions, Math.cos(angle), Math.sin(angle));
        }

        for (var di = 0; di < directions.length &&
            tested < candidateLimit &&
            vertexTested < perVertexLimit &&
            now() - startedAt < timeBudgetMs; di++) {
          var direction = directions[di];
          for (var si = 0; si < radii.length &&
              tested < candidateLimit &&
              vertexTested < perVertexLimit &&
              now() - startedAt < timeBudgetMs; si++) {
            var radius = radii[si];
            var toX = Math.max(0.02, Math.min(0.98,
              reference[0] + direction[0] * radius));
            var toY = Math.max(0.02, Math.min(0.98,
              reference[1] + direction[1] * radius));
            var key = vertexIndex + ':' + toX.toFixed(3) + ',' + toY.toFixed(3);
            if (seen[key]) continue;
            seen[key] = true;
            if (isTooClose(graph, node, toX, toY)) continue;
            tested++;
            vertexTested++;

            var simulation = cloneGraph(graph);
            simulation.nodes[vertexIndex][0] = toX;
            simulation.nodes[vertexIndex][1] = toY;
            var immediateCrossings = intersections(simulation.links);
            var immediateClean = simulation.nodes.filter(function(simNode) {
              return !simNode.intersection;
            }).length;
            var displacement = distance(node, [toX, toY]);
            var immediateImprovement = baseCrossings - immediateCrossings;
            var candidate = {
              type: 'problem-child-inversion',
              strategy: 'stage2-problem-child-inversion',
              component: [vertexIndex],
              positions: [{
                index: vertexIndex,
                x: toX,
                y: toY,
                mode: 'problem-child-inversion',
                reference: referenceIndex
              }],
              vertex: vertexIndex,
              referenceVertex: referenceIndex,
              referenceDegree: getNodeEdges(graph, reference).length,
              vertexDegree: item.degree,
              vertexCrossings: item.crossings,
              baseCrossings: baseCrossings,
              immediateCrossings: immediateCrossings,
              immediateDamage: Math.max(0, immediateCrossings - baseCrossings),
              finalCrossings: immediateCrossings,
              downstreamImprovement: immediateImprovement,
              cleanDelta: immediateClean - baseClean,
              simulationSteps: 0,
              displacement: displacement,
              reason: 'move problem-child v' + vertexIndex +
                ' to hug/reference v' + referenceIndex +
                ' from a new side sector',
              accepted: immediateImprovement > 0,
              score: immediateCrossings * 100 -
                Math.max(0, immediateImprovement) * 12 +
                Math.max(0, immediateCrossings - baseCrossings) * 20 +
                displacement * 4
            };
            candidates.push(candidate);
          }
        }
      }
    }

    if (now() - startedAt >= timeBudgetMs) timedOut = true;
    candidates.sort(function(a, b) {
      return a.score - b.score ||
        b.vertexCrossings - a.vertexCrossings ||
        a.displacement - b.displacement;
    });

    var rolloutCount = Math.min(rolloutLimit, candidates.length);
    for (var ci = 0; ci < rolloutCount &&
        now() - startedAt < timeBudgetMs; ci++) {
      var rolloutCandidate = candidates[ci];
      var rolloutGraph = cloneGraph(graph);
      applyGroupPositions(rolloutGraph, rolloutCandidate.positions);
      var rollout = stage1Rollout(rolloutGraph, rolloutSteps);
      rolloutCandidate.finalCrossings = rollout.finalCrossings;
      rolloutCandidate.downstreamImprovement =
        baseCrossings - rollout.finalCrossings;
      rolloutCandidate.simulationSteps = rollout.moves.length;
      rolloutCandidate.cleanDelta = rolloutGraph.nodes.filter(function(node) {
        return !node.intersection;
      }).length - baseClean;
      rolloutCandidate.accepted = rolloutCandidate.immediateCrossings < baseCrossings ||
        rolloutCandidate.finalCrossings < baseCrossings;
      rolloutCandidate.score = rolloutCandidate.finalCrossings * 100 +
        rolloutCandidate.immediateDamage * 12 -
        Math.max(0, rolloutCandidate.downstreamImprovement) * 8 -
        rolloutCandidate.cleanDelta * 2 +
        rolloutCandidate.displacement * 4;
    }
    if (now() - startedAt >= timeBudgetMs) timedOut = true;

    candidates.sort(function(a, b) {
      return a.score - b.score ||
        b.downstreamImprovement - a.downstreamImprovement ||
        b.vertexCrossings - a.vertexCrossings;
    });

    return {
      type: 'problem-child-inversion',
      baseCrossings: baseCrossings,
      candidateVertices: ranked.map(function(item) { return item.index; }),
      candidatesTested: tested,
      elapsedMs: now() - startedAt,
      timeBudgetMs: timeBudgetMs,
      timedOut: timedOut,
      best: candidates.length > 0 && candidates[0].accepted
        ? candidates[0] : null,
      candidates: candidates.slice(0, options.keepCandidates || 8)
    };
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
    var establishedRegions = cleanRegions.map(function(region) {
      return analyzeEstablishedRegion(graph, region);
    }).sort(function(a, b) {
      return b.score - a.score;
    });
    var conflictRegions = analyzeConflictRegions(graph);
    var directionalPlans = suggestDirectionalPlans(
      graph, conflictRegions, establishedRegions.length > 0 ? establishedRegions[0] : null);
    var edgeLengthByDegree = analyzeEdgeLengthByDegree(graph, adjacency);

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
      crossingCounts: crossingCounts,
      cleanVertices: cleanIndices.length,
      cleanRatio: graph.nodes.length > 0 ? cleanIndices.length / graph.nodes.length : 1,
      cleanRegions: cleanRegions,
      largestCleanRegion: cleanRegions.length > 0 ? cleanRegions[0].length : 0,
      establishedRegions: establishedRegions,
      bestEstablishedRegion: establishedRegions.length > 0 ? establishedRegions[0] : null,
      conflictRegions: conflictRegions,
      directionalPlans: directionalPlans,
      edgeLengthByDegree: edgeLengthByDegree,
      crossingConcentration: concentration.slice(0, 5),
      topCrossingShare: topCrossingShare,
      recentCrossings: recent,
      recentImprovement: recentImprovement,
      stalled: crossingCount > 0 && recent.length >= 3 && recentImprovement <= 0,
      oscillatingVertices: oscillatingVertices,
      activeStructuralPlan: structuralPlanSummary(state.activeStructuralPlan),
      lastStructuralPlan: state.lastStructuralPlan || null,
      lastContainedTriangleSearch: state.lastContainedTriangleSearch || null,
      lastBarrierTransferSearch: state.lastBarrierTransferSearch || null,
      lastCompactionSearch: state.lastCompactionSearch || null,
      lastRegionExtensionSearch: state.lastRegionExtensionSearch || null,
      lastProblemChildInversionSearch:
        state.lastProblemChildInversionSearch || null,
      lastAnchorBreakBarrierSearch: state.lastAnchorBreakBarrierSearch || null,
      lastCascadeTriggerSearch: state.lastCascadeTriggerSearch || null,
      lastMinimizeAttempt: state.lastMinimizeAttempt || null,
      lastSideFlipAttempt: state.lastSideFlipAttempt || null,
      sideFlipMoves: state.sideFlipMoves || 0
    };
  }

  // Derived progress metrics. Assumes intersections() has run on the graph
  // (analyzeGraphState calls it) so node.intersection flags are current.
  function computeProgressMetrics(graph, analysis) {
    var N = graph.nodes.length;
    var E = graph.links.length;
    var crossings = analysis.crossings;

    var cleanEdges = 0;
    for (var i = 0; i < graph.links.length; i++) {
      var link = graph.links[i];
      if (!link[0].intersection && !link[1].intersection) cleanEdges++;
    }
    var dirtyEdges = E - cleanEdges;

    var largestCleanRegion = analysis.largestCleanRegion || 0;
    var largestCleanRegionRatio = N > 0 ? largestCleanRegion / N : 0;
    var cleanRegionCount = (analysis.cleanRegions || []).length;
    var regionFragmentation = 0;
    if (cleanRegionCount > 0 && analysis.cleanVertices > 0) {
      regionFragmentation = 1 - (largestCleanRegion / analysis.cleanVertices);
    }

    // Near-clean: vertices with at most 1 incident crossing. Leading indicator
    // of "about to be clean" — useful before any cleanVertices appear.
    var nearCleanVertices = 0;
    var cc = analysis.crossingCounts || [];
    for (var v = 0; v < N; v++) {
      if ((cc[v] || 0) <= 1) nearCleanVertices++;
    }
    var nearCleanRatio = N > 0 ? nearCleanVertices / N : 0;

    var crossingPenalty = crossings / (crossings + 30);   // 0..1, 0.5 at 30 crossings
    var progress = (
      0.40 * (analysis.cleanRatio || 0) +
      0.45 * largestCleanRegionRatio +
      0.15 * (1 - crossingPenalty)
    );

    return {
      crossings: crossings,
      cleanVertices: analysis.cleanVertices,
      cleanRatio: analysis.cleanRatio || 0,
      cleanRegionCount: cleanRegionCount,
      largestCleanRegion: largestCleanRegion,
      largestCleanRegionRatio: largestCleanRegionRatio,
      cleanEdges: cleanEdges,
      cleanEdgeRatio: E > 0 ? cleanEdges / E : 0,
      crossingsPerEdge: E > 0 ? crossings / E : 0,
      crossingsPerDirtyEdge: dirtyEdges > 0 ? crossings / dirtyEdges : 0,
      regionFragmentation: regionFragmentation,
      nearCleanVertices: nearCleanVertices,
      nearCleanRatio: nearCleanRatio,
      topCrossingShare: analysis.topCrossingShare || 0,
      progress: progress
    };
  }

  // ===========================================================================
  // SECTION: STORY / CASCADE-STATE METRICS (real-time, causal, stateful)
  // A live readout of where a solve sits relative to the wasted-tail/cascade
  // story (see METRICS.md). All numbers use only the present move plus a short
  // trailing window, so the solver itself can read them mid-solve. Cheap: pure
  // O(N) arithmetic over per-vertex crossing counts the solver already pays for.
  //
  // Vocabulary (per-move, window W):
  //   freeze  - mean offender-set Jaccard over last W moves; ~1 => the SAME
  //             vertices cross every move (thrashing in place). [stuck signal]
  //   dwell   - moves since crossings last set a STRICT new low; the live length
  //             of the current wasted tail. Resets when a cascade makes new lows.
  //   crowd   - # vertices that have been dirty >= W consecutive moves.
  //   trend   - crossings now minus crossings W moves ago (sign: + uphill/escape,
  //             ~0 plateau, - descending/cascade).
  //   thaw    - # offenders that dropped out of the set since last move (turnover).
  //   drop    - max single-vertex crossing-count reduction this move (a
  //             de-confliction EVENT; not a prediction that a cascade will catch).
  // ===========================================================================
  function createStoryState(window) {
    return {
      W: window || 15,
      streak: null,        // per-vertex consecutive-dirty counter
      prevCounts: null,    // per-vertex crossing counts last move (for drop)
      prevOffSet: null,    // map {vertexIndex: true} of last move's offenders
      jaccardRing: [],     // recent consecutive Jaccards (for freeze)
      crossRing: [],       // recent total crossings (for trend)
      best: Infinity,      // best (min) total crossings seen so far (for dwell)
      move: 0,
      lastImprove: 0
    };
  }

  // Updates st in place and returns the current story-metric vector. Computes
  // its own per-vertex counts via the canonical detector so it can be called
  // with just the graph; callers that already have counts may pass them in.
  function updateStoryMetrics(graph, st, crossingCountsOpt, totalCrossingsOpt) {
    var crossingCounts = crossingCountsOpt || getCrossingCounts(graph);
    var N = crossingCounts.length;
    var W = st.W;
    if (!st.streak || st.streak.length !== N) st.streak = new Array(N).fill(0);
    st.move++;

    var total = (typeof totalCrossingsOpt === 'number') ?
      totalCrossingsOpt : intersections(graph.links);

    // offender set, streaks, crowd, worst offender
    var offSet = {};
    var offenderCount = 0, crowd = 0, topCc = 0, topVertex = -1;
    for (var v = 0; v < N; v++) {
      var c = crossingCounts[v] || 0;
      if (c > 0) {
        offSet[v] = true; offenderCount++;
        st.streak[v]++;
        if (st.streak[v] >= W) crowd++;
        if (c > topCc) { topCc = c; topVertex = v; }
      } else st.streak[v] = 0;
    }

    // freeze: averaged consecutive offender-set Jaccard over last W moves
    var jacc = 1, thaw = 0;
    if (st.prevOffSet) {
      var inter = 0, unionCount = offenderCount;
      for (var k in offSet) { if (st.prevOffSet[k]) inter++; }
      for (var p in st.prevOffSet) { if (!offSet[p]) { unionCount++; thaw++; } }
      jacc = unionCount > 0 ? inter / unionCount : 1;
    }
    st.jaccardRing.push(jacc);
    if (st.jaccardRing.length > W) st.jaccardRing.shift();
    var freeze = st.jaccardRing.reduce(function(a, b) { return a + b; }, 0) /
      st.jaccardRing.length;

    // drop: largest single-vertex crossing reduction this move
    var drop = 0;
    if (st.prevCounts) {
      for (var d = 0; d < N; d++) {
        var dd = (st.prevCounts[d] || 0) - (crossingCounts[d] || 0);
        if (dd > drop) drop = dd;
      }
    }

    // dwell: moves since a strict new crossings-low (live wasted-tail length)
    if (total < st.best) { st.best = total; st.lastImprove = st.move; }
    var dwell = st.move - st.lastImprove;

    // trend: crossings now vs W moves ago
    st.crossRing.push(total);
    if (st.crossRing.length > W + 1) st.crossRing.shift();
    var trend = total - st.crossRing[0];

    st.prevOffSet = offSet;
    st.prevCounts = crossingCounts.slice();

    return {
      crossings: total,
      offenderCount: offenderCount,
      crowd: crowd,
      topOffender: topVertex,
      topOffenderCc: topCc,
      freeze: freeze,
      dwell: dwell,
      trend: trend,
      thaw: thaw,
      drop: drop
    };
  }

  // ===========================================================================
  // SECTION: REGIME METRICS (assembly layer — "which regime(s) are we in?")
  // Composes existing signals (analysis + story metrics) into a per-move
  // description of lifecycle regime, so the algo can decide what to optimize.
  // See METRICS.md. NOT a predictor. Rollups (bulkReduction/nucleusBuilding) are
  // 0..1 and allowed to overlap — the overlap is the handoff zone.
  //   Tags: nucleus* + boundaryConcentration + crossingLoad + edgeLengthSlack are
  //   graph-state (algo-INDEPENDENT, durable); freeze/dwell/trend are the
  //   algo-BEHAVIOR "current runner has slowed" descriptors (algo-DEPENDENT).
  // ===========================================================================
  function createRegimeState(window) {
    return { W: window || 15, nucRing: [], move: 0 };
  }

  function computeRegimeMetrics(graph, analysis, storyMetrics, st) {
    var N = graph.nodes.length;
    st.move++;

    var nucleusFraction = N > 0 ? (analysis.largestCleanRegion || 0) / N : 0;
    var best = analysis.bestEstablishedRegion;
    var nucleusSolidity = best ? (best.density || 0) : 0;   // cheap O(E) proxy

    // nucleus growth over the trailing window W
    st.nucRing.push(nucleusFraction);
    if (st.nucRing.length > st.W + 1) st.nucRing.shift();
    var nucleusGrowth = nucleusFraction - st.nucRing[0];

    // boundary concentration: of the offenders, what fraction sit on the
    // nucleus frontier (adjacent to a nucleus vertex)? high => growing the
    // nucleus resolves the crossings; low => they're scattered elsewhere.
    var crossingCounts = analysis.crossingCounts || [];
    var nucleusSet = {};
    if (best && best.vertices) best.vertices.forEach(function(v) { nucleusSet[v] = true; });
    var frontier = {};
    if (best && best.vertices && best.vertices.length) {
      var idx = new Map();
      for (var i = 0; i < N; i++) idx.set(graph.nodes[i], i);
      graph.links.forEach(function(l) {
        var a = idx.get(l[0]), b = idx.get(l[1]);
        if (nucleusSet[a] && !nucleusSet[b]) frontier[b] = true;
        else if (nucleusSet[b] && !nucleusSet[a]) frontier[a] = true;
      });
    }
    var offenders = 0, boundaryOffenders = 0;
    for (var v = 0; v < N; v++) {
      if ((crossingCounts[v] || 0) > 0) { offenders++; if (frontier[v]) boundaryOffenders++; }
    }
    var boundaryConcentration = offenders > 0 ? boundaryOffenders / offenders : 0;

    // bulk-reduction side
    var crossings = analysis.crossings || 0;
    var crossingLoad = crossings / (crossings + N);
    var el = analysis.edgeLengthByDegree;
    var edgeLengthSlack = el ? (el.maxRelativeLength || 0) : 0;   // provisional/untested

    // heuristic rollups (tunable): both may be high => the handoff overlap zone
    var bulkReduction = crossingLoad;
    var nucleusBuilding = nucleusFraction * (0.5 + 0.5 * nucleusSolidity);

    return {
      bulkReduction: bulkReduction,
      nucleusBuilding: nucleusBuilding,
      // nucleus-building components (graph-state / algo-independent)
      nucleusFraction: nucleusFraction,
      nucleusSolidity: nucleusSolidity,
      nucleusGrowth: nucleusGrowth,
      boundaryConcentration: boundaryConcentration,
      // bulk-reduction components
      crossings: crossings,
      crossingLoad: crossingLoad,
      edgeLengthSlack: edgeLengthSlack,
      // algo-behavior "runner slowed" descriptors (algo-dependent, from story)
      freeze: storyMetrics ? storyMetrics.freeze : null,
      dwell: storyMetrics ? storyMetrics.dwell : null,
      trend: storyMetrics ? storyMetrics.trend : null
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
            var componentSet = {};
            component.forEach(function(index) { componentSet[index] = true; });
            var inside = component.filter(function(index) {
              return pointInTriangle(graph.nodes[index], triPoints[0], triPoints[1], triPoints[2]);
            }).length;
            var componentBoundaryCrossings = 0;
            graph.links.forEach(function(link) {
              var linkA = graph.nodes.indexOf(link[0]);
              var linkB = graph.nodes.indexOf(link[1]);
              if (!componentSet[linkA] && !componentSet[linkB]) return;
              triangleEdges.forEach(function(triangleEdge) {
                if (intersect(link, triangleEdge)) componentBoundaryCrossings++;
              });
            });
            return {
              vertices: component,
              insideCount: inside,
              outsideCount: component.length - inside,
              boundaryCrossings: componentBoundaryCrossings,
              side: inside === component.length ? 'inside' :
                inside === 0 ? 'outside' : 'straddling'
            };
          });

          triangles.push({
            vertices: [a, b, c],
            boundaryCrossings: triangleEdges.filter(function(edge) {
              return edge.intersection;
            }).length,
            components: classified
          });
        }
      }
    }

    triangles.sort(function(x, y) {
      var xStraddling = x.components.filter(function(c) { return c.side === 'straddling'; }).length;
      var yStraddling = y.components.filter(function(c) { return c.side === 'straddling'; }).length;
      return y.boundaryCrossings - x.boundaryCrossings ||
        yStraddling - xStraddling ||
        Math.min.apply(null, x.components.map(function(c) { return c.vertices.length; })) -
        Math.min.apply(null, y.components.map(function(c) { return c.vertices.length; }));
    });
    return triangles;
  }

  function triangleInteriorGrid(graph, triangleVertices) {
    var a = graph.nodes[triangleVertices[0]];
    var b = graph.nodes[triangleVertices[1]];
    var c = graph.nodes[triangleVertices[2]];
    var grid = [];
    [9, 12, 15].forEach(function(divisions) {
      for (var weightA = 1; weightA < divisions; weightA++) {
        for (var weightB = 1; weightB < divisions - weightA; weightB++) {
          var weightC = divisions - weightA - weightB;
          if (weightC < 1) continue;
          grid.push([
            (a[0] * weightA + b[0] * weightB + c[0] * weightC) / divisions,
            (a[1] * weightA + b[1] * weightB + c[1] * weightC) / divisions
          ]);
        }
      }
    });
    return grid;
  }

  function containedSubgraph(graph, triangleVertices, componentVertices, positions) {
    var allowed = {};
    triangleVertices.concat(componentVertices).forEach(function(index) {
      allowed[index] = true;
    });
    var nodes = graph.nodes.map(function(node, index) {
      var position = positions && positions[index] ? positions[index] : node;
      return [position[0], position[1]];
    });
    var links = [];
    graph.links.forEach(function(link) {
      var a = graph.nodes.indexOf(link[0]);
      var b = graph.nodes.indexOf(link[1]);
      if (allowed[a] && allowed[b]) links.push([nodes[a], nodes[b]]);
    });
    return { nodes: nodes, links: links };
  }

  function validContainedPosition(positions, movable, fixed, vertex, point, spacing) {
    var vertices = movable.concat(fixed);
    for (var i = 0; i < vertices.length; i++) {
      var other = vertices[i];
      if (other === vertex) continue;
      var dx = positions[other][0] - point[0];
      var dy = positions[other][1] - point[1];
      if (Math.sqrt(dx * dx + dy * dy) < spacing) return false;
    }
    return true;
  }

  // When a clean separating triangle contains every remaining crossing, the
  // exterior is topologically irrelevant. Solve only the induced interior
  // subgraph, holding the triangle fixed and rejecting every position outside
  // it. Deterministic restarts allow temporary setbacks in the full move
  // sequence, but execution is accepted only for a projected complete solve.
  function suggestContainedTriangleSolve(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 140;
    var baseCrossings = intersections(graph.links);
    var componentLimit = options.componentLimit || 10;
    var restartLimit = options.restartLimit || 40;
    var passLimit = options.passLimit || 24;
    var spacing = options.spacing || 0.012;
    var triangles = findSeparatingTriangles(graph);
    var candidates = [];
    var tested = 0;

    if (baseCrossings === 0 ||
        baseCrossings > (options.crossingLimit || 15)) {
      return {
        type: 'contained-triangle-solve-search',
        baseCrossings: baseCrossings,
        trianglesInspected: 0,
        candidatesTested: 0,
        elapsedMs: 0,
        timedOut: false,
        best: null,
        candidates: []
      };
    }

    for (var triangleIndex = 0; triangleIndex < triangles.length &&
        now() - startedAt < timeBudgetMs; triangleIndex++) {
      var triangle = triangles[triangleIndex];
      if (triangle.boundaryCrossings !== 0) continue;
      var insideComponents = triangle.components.filter(function(component) {
        return component.side === 'inside' &&
          component.boundaryCrossings === 0 &&
          component.vertices.length <= componentLimit;
      });

      for (var componentIndex = 0; componentIndex < insideComponents.length &&
          now() - startedAt < timeBudgetMs; componentIndex++) {
        var component = insideComponents[componentIndex];
        var initialSubgraph = containedSubgraph(
          graph, triangle.vertices, component.vertices);
        var subgraphCrossings = intersections(initialSubgraph.links);
        if (subgraphCrossings !== baseCrossings) continue;

        var grid = triangleInteriorGrid(graph, triangle.vertices);
        var bestPositions = null;
        var bestCrossings = baseCrossings;
        var solvedRestart = null;

        for (var restart = 0; restart < restartLimit &&
            now() - startedAt < timeBudgetMs; restart++) {
          var positions = graph.nodes.map(function(node) {
            return [node[0], node[1]];
          });

          for (var movableIndex = 0; movableIndex < component.vertices.length;
              movableIndex++) {
            var vertex = component.vertices[movableIndex];
            for (var attempt = 0; attempt < grid.length; attempt++) {
              var gridIndex = (restart * 23 + movableIndex * 47 + attempt * 13) %
                grid.length;
              var point = grid[gridIndex];
              if (!validContainedPosition(
                  positions, component.vertices, triangle.vertices, vertex,
                  point, spacing)) continue;
              positions[vertex] = point.slice();
              break;
            }
          }

          var currentCrossings = intersections(containedSubgraph(
            graph, triangle.vertices, component.vertices, positions).links);
          for (var pass = 0; pass < passLimit && currentCrossings > 0 &&
              now() - startedAt < timeBudgetMs; pass++) {
            var improved = false;
            for (var vertexIndex = 0; vertexIndex < component.vertices.length &&
                now() - startedAt < timeBudgetMs; vertexIndex++) {
              var movingVertex = component.vertices[vertexIndex];
              var vertexBest = positions[movingVertex];
              var vertexBestCrossings = currentCrossings;
              for (var candidateIndex = 0; candidateIndex < grid.length;
                  candidateIndex++) {
                var candidatePoint = grid[
                  (candidateIndex + restart * 7) % grid.length];
                if (!validContainedPosition(
                    positions, component.vertices, triangle.vertices,
                    movingVertex, candidatePoint, spacing)) continue;
                var previous = positions[movingVertex];
                positions[movingVertex] = candidatePoint;
                var candidateCrossings = intersections(containedSubgraph(
                  graph, triangle.vertices, component.vertices, positions).links);
                positions[movingVertex] = previous;
                tested++;
                if (candidateCrossings < vertexBestCrossings) {
                  vertexBestCrossings = candidateCrossings;
                  vertexBest = candidatePoint.slice();
                  if (candidateCrossings === 0) break;
                }
              }
              positions[movingVertex] = vertexBest;
              if (vertexBestCrossings < currentCrossings) {
                currentCrossings = vertexBestCrossings;
                improved = true;
              }
              if (currentCrossings === 0) break;
            }
            if (!improved) break;
          }

          if (currentCrossings < bestCrossings) {
            bestCrossings = currentCrossings;
            bestPositions = positions;
          }
          if (currentCrossings === 0) {
            solvedRestart = restart;
            bestPositions = positions;
            break;
          }
        }

        if (!bestPositions) continue;
        var proposedPositions = component.vertices.map(function(index) {
          return {
            index: index,
            x: bestPositions[index][0],
            y: bestPositions[index][1]
          };
        });
        var fullSimulation = cloneGraph(graph);
        applyGroupPositions(fullSimulation, proposedPositions);
        var fullCrossings = intersections(fullSimulation.links);
        candidates.push({
          type: 'contained-triangle-solve',
          strategy: 'stage3-contained-triangle-solve',
          objective: 'solve interior component [' + component.vertices.join(',') +
            '] inside fixed separator [' + triangle.vertices.join(',') + ']',
          triangle: triangle.vertices,
          component: component.vertices,
          positions: proposedPositions,
          baseCrossings: baseCrossings,
          subgraphCrossings: subgraphCrossings,
          finalCrossings: fullCrossings,
          restart: solvedRestart,
          accepted: fullCrossings === 0,
          score: fullCrossings * 1000 + component.vertices.length
        });
      }
    }

    candidates.sort(function(a, b) {
      return a.score - b.score || a.component.length - b.component.length;
    });
    return {
      type: 'contained-triangle-solve-search',
      baseCrossings: baseCrossings,
      trianglesInspected: triangles.length,
      candidatesTested: tested,
      elapsedMs: now() - startedAt,
      timedOut: now() - startedAt >= timeBudgetMs,
      best: candidates.length > 0 && candidates[0].accepted
        ? candidates[0] : null,
      candidates: candidates.slice(0, 5)
    };
  }

  function transformComponent(graph, component, target, targetCenter, scale, rotation) {
    var center = [0, 0];
    rotation = rotation || 0;
    var cosRotation = Math.cos(rotation);
    var sinRotation = Math.sin(rotation);
    component.forEach(function(index) {
      center[0] += graph.nodes[index][0];
      center[1] += graph.nodes[index][1];
    });
    center[0] /= component.length;
    center[1] /= component.length;

    return component.map(function(index) {
      var dx = graph.nodes[index][0] - center[0];
      var dy = graph.nodes[index][1] - center[1];
      var x = targetCenter[0] +
        (dx * cosRotation - dy * sinRotation) * scale;
      var y = targetCenter[1] +
        (dx * sinRotation + dy * cosRotation) * scale;
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
    var simulationSteps = options.simulationSteps === undefined ? 15 : options.simulationSteps;
    var maxComponentSize = options.maxComponentSize || Infinity;
    var expandedInsidePlacements = !!options.expandedInsidePlacements;
    var requireComponentBoundaryCrossing = !!options.requireComponentBoundaryCrossing;

    for (var ti = 0; ti < triangles.length && candidates.length < candidateLimit; ti++) {
      var triangle = triangles[ti];
      var triPoints = triangle.vertices.map(function(index) { return graph.nodes[index]; });
      var triCenter = [
        (triPoints[0][0] + triPoints[1][0] + triPoints[2][0]) / 3,
        (triPoints[0][1] + triPoints[1][1] + triPoints[2][1]) / 3
      ];

      for (var ci = 0; ci < triangle.components.length && candidates.length < candidateLimit; ci++) {
        var component = triangle.components[ci];
        if (component.vertices.length > maxComponentSize) continue;
        if (requireComponentBoundaryCrossing && component.boundaryCrossings === 0) continue;
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
          var insideCenters = [triCenter];
          var insideScales = [Math.min(0.2, 0.5 / Math.sqrt(component.vertices.length))];
          var insideRotations = [0];
          if (expandedInsidePlacements) {
            // Narrow triangles and uneven attachment geometry often require
            // placing the component away from the exact centroid or rotating
            // it before it fits without internal/boundary crossings.
            insideCenters = [];
            var barycentricDivisions = 8;
            for (var weightA = 1; weightA < barycentricDivisions - 1; weightA++) {
              for (var weightB = 1; weightB < barycentricDivisions - weightA;
                  weightB++) {
                var weightC = barycentricDivisions - weightA - weightB;
                if (weightC < 1) continue;
                insideCenters.push([
                  (triPoints[0][0] * weightA + triPoints[1][0] * weightB +
                    triPoints[2][0] * weightC) / barycentricDivisions,
                  (triPoints[0][1] * weightA + triPoints[1][1] * weightB +
                    triPoints[2][1] * weightC) / barycentricDivisions
                ]);
              }
            }
            insideScales = [0.2, 0.1, 0.05];
            insideRotations = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
          }
          for (var centerIndex = 0; centerIndex < insideCenters.length; centerIndex++) {
            for (var scaleIndex = 0; scaleIndex < insideScales.length; scaleIndex++) {
              for (var rotationIndex = 0; rotationIndex < insideRotations.length;
                  rotationIndex++) {
                targets.push({
                  side: 'inside',
                  center: insideCenters[centerIndex],
                  scale: insideScales[scaleIndex],
                  rotation: insideRotations[rotationIndex]
                });
              }
            }
          }
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
            scale: Math.min(0.65, 1.2 / Math.sqrt(component.vertices.length)),
            rotation: 0
          });
        }

        for (var targetIndex = 0; targetIndex < targets.length; targetIndex++) {
          var target = targets[targetIndex];
          var positions = transformComponent(
            graph, component.vertices, target.side, target.center, target.scale,
            target.rotation);
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
            boundaryCrossings: triangle.boundaryCrossings,
            componentBoundaryCrossings: component.boundaryCrossings,
            component: component.vertices,
            fromSide: component.side,
            toSide: target.side,
            placementCenter: target.center,
            placementScale: target.scale,
            placementRotation: target.rotation || 0,
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

  // Conservative Stage 3 finisher: when a near-solved graph has a small
  // component attached through a separating triangle, move that complete
  // component across the triangle only if the group move directly reduces
  // crossings. The returned positions are executed consecutively by
  // solverStep so Stage 1 cannot interrupt a temporarily awkward first move.
  function findSeparatingTriangleFinisher(graph, options) {
    options = options || {};
    var baseCrossings = intersections(graph.links);
    if (baseCrossings === 0 || baseCrossings > (options.crossingLimit || 12)) {
      return null;
    }

    var report = suggestStage2Move(graph, {
      triangleLimit: options.triangleLimit || 20,
      candidateLimit: options.candidateLimit || 600,
      simulationSteps: 0,
      maxComponentSize: options.componentLimit || 6,
      expandedInsidePlacements: true,
      requireComponentBoundaryCrossing: true
    });
    var candidate = report.candidates.filter(function(item) {
      return item.componentBoundaryCrossings > 0 &&
        item.component.length <= (options.componentLimit || 6) &&
        item.immediateCrossings < baseCrossings;
    }).sort(function(a, b) {
      return a.immediateCrossings - b.immediateCrossings ||
        a.component.length - b.component.length;
    })[0];
    if (!candidate) return null;

    return {
      strategy: 'finisher-separating-triangle',
      triangle: candidate.triangle,
      component: candidate.component,
      positions: candidate.positions,
      moveCount: candidate.positions.length,
      baseCrossings: baseCrossings,
      finalCrossings: candidate.immediateCrossings,
      improvement: baseCrossings - candidate.immediateCrossings,
      boundaryCrossings: candidate.boundaryCrossings,
      componentBoundaryCrossings: candidate.componentBoundaryCrossings,
      placementCenter: candidate.placementCenter,
      placementScale: candidate.placementScale,
      placementRotation: candidate.placementRotation,
      fromSide: candidate.fromSide,
      toSide: candidate.toSide
    };
  }

  // One-move Stage 3 lookahead. A small setup move can expose the correct
  // separating-triangle geometry even when it temporarily adds crossings.
  // Accept only when the setup followed by the complete finisher improves the
  // original graph.
  function findSeparatingTriangleFinisherLookahead(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 90;
    var damageLimit = options.damageLimit === undefined ? 3 : options.damageLimit;
    var baseCrossings = intersections(graph.links);
    if (baseCrossings === 0 || baseCrossings > (options.crossingLimit || 12)) {
      return null;
    }

    var candidateSet = {};
    for (var i = 0; i < graph.links.length; i++) {
      for (var j = i + 1; j < graph.links.length; j++) {
        if (!intersect(graph.links[i], graph.links[j])) continue;
        [graph.links[i][0], graph.links[i][1], graph.links[j][0], graph.links[j][1]]
          .forEach(function(node) {
            candidateSet[nodeIndexOf(graph, node)] = true;
          });
      }
    }
    var candidateVertices = Object.keys(candidateSet).map(Number).slice(0,
      options.vertexLimit || 10);
    var directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];
    var distances = options.distances || [0.04, 0.08, 0.16];
    var tested = 0;
    var best = null;

    for (var vi = 0; vi < candidateVertices.length; vi++) {
      var vertexIndex = candidateVertices[vi];
      var sourceNode = graph.nodes[vertexIndex];
      for (var di = 0; di < directions.length; di++) {
        for (var si = 0; si < distances.length; si++) {
          if (now() - startedAt >= timeBudgetMs) break;
          var distance = distances[si];
          var normalizer = directions[di][0] !== 0 && directions[di][1] !== 0
            ? Math.sqrt(2) : 1;
          var toX = Math.max(0.02, Math.min(0.98,
            sourceNode[0] + directions[di][0] * distance / normalizer));
          var toY = Math.max(0.02, Math.min(0.98,
            sourceNode[1] + directions[di][1] * distance / normalizer));
          if (isTooClose(graph, sourceNode, toX, toY)) continue;

          var simulation = cloneGraph(graph);
          simulation.nodes[vertexIndex][0] = toX;
          simulation.nodes[vertexIndex][1] = toY;
          var setupCrossings = intersections(simulation.links);
          var setupDamage = setupCrossings - baseCrossings;
          tested++;
          if (setupDamage > damageLimit) continue;

          var finisher = findSeparatingTriangleFinisher(simulation, options);
          if (!finisher || finisher.finalCrossings >= baseCrossings) continue;
          applyGroupPositions(simulation, finisher.positions);
          var cleanupState = {};
          var cleanupSteps = 0;
          var projectedFinalCrossings = intersections(simulation.links);
          while (cleanupSteps < (options.cleanupSteps || 3) &&
              projectedFinalCrossings > 0) {
            var cleanupMove = findAdaptiveMinimizeMove(simulation, cleanupState, {
              candidateLimit: 8,
              randomSamples: 0,
              strongImprovement: Infinity
            });
            if (!cleanupMove) break;
            cleanupMove.node[0] = cleanupMove.toX;
            cleanupMove.node[1] = cleanupMove.toY;
            projectedFinalCrossings = intersections(simulation.links);
            cleanupSteps++;
          }
          if (projectedFinalCrossings !== 0) continue;

          var score = finisher.finalCrossings * 100 + setupDamage * 5 +
            finisher.component.length;
          if (!best || score < best.score) {
            best = {
              strategy: 'finisher-separating-triangle-lookahead',
              positions: [{
                index: vertexIndex,
                x: toX,
                y: toY
              }].concat(finisher.positions),
              moveCount: finisher.positions.length + 1,
              setupVertex: vertexIndex,
              setupCrossings: setupCrossings,
              setupDamage: setupDamage,
              triangle: finisher.triangle,
              component: finisher.component,
              baseCrossings: baseCrossings,
              finalCrossings: finisher.finalCrossings,
              projectedFinalCrossings: projectedFinalCrossings,
              projectedCleanupSteps: cleanupSteps,
              improvement: baseCrossings - finisher.finalCrossings,
              boundaryCrossings: finisher.boundaryCrossings,
              componentBoundaryCrossings: finisher.componentBoundaryCrossings,
              placementCenter: finisher.placementCenter,
              placementScale: finisher.placementScale,
              placementRotation: finisher.placementRotation,
              fromSide: finisher.fromSide,
              toSide: finisher.toSide,
              testedSetups: tested,
              elapsedMs: now() - startedAt,
              score: score
            };
            if (finisher.finalCrossings === 0 && setupDamage <= 0) return best;
          }
        }
        if (now() - startedAt >= timeBudgetMs) break;
      }
      if (now() - startedAt >= timeBudgetMs) break;
    }
    if (best) {
      best.testedSetups = tested;
      best.elapsedMs = now() - startedAt;
    }
    return best;
  }

  function takePendingFinisherMove(graph, state) {
    if (!state.pendingFinisher || state.pendingFinisher.positions.length === 0) {
      state.pendingFinisher = null;
      return null;
    }
    var plan = state.pendingFinisher;
    var position = plan.positions.shift();
    var node = graph.nodes[position.index];
    var move = {
      node: node,
      nodeIndex: position.index,
      fromX: node[0],
      fromY: node[1],
      toX: position.x,
      toY: position.y,
      improvement: 0,
      strategy: plan.strategy,
      search: {
        triangle: plan.triangle,
        component: plan.component,
        boundaryCrossings: plan.boundaryCrossings,
        componentBoundaryCrossings: plan.componentBoundaryCrossings,
        setupVertex: plan.setupVertex === undefined ? null : plan.setupVertex,
        setupCrossings: plan.setupCrossings === undefined ? null : plan.setupCrossings,
        setupDamage: plan.setupDamage === undefined ? null : plan.setupDamage,
        testedSetups: plan.testedSetups === undefined ? null : plan.testedSetups,
        lookaheadElapsedMs: plan.elapsedMs === undefined ? null : plan.elapsedMs,
        projectedFinalCrossings: plan.projectedFinalCrossings === undefined
          ? null : plan.projectedFinalCrossings,
        projectedCleanupSteps: plan.projectedCleanupSteps === undefined
          ? null : plan.projectedCleanupSteps,
        placementCenter: plan.placementCenter,
        placementScale: plan.placementScale,
        placementRotation: plan.placementRotation,
        groupCrossingsBefore: plan.baseCrossings,
        predictedGroupCrossingsAfter: plan.finalCrossings,
        groupMoveNumber: (plan.moveCount || plan.component.length) - plan.positions.length,
        groupMoveCount: plan.moveCount || plan.component.length
      }
    };
    if (plan.positions.length === 0) state.pendingFinisher = null;
    return move;
  }

  function applyStage2Suggestion(graph, suggestion) {
    if (!suggestion || !suggestion.positions) return false;
    applyGroupPositions(graph, suggestion.positions);
    intersections(graph.links);
    return true;
  }

  function structuralPlanSummary(plan) {
    if (!plan) return null;
    return {
      id: plan.id,
      type: plan.type,
      objective: plan.objective,
      status: plan.status,
      startedAtCrossings: plan.startedAtCrossings,
      projectedFinalCrossings: plan.projectedFinalCrossings,
      movableVertices: plan.movableVertices,
      protectedVertices: plan.protectedVertices,
      direction: plan.direction,
      separator: plan.separator,
      completionCondition: plan.completionCondition,
      maxSteps: plan.maxSteps,
      steps: plan.steps || 0,
      baseMetrics: plan.baseMetrics || null,
      setupMetrics: plan.setupMetrics || null,
      projectedMetrics: plan.projectedMetrics || null
    };
  }

  function beginStructuralPlan(state, details) {
    state.structuralPlanSequence = (state.structuralPlanSequence || 0) + 1;
    state.activeStructuralPlan = {
      id: state.structuralPlanSequence,
      type: details.type,
      objective: details.objective,
      status: 'active',
      startedAtCrossings: details.startedAtCrossings,
      projectedFinalCrossings: details.projectedFinalCrossings,
      movableVertices: (details.movableVertices || []).slice(),
      protectedVertices: (details.protectedVertices || []).slice(),
      direction: details.direction || null,
      separator: details.separator || null,
      completionCondition: details.completionCondition || null,
      maxSteps: details.maxSteps || 12,
      steps: 0,
      baseMetrics: details.baseMetrics || null,
      setupMetrics: details.setupMetrics || null,
      projectedMetrics: details.projectedMetrics || null
    };
    return state.activeStructuralPlan;
  }

  function attachStructuralPlan(state, move) {
    if (!move || !state.activeStructuralPlan) return move;
    state.activeStructuralPlan.steps++;
    move.search = move.search || {};
    move.search.structuralPlan = structuralPlanSummary(state.activeStructuralPlan);
    return move;
  }

  function updateStructuralPlan(state, crossingCount) {
    var plan = state.activeStructuralPlan;
    if (!plan) return;
    if (crossingCount === 0 ||
        (!state.pendingStructuralMoves &&
          ((plan.completionCondition === 'compaction-complete') ||
           (plan.completionCondition === 'projected-solve' &&
            crossingCount <= plan.projectedFinalCrossings) ||
           (plan.completionCondition === 'productive-handoff' &&
            crossingCount <= plan.projectedFinalCrossings)))) {
      plan.status = 'completed';
      state.lastStructuralPlan = structuralPlanSummary(plan);
      state.activeStructuralPlan = null;
    } else if (plan.steps >= plan.maxSteps) {
      plan.status = 'failed';
      state.lastStructuralPlan = structuralPlanSummary(plan);
      state.activeStructuralPlan = null;
    }
  }

  function takePendingStructuralMove(graph, state) {
    if (!state.pendingStructuralMoves ||
        state.pendingStructuralMoves.length === 0) {
      state.pendingStructuralMoves = null;
      return null;
    }
    var position = state.pendingStructuralMoves.shift();
    var node = graph.nodes[position.index];
    var move = {
      node: node,
      nodeIndex: position.index,
      fromX: node[0],
      fromY: node[1],
      toX: position.x,
      toY: position.y,
      improvement: 0,
      strategy: state.activeStructuralPlan &&
        state.activeStructuralPlan.type === 'region-extension'
        ? 'stage2-region-extension' :
        state.activeStructuralPlan &&
          state.activeStructuralPlan.type === 'region-compaction'
          ? 'region-compaction-' + (position.mode || 'advance') :
        state.activeStructuralPlan &&
          state.activeStructuralPlan.type === 'contained-triangle-solve'
          ? 'stage3-contained-triangle-solve' :
        state.activeStructuralPlan &&
          state.activeStructuralPlan.type === 'dominant-barrier-transfer'
          ? 'stage3-dominant-barrier-transfer' :
        state.activeStructuralPlan &&
          state.activeStructuralPlan.type === 'anchor-break-barrier-transfer'
          ? 'stage2-anchor-break-barrier-transfer' :
        state.activeStructuralPlan &&
          state.activeStructuralPlan.type === 'stage1c-reset'
          ? 'stage1c-reset' : 'stage2-proven-solve',
      search: {
        reason: state.pendingStructuralReason || null,
        projectedFinalCrossings: state.activeStructuralPlan
          ? state.activeStructuralPlan.projectedFinalCrossings : null
      }
    };
    if (state.pendingStructuralMoves.length === 0) {
      state.pendingStructuralMoves = null;
      state.pendingStructuralReason = null;
    }
    return attachStructuralPlan(state, move);
  }

  function startAnchorBreakBarrierPlan(graph, state, count, anchorBreak,
      anchorBreakReport) {
    beginStructuralPlan(state, {
      type: 'anchor-break-barrier-transfer',
      objective: anchorBreak.reason,
      startedAtCrossings: count,
      projectedFinalCrossings: anchorBreak.finalCrossings,
      movableVertices: anchorBreak.component,
      protectedVertices: anchorBreak.barrier,
      separator: anchorBreak.barrier,
      completionCondition: 'productive-handoff',
      maxSteps: anchorBreak.positions.length + 4,
      baseMetrics: {
        crossings: count
      },
      projectedMetrics: {
        transferCrossings: anchorBreak.transferCrossings,
        finalCrossings: anchorBreak.finalCrossings,
        peakCrossings: anchorBreak.peakCrossings,
        repairSteps: anchorBreak.repairSteps,
        downstreamImprovement: anchorBreak.downstreamImprovement,
        barrierCrossings: anchorBreak.barrierCrossings
      }
    });
    state.pendingStructuralMoves = anchorBreak.positions.slice();
    state.pendingStructuralReason = anchorBreak.reason;
    var move = takePendingStructuralMove(graph, state);
    move.search.anchorBreakBarrier = {
      barrier: anchorBreak.barrier,
      component: anchorBreak.component,
      barrierCrossings: anchorBreak.barrierCrossings,
      crossingEdges: anchorBreak.crossingEdges,
      sourceAnchorBreaks: anchorBreak.sourceAnchorBreaks,
      targetAnchorBreaks: anchorBreak.targetAnchorBreaks,
      componentAnchorBreaks: anchorBreak.componentAnchorBreaks,
      cleanAnchorBreaks: anchorBreak.cleanAnchorBreaks,
      immediateCrossings: anchorBreak.immediateCrossings,
      transferCrossings: anchorBreak.transferCrossings,
      finalCrossings: anchorBreak.finalCrossings,
      finalDamage: anchorBreak.finalDamage,
      peakCrossings: anchorBreak.peakCrossings,
      repairSteps: anchorBreak.repairSteps,
      downstreamImprovement: anchorBreak.downstreamImprovement,
      candidatesTested: anchorBreakReport.candidatesTested,
      rejected: anchorBreakReport.rejected,
      elapsedMs: anchorBreakReport.elapsedMs
    };
    move.node[0] = move.toX;
    move.node[1] = move.toY;
    recordMove(state, move.nodeIndex, move.toX, move.toY);
    var newCount = intersections(graph.links);
    move.improvement = count - newCount;
    state.stuckCount = 0;
    state.recentAttempts = {};
    state.finisherAttemptedAtCount = null;
    return {
      move: move,
      count: newCount,
      improved: newCount < count
    };
  }

  function componentKey(vertices) {
    return vertices.slice().sort(function(a, b) { return a - b; }).join(',');
  }

  function findTriangleComponent(triangles, triangleVertices, componentVertices) {
    var triangleKey = componentKey(triangleVertices);
    var targetComponentKey = componentKey(componentVertices);
    for (var i = 0; i < triangles.length; i++) {
      if (componentKey(triangles[i].vertices) !== triangleKey) continue;
      for (var j = 0; j < triangles[i].components.length; j++) {
        if (componentKey(triangles[i].components[j].vertices) === targetComponentKey) {
          return triangles[i].components[j];
        }
      }
    }
    return null;
  }

  function bestEstablishedScore(analysis) {
    return analysis.bestEstablishedRegion ? analysis.bestEstablishedRegion.score : 0;
  }

  // Diagnostic-only Stage 2 candidate search. When a small component crosses
  // a separating triangle boundary, test reshaping the triangle around the
  // component by moving one boundary vertex. This deliberately evaluates
  // structural gain even when the immediate crossing count does not improve.
  function suggestSeparatorReshape(graph, options) {
    options = options || {};
    var startedAt = now();
    var timeBudgetMs = options.timeBudgetMs || 250;
    var baseAnalysis = analyzeGraphState(graph, {});
    var baseCrossings = baseAnalysis.crossings;
    var baseEstablishedScore = bestEstablishedScore(baseAnalysis);
    var componentLimit = options.componentLimit || 8;
    var triangleLimit = options.triangleLimit || 16;
    var candidateLimit = options.candidateLimit || 120;
    var triangles = findSeparatingTriangles(graph).slice(0, triangleLimit);
    var candidates = [];
    var tested = 0;
    var timedOut = false;

    for (var ti = 0; ti < triangles.length && tested < candidateLimit &&
        now() - startedAt < timeBudgetMs; ti++) {
      var triangle = triangles[ti];
      for (var ci = 0; ci < triangle.components.length && tested < candidateLimit &&
          now() - startedAt < timeBudgetMs; ci++) {
        var component = triangle.components[ci];
        if (component.boundaryCrossings === 0 ||
            component.vertices.length > componentLimit) {
          continue;
        }

        var componentCenter = [0, 0];
        var componentRadius = 0;
        component.vertices.forEach(function(index) {
          componentCenter[0] += graph.nodes[index][0];
          componentCenter[1] += graph.nodes[index][1];
        });
        componentCenter[0] /= component.vertices.length;
        componentCenter[1] /= component.vertices.length;
        component.vertices.forEach(function(index) {
          var dx = graph.nodes[index][0] - componentCenter[0];
          var dy = graph.nodes[index][1] - componentCenter[1];
          componentRadius = Math.max(componentRadius, Math.sqrt(dx * dx + dy * dy));
        });

        for (var vi = 0; vi < triangle.vertices.length && tested < candidateLimit &&
            now() - startedAt < timeBudgetMs; vi++) {
          var vertexIndex = triangle.vertices[vi];
          var otherVertices = triangle.vertices.filter(function(index) {
            return index !== vertexIndex;
          });
          var otherMidpoint = [
            (graph.nodes[otherVertices[0]][0] + graph.nodes[otherVertices[1]][0]) / 2,
            (graph.nodes[otherVertices[0]][1] + graph.nodes[otherVertices[1]][1]) / 2
          ];
          var dx = componentCenter[0] - otherMidpoint[0];
          var dy = componentCenter[1] - otherMidpoint[1];
          var length = Math.sqrt(dx * dx + dy * dy);
          if (length < 1e-8) continue;
          dx /= length;
          dy /= length;

          var baseDistance = Math.max(componentRadius + 0.04,
            Math.sqrt(
              Math.pow(componentCenter[0] - otherMidpoint[0], 2) +
              Math.pow(componentCenter[1] - otherMidpoint[1], 2)
            ) * 0.55);
          [1, 1.35, 1.7].forEach(function(scale) {
            if (tested >= candidateLimit ||
                now() - startedAt >= timeBudgetMs) return;
            var toX = Math.max(0.02, Math.min(0.98,
              componentCenter[0] + dx * baseDistance * scale));
            var toY = Math.max(0.02, Math.min(0.98,
              componentCenter[1] + dy * baseDistance * scale));
            if (isTooClose(graph, graph.nodes[vertexIndex], toX, toY)) return;
            tested++;

            var simulation = cloneGraph(graph);
            simulation.nodes[vertexIndex][0] = toX;
            simulation.nodes[vertexIndex][1] = toY;
            var finalAnalysis = analyzeGraphState(simulation, {});
            var finalTriangles = findSeparatingTriangles(simulation);
            var finalComponent = findTriangleComponent(
              finalTriangles, triangle.vertices, component.vertices);
            if (!finalComponent) return;

            var boundaryReduction = component.boundaryCrossings -
              finalComponent.boundaryCrossings;
            var resolvedStraddling = component.side === 'straddling' &&
              finalComponent.side !== 'straddling' ? 1 : 0;
            var enclosedComponent = component.side !== 'inside' &&
              finalComponent.side === 'inside' ? 1 : 0;
            if (boundaryReduction <= 0 && !resolvedStraddling && !enclosedComponent) {
              return;
            }

            var establishedDelta = bestEstablishedScore(finalAnalysis) -
              baseEstablishedScore;
            var cleanDelta = finalAnalysis.cleanVertices - baseAnalysis.cleanVertices;
            var crossingImprovement = baseCrossings - finalAnalysis.crossings;
            var displacement = Math.sqrt(
              Math.pow(toX - graph.nodes[vertexIndex][0], 2) +
              Math.pow(toY - graph.nodes[vertexIndex][1], 2));
            var disruption = anchorScore(graph, graph.nodes[vertexIndex]) *
              (1 + displacement * 4);
            var score = boundaryReduction * 12 + resolvedStraddling * 10 +
              enclosedComponent * 4 + establishedDelta * 3 + cleanDelta * 2 +
              crossingImprovement - disruption * 2;

            candidates.push({
              type: 'separator-reshape',
              strategy: 'diagnostic-separator-reshape',
              component: [vertexIndex],
              positions: [{ index: vertexIndex, x: toX, y: toY }],
              triangle: triangle.vertices,
              affectedComponent: component.vertices,
              fromSide: component.side,
              toSide: finalComponent.side,
              componentBoundaryCrossingsBefore: component.boundaryCrossings,
              componentBoundaryCrossingsAfter: finalComponent.boundaryCrossings,
              boundaryReduction: boundaryReduction,
              resolvedStraddling: resolvedStraddling,
              enclosedComponent: enclosedComponent,
              immediateCrossings: finalAnalysis.crossings,
              immediateDamage: Math.max(0, finalAnalysis.crossings - baseCrossings),
              finalCrossings: finalAnalysis.crossings,
              downstreamImprovement: crossingImprovement,
              cleanDelta: cleanDelta,
              establishedDelta: establishedDelta,
              anchorDisruption: disruption,
              simulationSteps: 0,
              score: score,
              reason: 'reshape separator [' + triangle.vertices.join(',') +
                '] around component [' + component.vertices.join(',') + ']'
            });
          });
        }
      }
    }
    timedOut = now() - startedAt >= timeBudgetMs;

    candidates.sort(function(a, b) {
      return b.score - a.score ||
        b.boundaryReduction - a.boundaryReduction ||
        b.establishedDelta - a.establishedDelta;
    });
    return {
      type: 'separator-reshape',
      baseCrossings: baseCrossings,
      trianglesInspected: triangles.length,
      candidatesTested: tested,
      elapsedMs: now() - startedAt,
      timeBudgetMs: timeBudgetMs,
      timedOut: timedOut,
      best: candidates.length > 0 && candidates[0].score > 0 ? candidates[0] : null,
      candidates: candidates.slice(0, 5)
    };
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
    var startedAt = now();
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
        var incidentNeighborIndex = nodeIndexOf(graph, incidentNeighbor);
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
      if (now() - startedAt >= timeBudgetMs) {
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
      while (steps < simulationSteps && now() - startedAt < timeBudgetMs) {
        if (!deterministicMinimizeStep(simulation, simulationState)) break;
        steps++;
      }
      if (now() - startedAt >= timeBudgetMs) timedOut = true;

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
      elapsedMs: now() - startedAt,
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
        var nodeIdx = nodeIndexOf(graph, node);
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
      var nodeIdx = nodeIndexOf(graph, node);
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
      var i = nodeIndexOf(graph, node);
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
        var nodeIdx = nodeIndexOf(graph, node);
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
      var nodeIdx = nodeIndexOf(graph, node);
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
          vertices: [nodeIndexOf(graph, edge[0]), nodeIndexOf(graph, edge[1])],
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
    var i = nodeIndexOf(graph, node);
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
      var boundaryDx = pos[0] - origX;
      var boundaryDy = pos[1] - origY;
      if (boundaryDx * boundaryDx + boundaryDy * boundaryDy < 1e-10) continue;
      if (isTooClose(graph, node, pos[0], pos[1])) continue;
      
      var improvement = -evaluateMoveDelta(graph, node, pos[0], pos[1], count);
      
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
    var centroidDx = wc ? wc[0] - origX : 0;
    var centroidDy = wc ? wc[1] - origY : 0;
    if (wc && centroidDx * centroidDx + centroidDy * centroidDy >= 1e-10 &&
        !isTooClose(graph, node, wc[0], wc[1])) {
      var improvement = -evaluateMoveDelta(graph, node, wc[0], wc[1], count);
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
    
    // Only accept escape moves that don't make things catastrophically worse
    // Allowing small degradation (-5) for escape, but not huge jumps
    if (bestMove && bestMove.improvement >= -5) return bestMove;
    
    // Fallback: try random positions, but still check they don't make things much worse
    for (var r = 0; r < 10; r++) {
      var newX = 0.02 + Math.random() * 0.96;
      var newY = 0.02 + Math.random() * 0.96;
      
      if (isTooClose(graph, node, newX, newY)) continue;
      
      var improvement = -evaluateMoveDelta(graph, node, newX, newY, count);
      
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

  // Shared descent pass: test a candidate list against a per-vertex probe
  // spec (centroid, half-centroid, N local directions at a shared random
  // angle, and optional random samples). Used by both the main list and the
  // big list inside findAdaptiveMinimizeMove.
  function runDescentPass(ctx, candidates, spec) {
    var graph = ctx.graph;
    var state = ctx.state;
    var strongImprovement = ctx.strongImprovement;
    var theta = ctx.theta;
    var prefix = spec.strategyPrefix;

    var bestMove = null;
    var bestImprovement = 0;
    var positionsTested = 0;
    var deterministicTested = 0;
    var randomTested = 0;

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

    // Deterministic phase: centroid, half-centroid, then N evenly-spaced
    // local probes rotated by the shared per-call random angle.
    for (var r = 0; r < candidates.length; r++) {
      var item = candidates[r];
      var node = item.node;
      var edges = getNodeEdges(graph, node);
      var crossingsBefore = countEdgeCrossings(graph, edges);
      var neighbors = getNeighbors(graph, node);

      if (spec.centroid && neighbors.length > 0) {
        var cx = 0, cy = 0;
        for (var n = 0; n < neighbors.length; n++) {
          cx += neighbors[n][0];
          cy += neighbors[n][1];
        }
        cx /= neighbors.length;
        cy /= neighbors.length;

        deterministicTested++;
        if (testPosition(item, edges, crossingsBefore, cx, cy, prefix + 'centroid')) break;
        if (spec.half) {
          deterministicTested++;
          if (testPosition(item, edges, crossingsBefore,
              node[0] + (cx - node[0]) * 0.5,
              node[1] + (cy - node[1]) * 0.5,
              prefix + 'centroid-half')) break;
        }
      }

      var step = (Math.PI * 2) / spec.localDirs;
      for (var d = 0; d < spec.localDirs; d++) {
        var angle = theta + d * step;
        deterministicTested++;
        if (testPosition(item, edges, crossingsBefore,
            node[0] + Math.cos(angle) * 0.04,
            node[1] + Math.sin(angle) * 0.04,
            prefix + 'local')) break;
      }
      if (bestImprovement >= strongImprovement) break;
    }

    // Random phase fires only if the deterministic phase did not clear the
    // short-circuit threshold.
    if (bestImprovement < strongImprovement && spec.randomSamples > 0) {
      for (var r2 = 0; r2 < candidates.length; r2++) {
        var item2 = candidates[r2];
        var edges2 = getNodeEdges(graph, item2.node);
        var crossingsBefore2 = countEdgeCrossings(graph, edges2);
        for (var s = 0; s < spec.randomSamples; s++) {
          randomTested++;
          if (testPosition(item2, edges2, crossingsBefore2,
              0.05 + Math.random() * 0.9,
              0.05 + Math.random() * 0.9,
              prefix + 'random')) break;
        }
        if (bestImprovement >= strongImprovement) break;
      }
    }

    return {
      move: bestMove,
      positionsTested: positionsTested,
      deterministicTested: deterministicTested,
      randomTested: randomTested,
      bestImprovement: bestImprovement
    };
  }

  // Focused Stage 1 descent. Two disjoint candidate lists per call:
  //   - Main list: top 18 by score, cheap probe (centroid + half + 3 local + 1 random).
  //   - Big list: top 12 by score, expensive probe (centroid + half + 8 local
  //     + 5 random). Fires once every `bigListInterval` calls (default 8).
  // The same score (crossings*2 + crossings/degree - repeatPenalty) ranks
  // both lists; the big list takes the top slice, the main list takes the
  // next slice. A random angle is sampled per call and shared by both lists'
  // local probes. Short-circuit on strongImprovement resets the big-list
  // counter so we don't fire it again until we're back in slow-grind.
  function findAdaptiveMinimizeMove(graph, state, options) {
    state = state || {};
    options = options || {};

    var count = intersections(graph.links);
    if (count === 0) return null;

    var bigListLimit = options.bigListLimit || 12;
    var mainListLimit = options.mainListLimit || 18;
    var bigListInterval = options.bigListInterval || 8;
    var strongImprovement = options.strongImprovement ||
      Math.max(3, Math.ceil(count * 0.03));

    var crossingCounts = getCrossingCounts(graph);
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

    // Big list temporarily disabled — main list draws from the full top of
    // the ranked pool. runDescentPass + big-list spec retained for re-enable.
    var mainList = ranked.slice(0, mainListLimit);

    var theta = options.theta === undefined
      ? Math.random() * Math.PI * 2
      : options.theta;

    var ctx = {
      graph: graph,
      state: state,
      count: count,
      strongImprovement: strongImprovement,
      theta: theta
    };

    var listKind = 'main';
    var candidatesUsed = mainList;
    var result = runDescentPass(ctx, mainList, {
      centroid: true,
      half: true,
      localDirs: 3,
      randomSamples: 1,
      strategyPrefix: 'adaptive-'
    });

    var attempt = {
      crossingCount: count,
      listKind: listKind,
      candidateVertices: candidatesUsed.map(function(item) { return item.index; }),
      positionsTested: result.positionsTested,
      deterministicTested: result.deterministicTested,
      randomTested: result.randomTested,
      strongImprovementTarget: strongImprovement,
      bestImprovement: result.bestImprovement,
      theta: theta,
      exhausted: !result.move
    };
    state.lastMinimizeAttempt = attempt;

    // Rolling per-call stats for later inspection.
    state.adaptiveStatsBuffer = state.adaptiveStatsBuffer || [];
    state.adaptiveStatsBuffer.push({
      kind: listKind,
      candidates: candidatesUsed.length,
      positionsTested: result.positionsTested,
      foundMove: !!result.move,
      improvement: result.bestImprovement,
      crossingsBefore: count
    });
    if (state.adaptiveStatsBuffer.length > 100) {
      state.adaptiveStatsBuffer.shift();
    }

    if (result.move) result.move.search = attempt;
    return result.move;
  }

  function externalAnchorCentroidForGroup(graph, group) {
    var inGroup = {};
    group.forEach(function(index) { inGroup[index] = true; });
    var points = [];
    group.forEach(function(index) {
      getNeighbors(graph, graph.nodes[index]).forEach(function(neighbor) {
        var neighborIndex = graph.nodes.indexOf(neighbor);
        if (neighborIndex >= 0 && !inGroup[neighborIndex]) {
          points.push(neighbor);
        }
      });
    });
    return centroid(points);
  }

  function groupResetPositions(graph, group, targetCenter, scale) {
    var groupNodes = group.map(function(index) { return graph.nodes[index]; });
    var center = centroid(groupNodes);
    if (!center || !targetCenter) return null;
    return group.map(function(index) {
      var node = graph.nodes[index];
      return {
        index: index,
        x: Math.max(0.02, Math.min(0.98,
          targetCenter[0] + (node[0] - center[0]) * scale)),
        y: Math.max(0.02, Math.min(0.98,
          targetCenter[1] + (node[1] - center[1]) * scale))
      };
    });
  }

  function uniqueGroup(indices, limit) {
    var seen = {};
    var result = [];
    for (var i = 0; i < indices.length && result.length < limit; i++) {
      var index = indices[i];
      if (index < 0 || seen[index]) continue;
      seen[index] = true;
      result.push(index);
    }
    return result;
  }

  function groupKey(group) {
    return group.slice().sort(function(a, b) { return a - b; }).join(',');
  }

  function pointDistance(a, b) {
    var dx = a[0] - b[0];
    var dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function graphEdgeLengths(graph) {
    return graph.links.map(function(link) {
      return pointDistance(link[0], link[1]);
    });
  }

  function incidentLengthProfile(graph, group) {
    var inGroup = {};
    group.forEach(function(index) { inGroup[index] = true; });
    var lengths = [];
    for (var i = 0; i < graph.links.length; i++) {
      var a = graph.nodes.indexOf(graph.links[i][0]);
      var b = graph.nodes.indexOf(graph.links[i][1]);
      if (inGroup[a] || inGroup[b]) {
        lengths.push(pointDistance(graph.links[i][0], graph.links[i][1]));
      }
    }
    var sum = lengths.reduce(function(total, value) {
      return total + value;
    }, 0);
    return {
      count: lengths.length,
      sum: sum,
      average: lengths.length ? sum / lengths.length : 0,
      max: lengths.length ? Math.max.apply(null, lengths) : 0
    };
  }

  function lengthDeltaProfile(beforeGraph, afterGraph, group) {
    var before = incidentLengthProfile(beforeGraph, group);
    var after = incidentLengthProfile(afterGraph, group);
    var graphMedian = median(graphEdgeLengths(beforeGraph));
    return {
      before: before,
      after: after,
      averageDelta: after.average - before.average,
      averageDeltaPct: before.average
        ? (after.average - before.average) / before.average : 0,
      sumDelta: after.sum - before.sum,
      sumDeltaPct: before.sum ? (after.sum - before.sum) / before.sum : 0,
      maxDelta: after.max - before.max,
      maxDeltaPct: before.max ? (after.max - before.max) / before.max : 0,
      maxRelativeBefore: graphMedian ? before.max / graphMedian : 0,
      maxRelativeAfter: graphMedian ? after.max / graphMedian : 0
    };
  }

  function degreeBucket(degree) {
    if (degree <= 5) return String(degree);
    if (degree <= 8) return '6-8';
    return '9+';
  }

  function analyzeEdgeLengthByDegree(graph, adjacency) {
    var epsilon = 1e-6;
    var lengths = graphEdgeLengths(graph);
    var graphMedian = median(lengths);
    var totalLength = 0;
    var totalLogLength = 0;
    var maxLength = 0;
    for (var i = 0; i < lengths.length; i++) {
      totalLength += lengths[i];
      totalLogLength += Math.log(epsilon + lengths[i]);
      if (lengths[i] > maxLength) maxLength = lengths[i];
    }

    var buckets = {};
    var vertexAvgIncidentLogLengthSum = 0;
    var verticesWithIncidentEdges = 0;
    for (var v = 0; v < graph.nodes.length; v++) {
      var incident = getNodeEdges(graph, graph.nodes[v]).map(function(edge) {
        return pointDistance(edge[0], edge[1]);
      });
      if (incident.length === 0) continue;
      verticesWithIncidentEdges++;
      var sum = incident.reduce(function(total, value) {
        return total + value;
      }, 0);
      var logSum = incident.reduce(function(total, value) {
        return total + Math.log(epsilon + value);
      }, 0);
      vertexAvgIncidentLogLengthSum += logSum / incident.length;
      var vertexMax = Math.max.apply(null, incident);
      var bucketKey = degreeBucket(adjacency[v].length);
      if (!buckets[bucketKey]) {
        buckets[bucketKey] = {
          vertices: 0,
          degreeSum: 0,
          avgIncidentLengthSum: 0,
          avgIncidentLogLengthSum: 0,
          maxIncidentLengthSum: 0,
          maxIncidentLength: 0
        };
      }
      var bucket = buckets[bucketKey];
      bucket.vertices++;
      bucket.degreeSum += adjacency[v].length;
      bucket.avgIncidentLengthSum += sum / incident.length;
      bucket.avgIncidentLogLengthSum += logSum / incident.length;
      bucket.maxIncidentLengthSum += vertexMax;
      if (vertexMax > bucket.maxIncidentLength) {
        bucket.maxIncidentLength = vertexMax;
      }
    }

    var orderedBuckets = ['1', '2', '3', '4', '5', '6-8', '9+']
      .filter(function(key) { return buckets[key]; })
      .map(function(key) {
        var bucket = buckets[key];
        return {
          bucket: key,
          vertices: bucket.vertices,
          averageDegree: bucket.degreeSum / bucket.vertices,
          avgIncidentLength: bucket.avgIncidentLengthSum / bucket.vertices,
          avgIncidentLogLength:
            bucket.avgIncidentLogLengthSum / bucket.vertices,
          avgMaxIncidentLength:
            bucket.maxIncidentLengthSum / bucket.vertices,
          maxIncidentLength: bucket.maxIncidentLength,
          avgIncidentRelativeLength: graphMedian
            ? (bucket.avgIncidentLengthSum / bucket.vertices) / graphMedian
            : 0,
          maxIncidentRelativeLength: graphMedian
            ? bucket.maxIncidentLength / graphMedian : 0
        };
      });

    return {
      edgeCount: lengths.length,
      medianLength: graphMedian,
      averageLength: lengths.length ? totalLength / lengths.length : 0,
      averageLogLength: lengths.length ? totalLogLength / lengths.length : 0,
      vertexAverageIncidentLogLength: verticesWithIncidentEdges
        ? vertexAvgIncidentLogLengthSum / verticesWithIncidentEdges : 0,
      maxLength: maxLength,
      maxRelativeLength: graphMedian ? maxLength / graphMedian : 0,
      buckets: orderedBuckets
    };
  }

  function stage1Rollout(graph, maxSteps) {
    var state = {};
    var moves = [];
    for (var step = 0; step < maxSteps; step++) {
      var move = findAdaptiveMinimizeMove(graph, state, {
        mainListLimit: 18,
        randomSamples: 0,
        theta: 0
      });
      if (!move || move.improvement <= 0) break;
      move.node[0] = move.toX;
      move.node[1] = move.toY;
      var crossingsAfter = intersections(graph.links);
      moves.push({
        vertex: move.nodeIndex,
        x: move.toX,
        y: move.toY,
        strategy: move.strategy,
        improvement: move.improvement,
        crossingsAfter: crossingsAfter
      });
    }
    return {
      moves: moves,
      finalCrossings: intersections(graph.links),
      lastAttempt: state.lastMinimizeAttempt || null
    };
  }

  function stage1Probe(graph) {
    var state = {};
    var move = findAdaptiveMinimizeMove(graph, state, {
      mainListLimit: 18,
      randomSamples: 0,
      theta: 0
    });
    return {
      found: !!move,
      bestImprovement: state.lastMinimizeAttempt
        ? state.lastMinimizeAttempt.bestImprovement : 0,
      positionsTested: state.lastMinimizeAttempt
        ? state.lastMinimizeAttempt.positionsTested : 0,
      vertex: move ? move.nodeIndex : null,
      strategy: move ? move.strategy : null
    };
  }

  // Stage 1c diagnostic: try a tiny grouped reset, then ask whether ordinary
  // Stage 1 descent becomes productive again. This is intentionally not called
  // by solverStep yet; Interactive uses it as an inspect/apply tool.
  function suggestStage1cResetPlan(graph, options) {
    options = options || {};
    var started = now();
    var timeBudgetMs = options.timeBudgetMs || 300;
    var maxGroupSize = options.maxGroupSize || 4;
    var minGroupSize = options.minGroupSize || 1;
    var seedLimit = options.seedLimit === undefined ? 14 : options.seedLimit;
    var geometricSeedLimit = options.geometricSeedLimit === undefined
      ? 28 : options.geometricSeedLimit;
    var cleanupSteps = options.cleanupSteps || 25;
    var baseCrossings = intersections(graph.links);
    var beforeProbe = stage1Probe(cloneGraph(graph));
    var crossingCounts = getCrossingCounts(graph);
    var ranked = [];

    for (var i = 0; i < graph.nodes.length; i++) {
      if (crossingCounts[i] <= 0) continue;
      var degree = getNodeEdges(graph, graph.nodes[i]).length;
      ranked.push({
        index: i,
        crossings: crossingCounts[i],
        degree: degree,
        score: crossingCounts[i] * 2 + crossingCounts[i] / Math.max(1, degree)
      });
    }
    ranked.sort(function(a, b) {
      return b.score - a.score || a.degree - b.degree;
    });

    var candidatesGenerated = 0;
    var candidatesTested = 0;
    var timedOut = false;
    var best = null;
    var candidates = [];
    var scales = options.scales || [0.45, 0.65, 0.85, 1.0];
    var targetBlends = options.targetBlends || [0.5, 0.8, 1.0, 1.2];
    var minAcceptNetGain = options.minAcceptNetGain === undefined
      ? 1 : options.minAcceptNetGain;
    var maxImmediateDamage = options.maxImmediateDamage;
    var testedGroups = {};

    function evaluatePositions(group, positions, reason) {
      if (!positions || now() - started > timeBudgetMs) {
        timedOut = true;
        return;
      }
      candidatesTested++;
      var simulation = cloneGraph(graph);
      applyGroupPositions(simulation, positions);
      var immediateCrossings = intersections(simulation.links);
      var immediateDamage = immediateCrossings - baseCrossings;
      if (maxImmediateDamage !== undefined &&
          immediateDamage > maxImmediateDamage) {
        return;
      }
      var lengthProfile = lengthDeltaProfile(graph, simulation, group);
      var afterProbe = stage1Probe(cloneGraph(simulation));
      if (!afterProbe.found && afterProbe.bestImprovement <= 0) return;

      var rollout = stage1Rollout(simulation, cleanupSteps);
      var finalCrossings = rollout.finalCrossings;
      var netGain = baseCrossings - finalCrossings;
      var recoveryGain = immediateCrossings - finalCrossings;
      var score = netGain * 12 + recoveryGain +
        afterProbe.bestImprovement * 4 -
        Math.max(0, immediateDamage) * 0.35 -
        group.length * 2 -
        Math.max(0, lengthProfile.maxDeltaPct) * 80 -
        Math.max(0, lengthProfile.averageDeltaPct) * 45 +
        Math.min(0.6, Math.max(0, -lengthProfile.maxDeltaPct)) * 35 +
        Math.min(0.5, Math.max(0, -lengthProfile.averageDeltaPct)) * 20;
      if (netGain <= 0 && recoveryGain < Math.max(10, immediateDamage * 0.5)) {
        score -= 1000;
      }

      var candidate = {
          strategy: 'stage1c-group-reset',
          reason: reason,
          group: group.slice(),
          scheduledMoves: positions.map(function(position) {
            return {
              index: position.index,
              x: position.x,
              y: position.y,
              mode: 'group-reset'
            };
          }),
          baseCrossings: baseCrossings,
          immediateCrossings: immediateCrossings,
          immediateDamage: immediateDamage,
          finalCrossings: finalCrossings,
          netGain: netGain,
          recoveryGain: recoveryGain,
          rolloutMoves: rollout.moves.length,
          rollout: rollout.moves.slice(0, 12),
          beforeProbe: beforeProbe,
          afterProbe: afterProbe,
          lengthProfile: lengthProfile,
          score: score,
          accepted: netGain >= minAcceptNetGain
        };
      candidates.push(candidate);
      candidates.sort(function(a, b) {
        return b.score - a.score;
      });
      if (candidates.length > (options.keepCandidates || 10)) {
        candidates.length = options.keepCandidates || 10;
      }

      if (candidate.accepted && (!best || score > best.score)) {
        best = candidate;
      }
    }

    function evaluateGroup(group, reason) {
      if (group.length < minGroupSize) return;
      group = uniqueGroup(group, maxGroupSize);
      if (group.length < minGroupSize) return;
      var key = groupKey(group);
      if (testedGroups[key]) return;
      testedGroups[key] = true;

      var anchor = externalAnchorCentroidForGroup(graph, group);
      if (!anchor) return;
      var groupCenter = centroid(group.map(function(index) {
        return graph.nodes[index];
      }));
      for (var b = 0; b < targetBlends.length; b++) {
        var blend = targetBlends[b];
        var target = [
          groupCenter[0] + (anchor[0] - groupCenter[0]) * blend,
          groupCenter[1] + (anchor[1] - groupCenter[1]) * blend
        ];
        for (var s = 0; s < scales.length; s++) {
          candidatesGenerated++;
          evaluatePositions(group,
            groupResetPositions(graph, group, target, scales[s]),
            reason);
          if (timedOut) break;
        }
        if (timedOut) break;
      }
    }

    for (var r = 0; r < Math.min(seedLimit, ranked.length); r++) {
      if (now() - started > timeBudgetMs) {
        timedOut = true;
        break;
      }
      var seed = ranked[r];
      var neighborItems = getNeighbors(graph, graph.nodes[seed.index]).map(function(node) {
        var index = graph.nodes.indexOf(node);
        return {
          index: index,
          crossings: crossingCounts[index] || 0,
          degree: getNodeEdges(graph, node).length
        };
      }).filter(function(item) {
        return item.index >= 0 && item.index !== seed.index;
      }).sort(function(a, b) {
        return b.crossings - a.crossings || a.degree - b.degree;
      });

      var baseGroup = uniqueGroup([seed.index].concat(
        neighborItems.map(function(item) { return item.index; })), maxGroupSize);
      for (var size = minGroupSize; size <= baseGroup.length; size++) {
        evaluateGroup(baseGroup.slice(0, size),
          'move graph-neighbor group toward external-anchor centroid');
        if (timedOut) break;
      }
    }

    for (var gr = 0; gr < Math.min(geometricSeedLimit, ranked.length); gr++) {
      if (timedOut || now() - started > timeBudgetMs) {
        timedOut = true;
        break;
      }
      var geometricSeed = ranked[gr];
      var nearby = ranked.filter(function(item) {
        return item.index !== geometricSeed.index;
      }).map(function(item) {
        return {
          index: item.index,
          distance: pointDistance(
            graph.nodes[geometricSeed.index], graph.nodes[item.index]),
          crossings: item.crossings,
          degree: item.degree
        };
      }).sort(function(a, b) {
        return a.distance - b.distance ||
          b.crossings - a.crossings || a.degree - b.degree;
      });

      var nearest = nearby.map(function(item) { return item.index; });
      for (var gsize = minGroupSize; gsize <= maxGroupSize; gsize++) {
        evaluateGroup([geometricSeed.index].concat(nearest.slice(0, gsize - 1)),
          'move geometric crossing clump toward external-anchor centroid');
        if (timedOut) break;
      }

      // Try a tight core plus one slightly farther companion. This catches
      // player-visible "hanging group" cases where three vertices are almost
      // coincident and the fourth is an outlying member of the same patch.
      if (!timedOut && maxGroupSize >= 4 && nearest.length >= 5) {
        for (var out = 3; out < Math.min(8, nearest.length); out++) {
          evaluateGroup([geometricSeed.index, nearest[0], nearest[1], nearest[out]],
            'move tight geometric core plus outlier toward external anchors');
          if (timedOut) break;
        }
      }
    }

    return {
      baseCrossings: baseCrossings,
      beforeProbe: beforeProbe,
      best: best,
      candidates: candidates,
      candidatesGenerated: candidatesGenerated,
      candidatesTested: candidatesTested,
      elapsedMs: now() - started,
      timeBudgetMs: timeBudgetMs,
      timedOut: timedOut,
      seedVertices: ranked.slice(0, seedLimit).map(function(item) {
        return {
          vertex: item.index,
          crossings: item.crossings,
          degree: item.degree,
          score: item.score
        };
      })
    };
  }

  function suggestCascadeTriggerMove(graph, state, options) {
    state = state || {};
    options = options || {};
    var started = now();
    var timeBudgetMs = options.timeBudgetMs || 90;
    var baseCrossings = intersections(graph.links);
    if (baseCrossings === 0) return null;

    var beforeCounts = getCrossingCounts(graph);
    var story = state.storyMetrics || {};
    var ranked = beforeCounts.map(function(count, index) {
      return {
        index: index,
        crossings: count,
        streak: state.storyState && state.storyState.streak
          ? (state.storyState.streak[index] || 0) : 0,
        score: count * 3 +
          (story.topOffender === index ? 8 : 0) +
          (state.storyState && state.storyState.streak
            ? Math.min(10, state.storyState.streak[index] || 0) * 0.5 : 0)
      };
    }).filter(function(item) {
      return item.crossings > 0 || item.streak >= 8 ||
        story.topOffender === item.index;
    }).sort(function(a, b) {
      return b.score - a.score;
    }).slice(0, options.vertexLimit || 8);

    var best = null;
    var tested = 0;
    var seen = {};

    function addPosition(positions, x, y) {
      x = Math.max(0.02, Math.min(0.98, x));
      y = Math.max(0.02, Math.min(0.98, y));
      var key = x.toFixed(3) + ',' + y.toFixed(3);
      if (seen[key]) return;
      seen[key] = true;
      positions.push([x, y]);
    }

    for (var ri = 0; ri < ranked.length &&
        now() - started < timeBudgetMs; ri++) {
      var item = ranked[ri];
      var node = graph.nodes[item.index];
      var positions = [];
      seen = {};
      var neighbors = getNeighbors(graph, node);
      var wc = weightedCentroid(graph, node);
      if (wc) addPosition(positions, wc[0], wc[1]);
      if (neighbors.length) {
        var cx = 0, cy = 0;
        neighbors.forEach(function(neighbor) {
          cx += neighbor[0];
          cy += neighbor[1];
        });
        cx /= neighbors.length;
        cy /= neighbors.length;
        addPosition(positions, cx, cy);
        addPosition(positions, (node[0] + cx) / 2, (node[1] + cy) / 2);
      }

      var radii = [0.07, 0.13, 0.22];
      for (var sector = 0; sector < 8; sector++) {
        var angle = Math.PI * 2 * sector / 8;
        for (var rr = 0; rr < radii.length; rr++) {
          addPosition(positions,
            node[0] + Math.cos(angle) * radii[rr],
            node[1] + Math.sin(angle) * radii[rr]);
        }
      }
      [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95],
       [0.5, 0.05], [0.5, 0.95], [0.05, 0.5], [0.95, 0.5]]
        .forEach(function(pos) {
          addPosition(positions, pos[0], pos[1]);
        });

      for (var pi = 0; pi < positions.length &&
          now() - started < timeBudgetMs; pi++) {
        var pos = positions[pi];
        if (isTooClose(graph, node, pos[0], pos[1]) ||
            wouldOscillate(state, item.index, pos[0], pos[1])) {
          continue;
        }
        tested++;

        var simulation = cloneGraph(graph);
        simulation.nodes[item.index][0] = pos[0];
        simulation.nodes[item.index][1] = pos[1];
        var immediateCrossings = intersections(simulation.links);
        var afterCounts = getCrossingCounts(simulation);
        var maxDrop = 0;
        var thaw = 0;
        for (var ci = 0; ci < beforeCounts.length; ci++) {
          var drop = (beforeCounts[ci] || 0) - (afterCounts[ci] || 0);
          if (drop > maxDrop) maxDrop = drop;
          if ((beforeCounts[ci] || 0) > 0 && (afterCounts[ci] || 0) === 0) {
            thaw++;
          }
        }
        var movedDrop = (beforeCounts[item.index] || 0) -
          (afterCounts[item.index] || 0);
        var immediateImprovement = baseCrossings - immediateCrossings;
        var immediateDamage = Math.max(0, immediateCrossings - baseCrossings);

        // Cheap prefilter: we are looking for a cascade seed, not another tiny
        // local twitch. It should de-conflict at least one meaningful offender
        // or immediately lower crossings.
        if (immediateImprovement <= 0 && maxDrop < 4 && thaw < 2) continue;

        var rollout = stage1Rollout(simulation, options.rolloutSteps || 12);
        var finalCrossings = rollout.finalCrossings;
        var downstreamImprovement = baseCrossings - finalCrossings;
        var score = downstreamImprovement * 12 + immediateImprovement * 3 +
          maxDrop * 5 + movedDrop * 2 + thaw * 3 -
          immediateDamage * 4 - rollout.moves.length * 0.25;
        var accepted = finalCrossings < baseCrossings &&
          (downstreamImprovement >= (options.requiredImprovement || 2) ||
           finalCrossings === 0) &&
          immediateDamage <= (options.maxImmediateDamage === undefined
            ? Math.max(4, Math.ceil(baseCrossings * 0.3))
            : options.maxImmediateDamage);
        var candidate = {
          node: node,
          nodeIndex: item.index,
          fromX: node[0],
          fromY: node[1],
          toX: pos[0],
          toY: pos[1],
          improvement: immediateImprovement,
          strategy: 'wasted-tail-cascade-trigger',
          search: {
            reason: 'wasted-tail cascade trigger: maximize drop/thaw before cleanup',
            baseCrossings: baseCrossings,
            immediateCrossings: immediateCrossings,
            finalCrossings: finalCrossings,
            downstreamImprovement: downstreamImprovement,
            immediateDamage: immediateDamage,
            maxDrop: maxDrop,
            movedDrop: movedDrop,
            thaw: thaw,
            rolloutMoves: rollout.moves.length,
            candidateVertices: ranked.map(function(r) { return r.index; }),
            candidatesTested: tested,
            elapsedMs: now() - started,
            score: score,
            accepted: accepted,
            storyMetrics: story
          }
        };
        if (accepted && (!best || candidate.search.score > best.search.score)) {
          best = candidate;
        }
      }
    }

    state.lastCascadeTriggerSearch = {
      type: 'wasted-tail-cascade-trigger-search',
      baseCrossings: baseCrossings,
      candidateVertices: ranked.map(function(item) { return item.index; }),
      candidatesTested: tested,
      elapsedMs: now() - started,
      best: best ? best.search : null
    };
    return best;
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
    if (state.bestCrossingCount === undefined || count < state.bestCrossingCount) {
      state.bestCrossingCount = count;
      state.movesSinceCrossingProgress = 0;
    } else {
      state.movesSinceCrossingProgress = (state.movesSinceCrossingProgress || 0) + 1;
    }
    recordCrossingHistory(state, count);
    updateStructuralPlan(state, count);
    
    if (count === 0) {
      return { done: true, count: 0 };
    }
    
    var best = null;

    // Complete a proven structural setup before allowing Stage 1 to react to
    // an intermediate position.
    best = takePendingStructuralMove(graph, state);
    if (best) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      recordMove(state, best.nodeIndex, best.toX, best.toY);
      var newCount = intersections(graph.links);
      best.improvement = count - newCount;
      return { done: false, improved: newCount < count, move: best, count: newCount };
    }

    // Complete an already accepted component relocation before allowing other
    // strategies to react to its intermediate geometry.
    best = takePendingFinisherMove(graph, state);
    if (best) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      recordMove(state, best.nodeIndex, best.toX, best.toY);
      var newCount = intersections(graph.links);
      best.improvement = count - newCount;
      return {
        done: false,
        improved: newCount < count,
        move: attachStructuralPlan(state, best),
        count: newCount
      };
    }

    // A clean anchor break is a stronger signal than generic compaction: the
    // crossed side has a clean stopping point, so a bounded component transfer
    // can be completed and locally repaired before Stage 1 reacts to temporary
    // motor-control crossings.
    if (!state.activeStructuralPlan && graph.nodes.length <= 100 &&
        count <= 120 && state.movesSinceCrossingProgress >= 8 &&
        state.cleanAnchorBreakAttemptedAtBestCrossings !==
          state.bestCrossingCount) {
      state.cleanAnchorBreakAttemptedAtBestCrossings =
        state.bestCrossingCount;
      var cleanAnchorBreakReport = profileSection(
        'clean-anchor-break-barrier-search',
        function() {
          return suggestAnchorBreakBarrierTransfer(graph, {
            timeBudgetMs: 250,
            componentLimit: 40,
            barrierLimit: 14,
            cleanupSteps: 24,
            keepCandidates: 6
          });
        });
      state.lastAnchorBreakBarrierSearch = cleanAnchorBreakReport;
      var cleanAnchorBreak = cleanAnchorBreakReport.best;
      var hasCleanComponentBreak = cleanAnchorBreak &&
        cleanAnchorBreak.cleanAnchorBreaks &&
        cleanAnchorBreak.cleanAnchorBreaks.length > 0;
      if (hasCleanComponentBreak &&
          cleanAnchorBreak.finalDamage === 0 &&
          cleanAnchorBreak.finalCrossings < count) {
        var cleanAnchorBreakResult = startAnchorBreakBarrierPlan(
          graph, state, count, cleanAnchorBreak, cleanAnchorBreakReport);
        return {
          done: false,
          improved: cleanAnchorBreakResult.improved,
          move: cleanAnchorBreakResult.move,
          count: cleanAnchorBreakResult.count
        };
      }
    }

    // One conservative compaction attempt per stalled crossing minimum. The
    // complete advance/repair schedule runs as a structural plan so Stage 1
    // cannot interrupt the temporary geometry.
    // Manual play showed compaction unlocks at low crossings well before the
    // 40-stuck threshold — fire earlier when count <= 20.
    var compactionStalled = state.movesSinceCrossingProgress >= 40 ||
        (count <= 20 && state.movesSinceCrossingProgress >= 15);
    if (!state.disableCompaction && !state.activeStructuralPlan &&
        graph.nodes.length <= 60 &&
        compactionStalled &&
        state.compactionAttemptedAtBestCrossings !== state.bestCrossingCount) {
      state.compactionAttemptedAtBestCrossings = state.bestCrossingCount;
      var compactionReport = profileSection('region-compaction-search', function() {
        return suggestRegionCompactionPlan(graph, {
          timeBudgetMs: 600,
          cleanupSteps: 12,
          minRegionSize: 5
        });
      });
      state.lastCompactionSearch = compactionReport;
      if (compactionReport && compactionReport.best) {
        var compaction = compactionReport.best;
        beginStructuralPlan(state, {
          type: 'region-compaction',
          objective: compaction.reason,
          startedAtCrossings: count,
          projectedFinalCrossings: compaction.immediateCrossings,
          movableVertices: compaction.component,
          protectedVertices: compaction.component,
          completionCondition: 'compaction-complete',
          maxSteps: compaction.scheduledMoves.length + 2,
          baseMetrics: {
            crossings: count,
            regionSize: compaction.component.length
          },
          projectedMetrics: {
            crossings: compaction.immediateCrossings,
            scale: compaction.scale,
            peakScheduledCrossings: compaction.peakScheduledCrossings
          }
        });
        state.pendingStructuralMoves = compaction.scheduledMoves.map(function(move) {
          return {
            index: move.index,
            x: move.x,
            y: move.y,
            mode: move.mode
          };
        });
        state.pendingStructuralReason = compaction.reason;
        best = takePendingStructuralMove(graph, state);
        best.search.compaction = {
          scale: compaction.scale,
          regionSize: compaction.component.length,
          sequenceLength: compaction.scheduledMoves.length,
          peakScheduledCrossings: compaction.peakScheduledCrossings,
          protectedCrossings: compaction.protectedCrossings,
          boundaryCrossings: compaction.boundaryCrossings
        };
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        best.improvement = count - newCount;
        return {
          done: false,
          improved: newCount < count,
          move: best,
          count: newCount
        };
      }
    }

    best = profileSection('adaptive-minimize', function() {
      return findAdaptiveMinimizeMove(graph, state);
    });
    
    // If we found a valid move, apply it
    if (best) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      recordMove(state, best.nodeIndex, best.toX, best.toY);
      var newCount = intersections(graph.links);
      state.stuckCount = 0;
      state.recentAttempts = {};
      state.finisherAttemptedAtCount = null;
      return {
        done: false,
        improved: true,
        move: attachStructuralPlan(state, best),
        count: newCount
      };
    }

    // If a clean separating triangle contains every remaining crossing, solve
    // only that induced interior subproblem while holding the separator and
    // exterior fixed.
    if (!state.activeStructuralPlan && count <= 15 &&
        state.containedTriangleAttemptedAtCount !== count) {
      state.containedTriangleAttemptedAtCount = count;
      var containedReport = profileSection('contained-triangle-search', function() {
        return suggestContainedTriangleSolve(graph, {
          timeBudgetMs: 140,
          componentLimit: 10,
          restartLimit: 40
        });
      });
      state.lastContainedTriangleSearch = containedReport;
      if (containedReport.best) {
        var containedSolve = containedReport.best;
        beginStructuralPlan(state, {
          type: 'contained-triangle-solve',
          objective: containedSolve.objective,
          startedAtCrossings: count,
          projectedFinalCrossings: 0,
          movableVertices: containedSolve.component,
          protectedVertices: containedSolve.triangle,
          separator: containedSolve.triangle,
          completionCondition: 'projected-solve',
          maxSteps: containedSolve.positions.length + 3
        });
        state.pendingStructuralMoves = containedSolve.positions.slice();
        state.pendingStructuralReason = containedSolve.objective;
        best = takePendingStructuralMove(graph, state);
        best.search.containedTriangleSolve = {
          triangle: containedSolve.triangle,
          component: containedSolve.component,
          subgraphCrossings: containedSolve.subgraphCrossings,
          projectedFinalCrossings: containedSolve.finalCrossings,
          restart: containedSolve.restart,
          candidatesTested: containedReport.candidatesTested,
          elapsedMs: containedReport.elapsedMs
        };
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        best.improvement = count - newCount;
        state.stuckCount = 0;
        state.recentAttempts = {};
        return { done: false, improved: newCount < count, move: best, count: newCount };
      }
    }

    // Before zero-gain repositioning, try the narrowly proven late-game case
    // where a dominant crossed edge separates one small, coherently movable
    // side. Crossing-reducing Stage 1 moves still retain first priority.
    if (!state.activeStructuralPlan && count <= 15 &&
        state.barrierTransferAttemptedAtCount !== count) {
      state.barrierTransferAttemptedAtCount = count;
      var barrierReport = profileSection('dominant-barrier-search', function() {
        return suggestDominantBarrierTransfer(graph, {
          timeBudgetMs: 250,
          cleanupSteps: 30,
          maxGroupSize: 16
        });
      });
      state.lastBarrierTransferSearch = barrierReport;
      if (barrierReport.best) {
        var barrierTransfer = barrierReport.best;
        beginStructuralPlan(state, {
          type: 'dominant-barrier-transfer',
          objective: barrierTransfer.objective,
          startedAtCrossings: count,
          projectedFinalCrossings: 0,
          movableVertices: barrierTransfer.component,
          protectedVertices: barrierTransfer.barrier,
          direction: barrierTransfer.direction,
          separator: barrierTransfer.barrier,
          completionCondition: 'projected-solve',
          maxSteps: barrierTransfer.positions.length +
            barrierTransfer.cleanupSteps + 3
        });
        state.pendingStructuralMoves = barrierTransfer.positions.slice();
        state.pendingStructuralReason = barrierTransfer.objective;
        best = takePendingStructuralMove(graph, state);
        best.search.barrierTransfer = {
          barrier: barrierTransfer.barrier,
          barrierCrossings: barrierTransfer.barrierCrossings,
          barrierShare: barrierTransfer.barrierShare,
          component: barrierTransfer.component,
          direction: barrierTransfer.direction,
          distance: barrierTransfer.distance,
          anchors: barrierTransfer.anchors,
          immediateCrossings: barrierTransfer.immediateCrossings,
          immediateDamage: barrierTransfer.immediateDamage,
          projectedCleanupSteps: barrierTransfer.cleanupSteps
        };
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        best.improvement = count - newCount;
        state.stuckCount = 0;
        state.recentAttempts = {};
        return { done: false, improved: newCount < count, move: best, count: newCount };
      }
    }

    // Before escaping, try anchored centroid move
    // This uses weighted centroid that prioritizes fixed/yellow neighbors
    best = profileSection('anchored-centroid', function() {
      return findAnchoredCentroidMove(graph);
    });
    if (best && best.improvement >= 0) {
      if (wouldOscillate(state, best.nodeIndex, best.toX, best.toY)) {
        best = null;
      } else {
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        // Don't reset stuck count for zero-improvement moves
        if (best.improvement > 0) {
          state.stuckCount = 0;
          state.finisherAttemptedAtCount = null;
        }
        return {
          done: false,
          improved: best.improvement > 0,
          move: attachStructuralPlan(state, best),
          count: newCount
        };
      }
    }

    // Stage 1b: after ordinary geometric descent is genuinely exhausted, try
    // a few strictly reducing topological side flips, then return to Stage 1.
    best = profileSection('reducing-side-flip', function() {
      return findReducingSideFlipMove(graph, state);
    });
    if (best) {
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      recordMove(state, best.nodeIndex, best.toX, best.toY);
      state.sideFlipVertices[best.nodeIndex] = true;
      state.sideFlipMoves = (state.sideFlipMoves || 0) + 1;
      var newCount = intersections(graph.links);
      state.stuckCount = 0;
      state.recentAttempts = {};
      state.finisherAttemptedAtCount = null;
      return {
        done: false,
        improved: true,
        move: attachStructuralPlan(state, best),
        count: newCount
      };
    }

    // Stage 3: in a nearly solved graph, relocate a small component through a
    // crossed separating triangle when the complete group move is directly
    // crossing-reducing.
    var finisher = null;
    if (state.finisherAttemptedAtCount !== count) {
      state.finisherAttemptedAtCount = count;
      finisher = profileSection('separating-triangle-finisher', function() {
        return findSeparatingTriangleFinisher(graph);
      });
      if (!finisher && count <= 5 && (state.finisherLookaheadAttempts || 0) < 2) {
        state.finisherLookaheadAttempts = (state.finisherLookaheadAttempts || 0) + 1;
        finisher = profileSection('separating-triangle-lookahead', function() {
          return findSeparatingTriangleFinisherLookahead(graph, {
            crossingLimit: 5
          });
        });
      }
    }
    if (finisher) {
      state.pendingFinisher = finisher;
      best = takePendingFinisherMove(graph, state);
      best.node[0] = best.toX;
      best.node[1] = best.toY;
      recordMove(state, best.nodeIndex, best.toX, best.toY);
      var newCount = intersections(graph.links);
      best.improvement = count - newCount;
      state.stuckCount = 0;
      return {
        done: false,
        improved: newCount < count,
        move: attachStructuralPlan(state, best),
        count: newCount
      };
    }

    // Conservative automatic Stage 2: only commit a bounded restart when its
    // deterministic rollout projects a complete solve. Partial-progress
    // restarts remain suggestion-only in Interactive.
    if (count <= 15 && state.stage2SolveAttemptedAtCount !== count) {
      state.stage2SolveAttemptedAtCount = count;
      var provenRestart = profileSection('proven-stage2-restart', function() {
        return suggestStage2Restart(graph, {
          timeBudgetMs: 90,
          requiredImprovement: count
        });
      });
      if (provenRestart.best && provenRestart.best.finalCrossings === 0) {
        beginStructuralPlan(state, {
          type: 'proven-stage2-solve',
          objective: provenRestart.best.reason,
          startedAtCrossings: count,
          projectedFinalCrossings: 0,
          movableVertices: provenRestart.best.component,
          completionCondition: 'projected-solve',
          maxSteps: provenRestart.best.positions.length +
            provenRestart.best.simulationSteps + 3
        });
        state.pendingStructuralMoves = provenRestart.best.positions.slice();
        state.pendingStructuralReason = provenRestart.best.reason;
        best = takePendingStructuralMove(graph, state);
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        best.improvement = count - newCount;
        state.stuckCount = 0;
        return { done: false, improved: newCount < count, move: best, count: newCount };
      }
    }

    // Conservative automatic Stage 2 region extension. Try one bounded
    // structural hypothesis per stalled crossing count, and commit only when
    // simulation shows both meaningful region/localization progress and a
    // productive return to Stage 1.
    if (!state.activeStructuralPlan && graph.nodes.length <= 60 && count <= 80 &&
        state.regionExtensionAttemptedAtCount !== count) {
      state.regionExtensionAttemptedAtCount = count;
      var extensionReport = profileSection('region-extension-search', function() {
        return suggestRegionExtensionPlan(graph, {
          timeBudgetMs: 200,
          cleanupSteps: 16
        });
      });
      state.lastRegionExtensionSearch = extensionReport;
      if (extensionReport.best) {
        var extension = extensionReport.best;
        beginStructuralPlan(state, {
          type: 'region-extension',
          objective: extension.objective,
          startedAtCrossings: count,
          projectedFinalCrossings: extension.finalMetrics.crossings,
          movableVertices: extension.component,
          protectedVertices: [],
          direction: extension.direction,
          completionCondition: 'productive-handoff',
          maxSteps: extension.positions.length + extension.cleanupSteps + 3,
          baseMetrics: extension.baseMetrics,
          setupMetrics: extension.setupMetrics,
          projectedMetrics: extension.finalMetrics
        });
        state.pendingStructuralMoves = extension.positions.slice();
        state.pendingStructuralReason = extension.objective;
        best = takePendingStructuralMove(graph, state);
        best.search.regionExtension = {
          distance: extension.distance,
          immediateDamage: extension.immediateDamage,
          cleanupSteps: extension.cleanupSteps,
          setupDelta: extension.setupDelta,
          finalDelta: extension.finalDelta,
          score: extension.score
        };
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        best.improvement = count - newCount;
        state.stuckCount = 0;
        state.recentAttempts = {};
        state.finisherAttemptedAtCount = null;
        return { done: false, improved: newCount < count, move: best, count: newCount };
      }
    }
    
    // Stage 1 is stuck - increment counter
    state.stuckCount = (state.stuckCount || 0) + 1;
    state.recentAttempts = state.recentAttempts || {};
    
    // If pauseBeforeEscape is set, signal that Stage 1 is stuck (before trying Stage 2)
    // This lets interactive mode intervene at the Stage 1 stuck point
    if (state.pauseBeforeEscape) {
      return { done: false, wouldEscape: true, count: count, stuckCount: state.stuckCount };
    }

    var wastedTailMetrics = state.storyMetrics || null;
    if (count <= 120 && state.movesSinceCrossingProgress >= 20) {
      state.storyState = state.storyState || createStoryState();
      wastedTailMetrics = updateStoryMetrics(graph, state.storyState, null, count);
      state.storyMetrics = wastedTailMetrics;
    }
    var wastedTailStrong = wastedTailMetrics &&
      wastedTailMetrics.dwell >= 20 &&
      wastedTailMetrics.freeze >= 0.88 &&
      wastedTailMetrics.trend >= -2;
    if (!wastedTailStrong && count <= 120 &&
        state.movesSinceCrossingProgress >= 30) {
      wastedTailStrong = true;
    }

    if (state.enableCascadeTrigger &&
        !state.activeStructuralPlan && wastedTailStrong &&
        count <= 80 &&
        state.cascadeTriggerAttemptedAtBestCrossings !== state.bestCrossingCount) {
      state.cascadeTriggerAttemptedAtBestCrossings = state.bestCrossingCount;
      best = profileSection('wasted-tail-cascade-trigger', function() {
        return suggestCascadeTriggerMove(graph, state, {
          timeBudgetMs: 90,
          rolloutSteps: 12,
          requiredImprovement: Math.max(2, Math.ceil(count * 0.12))
        });
      });
      if (best) {
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        best.improvement = count - newCount;
        state.stuckCount = 0;
        state.recentAttempts = {};
        state.finisherAttemptedAtCount = null;
        return {
          done: false,
          improved: newCount < count,
          move: attachStructuralPlan(state, best),
          count: newCount
        };
      }
    }

    if (!state.activeStructuralPlan && wastedTailStrong &&
        count <= 120 &&
        !state.anchorBreakAutoAttempted) {
      state.anchorBreakAutoAttempted = true;
      var anchorBreakReport = profileSection('anchor-break-barrier-search', function() {
        return suggestAnchorBreakBarrierTransfer(graph, {
          timeBudgetMs: 250,
          componentLimit: 40,
          barrierLimit: 14,
          cleanupSteps: 24,
          keepCandidates: 6
        });
      });
      state.lastAnchorBreakBarrierSearch = anchorBreakReport;
      var hasCleanAnchorBreak = anchorBreakReport.best &&
        anchorBreakReport.best.cleanAnchorBreaks &&
        anchorBreakReport.best.cleanAnchorBreaks.length > 0;
      var cleanAnchorBreakDefault =
        hasCleanAnchorBreak && count <= 120 &&
        anchorBreakReport.best.finalDamage === 0 &&
        anchorBreakReport.best.finalCrossings < count;
      var optInAnchorBreak =
        state.enableAnchorBreakAuto &&
        anchorBreakReport.best &&
        anchorBreakReport.best.finalDamage === 0 &&
        (anchorBreakReport.best.finalCrossings === 0 ||
         count - anchorBreakReport.best.finalCrossings >=
           Math.max(3, Math.ceil(count * 0.25)));
      if (anchorBreakReport.best &&
          anchorBreakReport.best.finalCrossings < count &&
          (cleanAnchorBreakDefault || optInAnchorBreak)) {
        var anchorBreakResult = startAnchorBreakBarrierPlan(
          graph, state, count, anchorBreakReport.best, anchorBreakReport);
        return {
          done: false,
          improved: anchorBreakResult.improved,
          move: anchorBreakResult.move,
          count: anchorBreakResult.count
        };
      }
    }

    // Large-graph Stage 1c / nucleus creation. At 50 vertices the old Stage 1c
    // gate was too small-graph-only: several failures stall above the region
    // extension threshold with almost no clean nucleus. Use a bounded group
    // reset to shorten/collect a local structure and hand Stage 1 a better
    // target-rich state. This is current-position reasoning, not rollback.
    if (!state.activeStructuralPlan &&
        graph.nodes.length <= 60 &&
        count > 50 && count <= 160 &&
        state.movesSinceCrossingProgress >= 20 &&
        state.highCrossingStage1cAttemptedAtBestCrossings !==
          state.bestCrossingCount) {
      var highCrossingAnalysis = analyzeGraphState(graph, {});
      var highCrossingNucleusFraction = graph.nodes.length > 0
        ? highCrossingAnalysis.largestCleanRegion / graph.nodes.length : 0;
      if (highCrossingNucleusFraction < 0.25) {
        state.highCrossingStage1cAttemptedAtBestCrossings =
          state.bestCrossingCount;
        var highCrossingStage1cReport =
          profileSection('high-crossing-stage1c-reset-search', function() {
            return suggestStage1cResetPlan(graph, {
              timeBudgetMs: 220,
              seedLimit: 0,
              geometricSeedLimit: 24,
              minGroupSize: 2,
              maxGroupSize: 4,
              scales: [0.75, 1.0],
              targetBlends: [1.0, 1.2],
              maxImmediateDamage: Math.max(45, Math.ceil(count * 0.35)),
              cleanupSteps: 25
            });
          });
        state.lastStage1cSearch = highCrossingStage1cReport;
        var highCrossingRequiredGain = Math.max(8, Math.ceil(count * 0.1));
        if (highCrossingStage1cReport.best &&
            count - highCrossingStage1cReport.best.finalCrossings >=
              highCrossingRequiredGain) {
          var highCrossingReset = highCrossingStage1cReport.best;
          beginStructuralPlan(state, {
            type: 'stage1c-reset',
            objective: 'high-crossing nucleus reset: ' +
              highCrossingReset.reason,
            startedAtCrossings: count,
            projectedFinalCrossings: highCrossingReset.finalCrossings,
            movableVertices: highCrossingReset.group,
            protectedVertices: [],
            completionCondition: 'stage1c-handoff',
            maxSteps: highCrossingReset.scheduledMoves.length +
              highCrossingReset.rolloutMoves + 3,
            baseMetrics: {
              crossings: count,
              nucleusFraction: highCrossingNucleusFraction
            },
            projectedMetrics: {
              immediateCrossings: highCrossingReset.immediateCrossings,
              finalCrossings: highCrossingReset.finalCrossings,
              netGain: highCrossingReset.netGain,
              recoveryGain: highCrossingReset.recoveryGain
            }
          });
          state.pendingStructuralMoves =
            highCrossingReset.scheduledMoves.map(function(move) {
              return {
                index: move.index,
                x: move.x,
                y: move.y,
                mode: move.mode
              };
            }).concat(highCrossingReset.rollout.map(function(move) {
              return {
                index: move.vertex,
                x: move.x,
                y: move.y,
                mode: 'stage1c-rollout'
              };
            }));
          state.pendingStructuralReason = 'high-crossing nucleus reset: ' +
            highCrossingReset.reason;
          best = takePendingStructuralMove(graph, state);
          best.search.stage1cReset = {
            group: highCrossingReset.group,
            immediateCrossings: highCrossingReset.immediateCrossings,
            immediateDamage: highCrossingReset.immediateDamage,
            projectedFinalCrossings: highCrossingReset.finalCrossings,
            netGain: highCrossingReset.netGain,
            recoveryGain: highCrossingReset.recoveryGain,
            rolloutMoves: highCrossingReset.rolloutMoves,
            afterProbe: highCrossingReset.afterProbe,
            lengthProfile: highCrossingReset.lengthProfile,
            candidatesTested: highCrossingStage1cReport.candidatesTested,
            elapsedMs: highCrossingStage1cReport.elapsedMs,
            nucleusFraction: highCrossingNucleusFraction
          };
          best.node[0] = best.toX;
          best.node[1] = best.toY;
          recordMove(state, best.nodeIndex, best.toX, best.toY);
          var newCount = intersections(graph.links);
          best.improvement = count - newCount;
          state.stuckCount = 0;
          state.recentAttempts = {};
          state.finisherAttemptedAtCount = null;
          return {
            done: false,
            improved: newCount < count,
            move: best,
            count: newCount
          };
        }
      }
    }

    // Stage 1c auto hook, currently conservative and small-graph-only. This
    // fires at the same boundary where Interactive users were manually making
    // reset moves: ordinary descent is exhausted, but before escape churn.
    if (!state.activeStructuralPlan &&
        graph.nodes.length <= 25 &&
        count <= 60 &&
        state.stage1cAttemptedAtCount !== count) {
      state.stage1cAttemptedAtCount = count;
      var stage1cReport = profileSection('stage1c-reset-search', function() {
        return suggestStage1cResetPlan(graph, {
          timeBudgetMs: 350,
          seedLimit: 0,
          geometricSeedLimit: 32,
          minGroupSize: 2,
          maxGroupSize: 4,
          scales: [0.75, 1.0],
          targetBlends: [1.0, 1.2],
          maxImmediateDamage: 90,
          cleanupSteps: 25
        });
      });
      state.lastStage1cSearch = stage1cReport;
      if (stage1cReport.best &&
          (stage1cReport.best.finalCrossings === 0 ||
           stage1cReport.best.netGain >= Math.max(1, Math.ceil(count * 0.1)))) {
        var reset = stage1cReport.best;
        beginStructuralPlan(state, {
          type: 'stage1c-reset',
          objective: reset.reason,
          startedAtCrossings: count,
          projectedFinalCrossings: reset.finalCrossings,
          movableVertices: reset.group,
          protectedVertices: [],
          completionCondition: 'stage1c-handoff',
          maxSteps: reset.scheduledMoves.length + reset.rolloutMoves + 3,
          baseMetrics: {
            crossings: count
          },
          projectedMetrics: {
            immediateCrossings: reset.immediateCrossings,
            finalCrossings: reset.finalCrossings,
            netGain: reset.netGain,
            recoveryGain: reset.recoveryGain
          }
        });
        state.pendingStructuralMoves = reset.scheduledMoves.map(function(move) {
          return {
            index: move.index,
            x: move.x,
            y: move.y,
            mode: move.mode
          };
        });
        state.pendingStructuralReason = reset.reason;
        best = takePendingStructuralMove(graph, state);
        best.search.stage1cReset = {
          group: reset.group,
          immediateCrossings: reset.immediateCrossings,
          immediateDamage: reset.immediateDamage,
          projectedFinalCrossings: reset.finalCrossings,
          netGain: reset.netGain,
          recoveryGain: reset.recoveryGain,
          rolloutMoves: reset.rolloutMoves,
          afterProbe: reset.afterProbe,
          lengthProfile: reset.lengthProfile,
          candidatesTested: stage1cReport.candidatesTested,
          elapsedMs: stage1cReport.elapsedMs
        };
        best.node[0] = best.toX;
        best.node[1] = best.toY;
        recordMove(state, best.nodeIndex, best.toX, best.toY);
        var newCount = intersections(graph.links);
        best.improvement = count - newCount;
        state.stuckCount = 0;
        state.recentAttempts = {};
        state.finisherAttemptedAtCount = null;
        return {
          done: false,
          improved: newCount < count,
          move: attachStructuralPlan(state, best),
          count: newCount
        };
      }
    }

    // Diagnostic only for now: when the normal stack has run out of ideas,
    // look for a single problem-child vertex that wants a topological side
    // change around one of its reference neighbors. Solver exports include
    // this report, but automatic policy does not execute it yet.
    if (count <= 20 && state.problemChildInversionAttemptedAtCount !== count) {
      state.problemChildInversionAttemptedAtCount = count;
      state.lastProblemChildInversionSearch =
        profileSection('problem-child-inversion-search', function() {
          return suggestProblemChildInversions(graph, {
            timeBudgetMs: 140,
            vertexLimit: 10,
            candidateLimit: 220,
            rolloutLimit: 10,
            rolloutSteps: 12
          });
        });
    }

    // Try escape move
    var escape = profileSection('escape', function() {
      return findEscapeMove(graph);
    });
    if (escape) {
      if (wouldOscillate(state, escape.nodeIndex, escape.toX, escape.toY)) {
        state.oscillatingVertices = state.oscillatingVertices || {};
        state.oscillatingVertices[escape.nodeIndex] = true;
        escape = null;
      }
    }
    if (escape) {
      // Track this vertex as recently attempted
      state.recentAttempts[escape.nodeIndex] = (state.recentAttempts[escape.nodeIndex] || 0) + 1;
      
      escape.node[0] = escape.toX;
      escape.node[1] = escape.toY;
      recordMove(state, escape.nodeIndex, escape.toX, escape.toY);
      var newCount = intersections(graph.links);
      return {
        done: false,
        improved: escape.improvement > 0,
        move: attachStructuralPlan(state, escape),
        count: newCount
      };
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
        var i = nodeIndexOf(graph, node);
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
    var i = nodeIndexOf(graph, node);
    
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
  exports.computeProgressMetrics = computeProgressMetrics;
  exports.createStoryState = createStoryState;
  exports.updateStoryMetrics = updateStoryMetrics;
  exports.createRegimeState = createRegimeState;
  exports.computeRegimeMetrics = computeRegimeMetrics;
  exports.analyzeEstablishedRegion = analyzeEstablishedRegion;
  exports.analyzeConflictRegions = analyzeConflictRegions;
  exports.suggestDirectionalPlans = suggestDirectionalPlans;
  exports.suggestRegionReorganizationMove = suggestRegionReorganizationMove;
  exports.suggestRegionCompactionPlan = suggestRegionCompactionPlan;
  exports.suggestRegionExtensionPlan = suggestRegionExtensionPlan;
  exports.suggestDominantBarrierTransfer = suggestDominantBarrierTransfer;
  exports.suggestAnchorBreakBarrierTransfer = suggestAnchorBreakBarrierTransfer;
  exports.suggestProblemChildInversions = suggestProblemChildInversions;
  exports.findSeparatingTriangles = findSeparatingTriangles;
  exports.suggestContainedTriangleSolve = suggestContainedTriangleSolve;
  exports.suggestStage2Move = suggestStage2Move;
  exports.suggestSeparatorReshape = suggestSeparatorReshape;
  exports.findSeparatingTriangleFinisher = findSeparatingTriangleFinisher;
  exports.findSeparatingTriangleFinisherLookahead =
    findSeparatingTriangleFinisherLookahead;
  exports.suggestStage2Restart = suggestStage2Restart;
  exports.applyStage2Suggestion = applyStage2Suggestion;
  exports.suggestStage1cResetPlan = suggestStage1cResetPlan;
  exports.suggestCascadeTriggerMove = suggestCascadeTriggerMove;
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
  exports.setDeterministicClock = setDeterministicClock;
  exports.getClockState = getClockState;
  exports.setProfilerEnabled = setProfilerEnabled;
  exports.resetProfiler = resetProfiler;
  exports.getProfilerReport = getProfilerReport;
  
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Solver = {}));
