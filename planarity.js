var w = 1000,
    h = 600,
    p = 7,
    x = d3.scale.linear().range([0, w]),
    y = d3.scale.linear().range([0, h]),
    start,
    format = d3.format(",.1f"),
    moves = 0,
    highlightIntersections = true,
    count = 0, // intersections
    graph = { nodes: [], links: [] };

d3.select("#vis").selectAll("*").remove();

var svg = d3.select("#vis").append("svg")
    .attr("width", w + p * 2)
    .attr("height", h + p * 2);

var vis = svg.append("g")
    .attr("transform", "translate(" + [p, p] + ")");

var lines = vis.append("g"),
    nodes = vis.append("g"),
    counter = d3.select("#count"),
    moveCounter = d3.select("#move-count"),
    timer = d3.select("#timer");

d3.select("#generate").on("click", generate);
d3.select("#new-game").on("click", generate);
d3.select("#intersections").on("change", function() {
  highlightIntersections = this.checked;
  update();
});

// Allow resizing canvas on the fly
d3.select("#canvas-width").on("change", function() {
  resizeCanvas();
  update();
});
d3.select("#canvas-height").on("change", function() {
  resizeCanvas();
  update();
});

// Start with blank canvas
resizeCanvas();

d3.timer(function() {
  if (count) timer.text(format((+new Date - start) / 1000));
});

function resizeCanvas() {
  w = +d3.select("#canvas-width").property("value");
  h = +d3.select("#canvas-height").property("value");

  // Update scales
  x.range([0, w]);
  y.range([0, h]);

  // Resize SVG
  svg.attr("width", w + p * 2)
     .attr("height", h + p * 2);
}

function generate() {
  moves = 0;
  start = +new Date;
  lastCount = null;

  // Apply canvas size before generating
  resizeCanvas();

  graph = scramble(planarGraph(+d3.select("#nodes").property("value")));
  update();
}

function update() {
  count = intersections(graph.links);
  counter.text(count ? count + "." : "0! Well done!");

  var line = lines.selectAll("line")
      .data(graph.links);
  line.enter().append("line");
  line.exit().remove();
  line.attr("x1", function(d) { return x(d[0][0]); })
      .attr("y1", function(d) { return y(d[0][1]); })
      .attr("x2", function(d) { return x(d[1][0]); })
      .attr("y2", function(d) { return y(d[1][1]); })
      .classed("intersection", highlightIntersections ? function(d) { return d.intersection; } : true);

  var node = nodes.selectAll("circle")
      .data(graph.nodes);
  node.enter().append("circle")
      .attr("r", p - 1)
      .on("click", function(d) {
        d3.event.stopPropagation();
        if (selectedNode === d) {
          selectedNode = null; // Deselect if clicking same node
        } else {
          selectedNode = d;
        }
        update();
      })
      .call(d3.behavior.drag()
        .origin(function(d) { return {x: x(d[0]), y: y(d[1])}; })
        .on("drag", function(d) {
          // Jitter to prevent coincident nodes.
          d[0] = Math.max(0, Math.min(1, x.invert(d3.event.x))) + Math.random() * 1e-4;
          d[1] = Math.max(0, Math.min(1, y.invert(d3.event.y))) + Math.random() * 1e-4;
          update();
        })
        .on("dragend", function() {
          moveCounter.text(++moves + " move" + (moves !== 1 ? "s" : ""));
        }));
  node.exit().remove();
  node.attr("cx", function(d) { return x(d[0]); })
      .attr("cy", function(d) { return y(d[1]); })
      .classed("intersection", highlightIntersections ?
          function(d) { return d.intersection; } : count)
      .classed("selected", function(d) { return d === selectedNode; });
}

// Scramble the node positions.
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

// Generates a random planar graph with *n* nodes.
function planarGraph(n) {
  var points = [],
      links = [],
      i = -1,
      j;
  while (++i < n) points[i] = [Math.random(), Math.random()];
  i = -1; while (++i < n) {
    addPlanarLink([points[i], points[~~(Math.random() * n)]], links);
  }
  i = -1; while (++i < n) {
    j = i; while (++j < n) addPlanarLink([points[i], points[j]], links);
  }
  return {nodes: points, links: links};
}

// Adds a link if it doesn't intersect with anything.
function addPlanarLink(link, links) {
  if (!links.some(function(to) { return intersect(link, to); })) {
    links.push(link);
  }
}

// Counts the number of intersections for a given array of links.
function intersections(links) {
  var n = links.length,
      i = -1,
      j,
      x,
      count = 0;
  // Reset flags.
  while (++i < n) {
    (x = links[i]).intersection = false;
    x[0].intersection = false;
    x[1].intersection = false;
  }
  i = -1; while (++i < n) {
    x = links[i];
    j = i; while (++j < n) {
      if (intersect(x, links[j])) {
        x.intersection =
            x[0].intersection =
            x[1].intersection =
            links[j].intersection =
            links[j][0].intersection =
            links[j][1].intersection = true;
        count++;
      }
    }
  }
  return count;
}

// Returns true if two line segments intersect.
// Based on http://stackoverflow.com/a/565282/64009
function intersect(a, b) {
  // Check if the segments are exactly the same (or just reversed).
  if (a[0] === b[0] && a[1] === b[1] || a[0] === b[1] && a[1] === b[0]) return true;

  // Represent the segments as p + tr and q + us, where t and u are scalar
  // parameters.
  var p = a[0],
      r = [a[1][0] - p[0], a[1][1] - p[1]],
      q = b[0],
      s = [b[1][0] - q[0], b[1][1] - q[1]];

  // Solve p + tr = q + us to find an intersection point.
  // First, cross both sides with s:
  //   (p + tr) × s = (q + us) × s
  // We know that s × s = 0, so this can be rewritten as:
  //   t(r × s) = (q − p) × s
  // Then solve for t to get:
  //   t = (q − p) × s / (r × s)
  // Similarly, for u we get:
  //   u = (q − p) × r / (r × s)
  var rxs = cross(r, s),
      q_p = [q[0] - p[0], q[1] - p[1]],
      t = cross(q_p, s) / rxs,
      u = cross(q_p, r) / rxs,
      epsilon = 1e-6;

  return t > epsilon && t < 1 - epsilon && u > epsilon && u < 1 - epsilon;
}

function cross(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

// Show inline status message
function showStatus(message, isError) {
  var el = d3.select("#status-message");
  el.text(message)
    .style("display", "block")
    .style("background-color", isError ? "#ffcccc" : "#ccffcc")
    .style("color", isError ? "#990000" : "#006600");
  setTimeout(function() {
    el.style("display", "none");
  }, 3000);
}

// Get all saved games from localStorage
function getSavedGames() {
  var saved = localStorage.getItem('planaritySavedGames');
  return saved ? JSON.parse(saved) : [];
}

// Save the list of games to localStorage
function setSavedGames(games) {
  localStorage.setItem('planaritySavedGames', JSON.stringify(games));
}

// Create a game state object
function createGameState() {
  return {
    nodes: graph.nodes,
    links: graph.links.map(function(link) {
      return [
        graph.nodes.indexOf(link[0]),
        graph.nodes.indexOf(link[1])
      ];
    }),
    moves: moves,
    startTime: start,
    nodeCount: +d3.select("#nodes").property("value"),
    highlightIntersections: highlightIntersections,
    canvasWidth: w,
    canvasHeight: h,
    intersections: count
  };
}

// Update the saved games dropdown
function updateSavedGamesDropdown() {
  var games = getSavedGames();
  var select = d3.select("#saved-games");
  
  select.selectAll("option").remove();
  select.append("option").attr("value", "").text("-- Select a game (" + games.length + " saved) --");
  
  games.forEach(function(game, index) {
    var date = new Date(game.savedAt);
    var dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();
    var label = game.name + " - " + game.state.nodeCount + " nodes, " + 
                game.state.intersections + " crossings, " + game.state.moves + " moves (" + dateStr + ")";
    select.append("option").attr("value", index).text(label);
  });
}

// Save game to a new slot
function saveGame() {
  var nameInput = d3.select("#save-name");
  var name = nameInput.property("value").trim();
  if (!name) {
    name = "Game " + (getSavedGames().length + 1);
  }
  
  var games = getSavedGames();
  games.unshift({
    name: name,
    savedAt: Date.now(),
    state: createGameState()
  });
  setSavedGames(games);
  updateSavedGamesDropdown();
  nameInput.property("value", "");
  showStatus('Game saved as "' + name + '"!', false);
}

// Load a game state
function loadGameState(state) {
  graph = {
    nodes: state.nodes,
    links: state.links.map(function(linkIndices) {
      return [state.nodes[linkIndices[0]], state.nodes[linkIndices[1]]];
    })
  };

  moves = state.moves;
  start = state.startTime;
  highlightIntersections = state.highlightIntersections;
  d3.select("#nodes").property("value", state.nodeCount);
  d3.select("#intersections").property("checked", highlightIntersections);

  if (state.canvasWidth && state.canvasHeight) {
    d3.select("#canvas-width").property("value", state.canvasWidth);
    d3.select("#canvas-height").property("value", state.canvasHeight);
    resizeCanvas();
  }

  moveCounter.text(moves + " move" + (moves !== 1 ? "s" : ""));
  update();
}

// Load selected game from dropdown
function loadSelectedGame() {
  var index = d3.select("#saved-games").property("value");
  if (index === "") {
    showStatus("Please select a game to load.", true);
    return false;
  }
  
  var games = getSavedGames();
  loadGameState(games[+index].state);
  showStatus("Game loaded!", false);
  return true;
}

// Delete selected game
function deleteSelectedGame() {
  var index = d3.select("#saved-games").property("value");
  if (index === "") {
    showStatus("Please select a game to delete.", true);
    return;
  }
  
  var games = getSavedGames();
  var name = games[+index].name;
  games.splice(+index, 1);
  setSavedGames(games);
  updateSavedGamesDropdown();
  showStatus('Deleted "' + name + '"', false);
}

// Check for auto-saved game
function checkForSavedGame() {
  return localStorage.getItem('planarityCurrentGame') !== null;
}

// Wrap update to auto-save after each change
var originalUpdate = update;
update = function() {
  originalUpdate();
  autoSave();
};

// Resume auto-saved game
function resumeGame() {
  var savedState = localStorage.getItem('planarityCurrentGame');
  // Migration: check old key
  if (!savedState) {
    savedState = localStorage.getItem('planarityGame');
  }
  if (!savedState) {
    showStatus('No game in progress to resume!', true);
    return;
  }
  loadGameState(JSON.parse(savedState));
  showStatus('Resumed last game!', false);
}

// Auto-save current game
function autoSave() {
  localStorage.setItem('planarityCurrentGame', JSON.stringify(createGameState()));
}

// Initialize saved games dropdown on load
updateSavedGamesDropdown();

// Wire up buttons
d3.select("#save").on("click", saveGame);
d3.select("#load").on("click", loadSelectedGame);
d3.select("#delete-save").on("click", deleteSelectedGame);
d3.select("#resume").on("click", resumeGame);

// ============ SOLVER ============

var solverRunning = false;
var solverTimeout = null;

// Analytics tracking
var analytics = {
  status: 'idle',
  crossings: 0,
  nodeIndex: -1,
  nodeCrossings: 0,
  candidatesTried: 0,
  samplesTested: 0,
  improvement: 0,
  fromPos: [0, 0],
  toPos: [0, 0]
};

function updateAnalytics() {
  d3.select("#a-status").text(analytics.status);
  d3.select("#a-crossings").text(count);
  d3.select("#a-node").text(analytics.nodeIndex >= 0 ? analytics.nodeIndex : '-');
  d3.select("#a-node-crossings").text(analytics.nodeCrossings || '-');
  d3.select("#a-candidates").text(analytics.candidatesTried || '-');
  d3.select("#a-samples").text(analytics.samplesTested || '-');
  d3.select("#a-improvement").text(analytics.improvement > 0 ? '-' + analytics.improvement : '-');
  d3.select("#a-from").text(analytics.fromPos[0] ? 
    '(' + analytics.fromPos[0].toFixed(3) + ', ' + analytics.fromPos[1].toFixed(3) + ')' : '-');
  d3.select("#a-to").text(analytics.toPos[0] ? 
    '(' + analytics.toPos[0].toFixed(3) + ', ' + analytics.toPos[1].toFixed(3) + ')' : '-');
}

// ============ SOLVER STRATEGIES ============

var currentStrategy = 'centroid'; // 'centroid', 'force', 'random'
var selectedNode = null; // Currently selected node for operations

// Get neighbors of a node (connected via edges)
function getNeighbors(node) {
  var neighbors = [];
  graph.links.forEach(function(link) {
    if (link[0] === node) neighbors.push(link[1]);
    else if (link[1] === node) neighbors.push(link[0]);
  });
  return neighbors;
}

// Calculate centroid of a set of nodes
function centroid(nodes) {
  if (nodes.length === 0) return null;
  var cx = 0, cy = 0;
  nodes.forEach(function(n) {
    cx += n[0];
    cy += n[1];
  });
  return [cx / nodes.length, cy / nodes.length];
}

// Strategy 1: Move toward centroid of neighbors
function findCentroidMove() {
  var bestMove = null;
  var bestScore = -Infinity;
  
  // Check each node involved in crossings
  graph.nodes.forEach(function(node, i) {
    if (!node.intersection) return;
    
    var neighbors = getNeighbors(node);
    if (neighbors.length === 0) return;
    
    var target = centroid(neighbors);
    var originalCount = count;
    var originalX = node[0];
    var originalY = node[1];
    
    // Try moving toward centroid
    var dx = target[0] - node[0];
    var dy = target[1] - node[1];
    var dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < 0.01) return; // Already at centroid
    
    // Move partway toward centroid
    var moveAmount = Math.min(0.1, dist * 0.5);
    var newX = node[0] + (dx / dist) * moveAmount;
    var newY = node[1] + (dy / dist) * moveAmount;
    newX = Math.max(0.02, Math.min(0.98, newX));
    newY = Math.max(0.02, Math.min(0.98, newY));
    
    // Test this position
    node[0] = newX;
    node[1] = newY;
    var newCount = intersections(graph.links);
    
    // Score: prefer moves that reduce crossings, or at least move toward centroid
    var improvement = originalCount - newCount;
    var score = improvement * 10 + (1 - dist); // Prioritize improvements, tiebreak by distance
    
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
    
    // Restore
    node[0] = originalX;
    node[1] = originalY;
  });
  
  intersections(graph.links); // Restore flags
  return bestMove;
}

// Strategy 2: Local refinement - try small movements in all directions
function findLocalMove() {
  var bestMove = null;
  var bestImprovement = 0;
  
  graph.nodes.forEach(function(node, i) {
    if (!node.intersection) return;
    
    var originalX = node[0];
    var originalY = node[1];
    var originalCount = count;
    
    // Try 8 directions plus some random
    var directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];
    
    var stepSize = 0.03;
    
    directions.forEach(function(dir) {
      var newX = originalX + dir[0] * stepSize;
      var newY = originalY + dir[1] * stepSize;
      newX = Math.max(0.02, Math.min(0.98, newX));
      newY = Math.max(0.02, Math.min(0.98, newY));
      
      node[0] = newX;
      node[1] = newY;
      var newCount = intersections(graph.links);
      var improvement = originalCount - newCount;
      
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
      
      node[0] = originalX;
      node[1] = originalY;
    });
  });
  
  intersections(graph.links);
  return bestMove;
}

// Strategy 3: Move away from crossing midpoints
function findUncrossMove() {
  var bestMove = null;
  var bestImprovement = 0;
  
  graph.nodes.forEach(function(node, i) {
    if (!node.intersection) return;
    
    var originalX = node[0];
    var originalY = node[1];
    var originalCount = count;
    
    // Find all crossing midpoints this node should avoid
    var avoidX = 0, avoidY = 0, avoidCount = 0;
    
    graph.links.forEach(function(link) {
      if ((link[0] === node || link[1] === node) && link.intersection) {
        // Find what this edge crosses
        graph.links.forEach(function(other) {
          if (other !== link && intersect(link, other)) {
            // Add midpoint of crossing edge to avoidance
            avoidX += (other[0][0] + other[1][0]) / 2;
            avoidY += (other[0][1] + other[1][1]) / 2;
            avoidCount++;
          }
        });
      }
    });
    
    if (avoidCount === 0) return;
    
    avoidX /= avoidCount;
    avoidY /= avoidCount;
    
    // Move away from the crossing area
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
    
    // Test
    node[0] = newX;
    node[1] = newY;
    var newCount = intersections(graph.links);
    var improvement = originalCount - newCount;
    
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
    
    // Restore
    node[0] = originalX;
    node[1] = originalY;
  });
  
  intersections(graph.links);
  return bestMove;
}

// Strategy 4: Wiggle - random perturbation to escape local minima
function findWiggleMove() {
  var bestMove = null;
  var bestImprovement = -Infinity;
  
  // Try random moves on intersecting nodes
  var candidates = graph.nodes.filter(function(n) { return n.intersection; });
  if (candidates.length === 0) return null;
  
  // Pick a random intersecting node
  var node = candidates[Math.floor(Math.random() * candidates.length)];
  var i = graph.nodes.indexOf(node);
  
  var originalX = node[0];
  var originalY = node[1];
  var originalCount = count;
  
  // Try several random positions
  for (var t = 0; t < 20; t++) {
    var angle = Math.random() * Math.PI * 2;
    var dist = 0.05 + Math.random() * 0.15;
    var newX = originalX + Math.cos(angle) * dist;
    var newY = originalY + Math.sin(angle) * dist;
    newX = Math.max(0.02, Math.min(0.98, newX));
    newY = Math.max(0.02, Math.min(0.98, newY));
    
    node[0] = newX;
    node[1] = newY;
    var newCount = intersections(graph.links);
    var improvement = originalCount - newCount;
    
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
    
    node[0] = originalX;
    node[1] = originalY;
  }
  
  intersections(graph.links);
  return bestMove;
}

// Strategy 5: Repel - push all nodes away from a selected node
function doRepel(centerNode) {
  var centerX = centerNode[0];
  var centerY = centerNode[1];
  var centerIdx = graph.nodes.indexOf(centerNode);
  
  // Convert normalized coords to pixels for distance calculation
  var centerPxX = x(centerX);
  var centerPxY = y(centerY);
  
  var maxRepelPx = 25; // Max pixels to move
  var fadeDistPx = 200; // Distance at which repel becomes 0 (roughly 3 inches at ~70dpi)
  
  var movedCount = 0;
  
  graph.nodes.forEach(function(node, i) {
    if (node === centerNode) return;
    
    var nodePxX = x(node[0]);
    var nodePxY = y(node[1]);
    
    var dx = nodePxX - centerPxX;
    var dy = nodePxY - centerPxY;
    var distPx = Math.sqrt(dx * dx + dy * dy);
    
    if (distPx >= fadeDistPx || distPx < 0.001) return;
    
    // Linear taper: full repel at distance 0, zero repel at fadeDistPx
    var repelAmount = maxRepelPx * (1 - distPx / fadeDistPx);
    
    // Move in the direction away from center
    var moveX = (dx / distPx) * repelAmount;
    var moveY = (dy / distPx) * repelAmount;
    
    // Convert pixel movement back to normalized coords
    var newX = x.invert(nodePxX + moveX);
    var newY = y.invert(nodePxY + moveY);
    
    // Clamp to bounds
    newX = Math.max(0.02, Math.min(0.98, newX));
    newY = Math.max(0.02, Math.min(0.98, newY));
    
    if (newX !== node[0] || newY !== node[1]) {
      node[0] = newX;
      node[1] = newY;
      movedCount++;
    }
  });
  
  update();
  moves++;
  moveCounter.text(moves + " move" + (moves !== 1 ? "s" : ""));
  
  showStatus("Repel from node " + centerIdx + ": moved " + movedCount + " nodes", false);
}

function stepRepel() {
  if (!selectedNode) {
    showStatus("Select a vertex first", true);
    return;
  }
  doRepel(selectedNode);
}

// Execute a single strategy move
function executeMove(move, callback) {
  if (!move) {
    showStatus("No move found", true);
    if (callback) callback(false);
    return;
  }
  
  analytics.status = move.strategy;
  analytics.nodeIndex = move.nodeIndex;
  analytics.nodeCrossings = nodeIntersectionCount(move.node);
  analytics.improvement = move.improvement;
  analytics.fromPos = [move.fromX, move.fromY];
  analytics.toPos = [move.toX, move.toY];
  updateAnalytics();
  
  var sign = move.improvement >= 0 ? '-' : '+';
  showStatus(move.strategy + ": node " + move.nodeIndex + " (" + sign + Math.abs(move.improvement) + " crossings)", false);
  
  animateNode(move.node, move.toX, move.toY, function() {
    moves++;
    moveCounter.text(moves + " move" + (moves !== 1 ? "s" : ""));
    analytics.status = 'idle';
    updateAnalytics();
    if (callback) callback(true);
  });
}

// Individual strategy steps
function stepCentroid(callback) {
  if (graph.nodes.length === 0 || count === 0) {
    showStatus(count === 0 ? "Already solved!" : "No graph", count !== 0);
    if (callback) callback(false);
    return;
  }
  count = intersections(graph.links);
  var move = findCentroidMove();
  executeMove(move, callback);
}

function stepUncross(callback) {
  if (graph.nodes.length === 0 || count === 0) {
    showStatus(count === 0 ? "Already solved!" : "No graph", count !== 0);
    if (callback) callback(false);
    return;
  }
  count = intersections(graph.links);
  var move = findUncrossMove();
  executeMove(move, callback);
}

function stepLocal(callback) {
  if (graph.nodes.length === 0 || count === 0) {
    showStatus(count === 0 ? "Already solved!" : "No graph", count !== 0);
    if (callback) callback(false);
    return;
  }
  count = intersections(graph.links);
  var move = findLocalMove();
  executeMove(move, callback);
}

function stepWiggle(callback) {
  if (graph.nodes.length === 0 || count === 0) {
    showStatus(count === 0 ? "Already solved!" : "No graph", count !== 0);
    if (callback) callback(false);
    return;
  }
  count = intersections(graph.links);
  var move = findWiggleMove();
  executeMove(move, callback);
}

// Main solver step: try strategies in order
function solverStepMulti(callback) {
  if (graph.nodes.length === 0) {
    showStatus("No graph", true);
    if (callback) callback(false);
    return;
  }
  
  count = intersections(graph.links);
  if (count === 0) {
    showStatus("Already solved!", false);
    if (callback) callback(false);
    return;
  }
  
  // Try strategies and pick best move
  var moves_found = [];
  
  var centroidMove = findCentroidMove();
  if (centroidMove) moves_found.push(centroidMove);
  
  var uncrossMove = findUncrossMove();
  if (uncrossMove) moves_found.push(uncrossMove);
  
  var localMove = findLocalMove();
  if (localMove) moves_found.push(localMove);
  
  // Pick the move with best improvement
  var bestMove = null;
  moves_found.forEach(function(m) {
    if (!bestMove || m.improvement > bestMove.improvement) {
      bestMove = m;
    }
  });
  
  if (!bestMove) {
    showStatus("No improving move found", true);
    if (callback) callback(false);
    return;
  }
  
  // Update analytics
  analytics.status = bestMove.strategy;
  analytics.nodeIndex = bestMove.nodeIndex;
  analytics.nodeCrossings = nodeIntersectionCount(bestMove.node);
  analytics.improvement = bestMove.improvement;
  analytics.fromPos = [bestMove.fromX, bestMove.fromY];
  analytics.toPos = [bestMove.toX, bestMove.toY];
  updateAnalytics();
  
  showStatus("Strategy: " + bestMove.strategy + " (node " + bestMove.nodeIndex + ", -" + bestMove.improvement + " crossings)", false);
  
  // Animate the move
  animateNode(bestMove.node, bestMove.toX, bestMove.toY, function() {
    moves++;
    moveCounter.text(moves + " move" + (moves !== 1 ? "s" : ""));
    analytics.status = 'idle';
    updateAnalytics();
    if (callback) callback(true);
  });
}

// Count intersections involving a specific node
function nodeIntersectionCount(node) {
  var nodeCount = 0;
  graph.links.forEach(function(link) {
    if (link[0] === node || link[1] === node) {
      if (link.intersection) nodeCount++;
    }
  });
  return nodeCount;
}

// Get nodes sorted by intersection count (worst first)
function getNodesByIntersections() {
  var nodesWithCounts = graph.nodes.map(function(node) {
    return { node: node, count: nodeIntersectionCount(node) };
  });
  
  nodesWithCounts.sort(function(a, b) { return b.count - a.count; });
  
  return nodesWithCounts.filter(function(n) { return n.count > 0; });
}

// Animate a node moving from current position to target
function animateNode(node, targetX, targetY, callback) {
  var startX = node[0];
  var startY = node[1];
  var duration = 400; // ms (slowed down 30%)
  var startTime = Date.now();
  
  function frame() {
    var elapsed = Date.now() - startTime;
    var t = Math.min(1, elapsed / duration);
    // Ease out quad
    t = t * (2 - t);
    
    node[0] = startX + (targetX - startX) * t;
    node[1] = startY + (targetY - startY) * t;
    
    // Update analytics with current position during animation
    analytics.toPos = [node[0], node[1]];
    analytics.crossings = intersections(graph.links);
    updateAnalytics();
    
    update();
    
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      node[0] = targetX;
      node[1] = targetY;
      update();
      if (callback) callback();
    }
  }
  
  requestAnimationFrame(frame);
}

// Try to find the best move for a given node
function findBestMoveForNode(node, nodeIndex) {
  var originalX = node[0];
  var originalY = node[1];
  var originalCount = intersections(graph.links);
  
  var bestX = originalX;
  var bestY = originalY;
  var bestCount = originalCount;
  var sampleCount = 0;
  
  // Try a grid of positions
  var gridSize = 5;
  for (var gx = 0; gx < gridSize; gx++) {
    for (var gy = 0; gy < gridSize; gy++) {
      node[0] = (gx + 0.5) / gridSize;
      node[1] = (gy + 0.5) / gridSize;
      sampleCount++;
      var newCount = intersections(graph.links);
      
      if (newCount < bestCount) {
        bestCount = newCount;
        bestX = node[0];
        bestY = node[1];
      }
    }
  }
  
  // Sample random positions
  var samples = 10;
  for (var i = 0; i < samples; i++) {
    node[0] = Math.random();
    node[1] = Math.random();
    sampleCount++;
    var newCount = intersections(graph.links);
    
    if (newCount < bestCount) {
      bestCount = newCount;
      bestX = node[0];
      bestY = node[1];
    }
  }
  
  // Try positions near other nodes
  graph.nodes.forEach(function(other) {
    if (other !== node) {
      // Try exact position of other node
      node[0] = other[0] + (Math.random() - 0.5) * 0.05;
      node[1] = other[1] + (Math.random() - 0.5) * 0.05;
      node[0] = Math.max(0.01, Math.min(0.99, node[0]));
      node[1] = Math.max(0.01, Math.min(0.99, node[1]));
      sampleCount++;
      
      var newCount = intersections(graph.links);
      if (newCount < bestCount) {
        bestCount = newCount;
        bestX = node[0];
        bestY = node[1];
      }
    }
  });
  
  // Restore original position
  node[0] = originalX;
  node[1] = originalY;
  intersections(graph.links);
  
  if (bestCount < originalCount) {
    return { 
      node: node, 
      nodeIndex: nodeIndex,
      x: bestX, 
      y: bestY, 
      fromX: originalX,
      fromY: originalY,
      improvement: originalCount - bestCount,
      samples: sampleCount
    };
  }
  return null;
}

// Try to improve position of a single node
function solverStep(callback) {
  // Check if graph exists
  if (!graph.nodes || graph.nodes.length === 0) {
    showStatus("No graph - click New Graph first", true);
    if (callback) callback(false);
    return;
  }
  
  // Refresh intersection flags and count
  count = intersections(graph.links);
  
  analytics.crossings = count;
  analytics.status = 'searching';
  updateAnalytics();
  
  if (count === 0) {
    analytics.status = 'solved';
    updateAnalytics();
    showStatus("Already solved!", false);
    stopSolver();
    if (callback) callback(false);
    return;
  }
  
  var candidates = getNodesByIntersections();
  analytics.candidatesTried = candidates.length;
  updateAnalytics();
  
  if (candidates.length === 0) {
    analytics.status = 'stuck';
    updateAnalytics();
    showStatus("No nodes with intersections (count=" + count + ")", true);
    stopSolver();
    if (callback) callback(false);
    return;
  }
  
  // Try each candidate node, take the best improvement
  var bestMove = null;
  var totalSamples = 0;
  var candidatesTried = Math.min(candidates.length, 5);
  var movesFound = 0;
  
  for (var i = 0; i < candidatesTried; i++) {
    var nodeIndex = graph.nodes.indexOf(candidates[i].node);
    var move = findBestMoveForNode(candidates[i].node, nodeIndex);
    if (move) {
      totalSamples += move.samples;
      movesFound++;
      if (!bestMove || move.improvement > bestMove.improvement) {
        bestMove = move;
      }
    } else {
      totalSamples += 84 + graph.nodes.length; // approx samples tried
    }
  }
  
  analytics.candidatesTried = candidatesTried + " (" + movesFound + " improved)";
  analytics.samplesTested = totalSamples;
  
  if (bestMove) {
    analytics.status = 'moving';
    analytics.nodeIndex = bestMove.nodeIndex;
    analytics.nodeCrossings = nodeIntersectionCount(bestMove.node);
    analytics.improvement = bestMove.improvement;
    analytics.fromPos = [bestMove.fromX, bestMove.fromY];
    analytics.toPos = [bestMove.x, bestMove.y];
    updateAnalytics();
    
    showStatus("Moving node " + bestMove.nodeIndex + " (improvement: -" + bestMove.improvement + ")", false);
    
    update();
    animateNode(bestMove.node, bestMove.x, bestMove.y, function() {
      moves++;
      moveCounter.text(moves + " move" + (moves !== 1 ? "s" : ""));
      analytics.status = 'idle';
      analytics.crossings = count;
      updateAnalytics();
      if (callback) callback(true);
    });
  } else {
    analytics.status = 'stuck';
    updateAnalytics();
    update();
    showStatus("No improvement found (" + candidatesTried + " nodes, " + totalSamples + " positions tried)", true);
    if (callback) callback(false);
  }
}

// Run solver continuously
function runSolver() {
  if (solverRunning) return;
  solverRunning = true;
  
  function step() {
    if (!solverRunning) return;
    
    solverStep(function(improved) {
      if (!solverRunning) return;
      
      if (improved && count > 0) {
        var speed = +d3.select("#solver-speed").property("value");
        var delay = Math.max(5, 200 - speed * 2);
        solverTimeout = setTimeout(step, delay);
      } else {
        stopSolver();
        if (count === 0) {
          showStatus("Solved!", false);
        } else {
          showStatus("Stuck at " + count + " crossings", true);
        }
      }
    });
  }
  
  step();
}

// Stop solver
function stopSolver() {
  solverRunning = false;
  if (solverTimeout) {
    clearTimeout(solverTimeout);
    solverTimeout = null;
  }
}

// Simple debug step - just move a node visibly
function debugStep() {
  if (graph.nodes.length === 0) {
    showStatus("No graph", true);
    return;
  }
  
  count = intersections(graph.links);
  if (count === 0) {
    showStatus("Already solved", false);
    return;
  }
  
  // Find any node with intersections
  var nodeToMove = null;
  for (var i = 0; i < graph.nodes.length; i++) {
    if (graph.nodes[i].intersection) {
      nodeToMove = graph.nodes[i];
      break;
    }
  }
  
  if (!nodeToMove) {
    showStatus("No intersecting node found (count=" + count + ")", true);
    return;
  }
  
  // Just move it to a random position
  var oldX = nodeToMove[0];
  var oldY = nodeToMove[1];
  showStatus("Moving node from (" + oldX.toFixed(2) + "," + oldY.toFixed(2) + ")", false);
  
  animateNode(nodeToMove, Math.random(), Math.random(), function() {
    moves++;
    moveCounter.text(moves + " move" + (moves !== 1 ? "s" : ""));
    showStatus("Moved! Crossings now: " + count, false);
  });
}

// Wire up solver buttons
d3.select("#move-centroid").on("click", function() {
  stopSolver();
  stepCentroid(null);
});

d3.select("#move-uncross").on("click", function() {
  stopSolver();
  stepUncross(null);
});

d3.select("#move-local").on("click", function() {
  stopSolver();
  stepLocal(null);
});

d3.select("#move-wiggle").on("click", function() {
  stopSolver();
  stepWiggle(null);
});

d3.select("#move-repel").on("click", function() {
  stopSolver();
  stepRepel();
});

d3.select("#solver-run").on("click", function() {
  if (solverRunning) return;
  solverRunning = true;
  
  function step() {
    if (!solverRunning) return;
    
    solverStepMulti(function(moved) {
      if (!solverRunning) return;
      
      if (moved && count > 0) {
        var speed = +d3.select("#solver-speed").property("value");
        var delay = Math.max(5, 200 - speed * 2);
        solverTimeout = setTimeout(step, delay);
      } else {
        stopSolver();
        if (count === 0) {
          showStatus("Solved!", false);
        } else {
          showStatus("Stuck at " + count + " crossings", true);
        }
      }
    });
  }
  
  step();
});

d3.select("#solver-stop").on("click", stopSolver);

// Dump current state to file for debugging
d3.select("#dump-state").on("click", function() {
  count = intersections(graph.links);
  
  var state = {
    timestamp: new Date().toISOString(),
    crossings: count,
    moves: moves,
    selectedNode: selectedNode ? graph.nodes.indexOf(selectedNode) : null,
    nodeCount: graph.nodes.length,
    edgeCount: graph.links.length,
    nodes: graph.nodes.map(function(node, i) {
      return {
        index: i,
        x: node[0].toFixed(4),
        y: node[1].toFixed(4),
        hasIntersection: !!node.intersection,
        neighborCount: getNeighbors(node).length
      };
    }),
    intersectingNodes: graph.nodes
      .map(function(n, i) { return { i: i, n: n }; })
      .filter(function(x) { return x.n.intersection; })
      .map(function(x) { return x.i; }),
    edges: graph.links.map(function(link, i) {
      return {
        index: i,
        from: graph.nodes.indexOf(link[0]),
        to: graph.nodes.indexOf(link[1]),
        hasIntersection: !!link.intersection
      };
    })
  };
  
  // Write to localStorage and show in console-like area
  var stateJson = JSON.stringify(state, null, 2);
  localStorage.setItem('planarityDebugState', stateJson);
  
  // Also try to write to file if in Electron
  if (typeof require !== 'undefined') {
    try {
      var fs = require('fs');
      var path = require('path');
      fs.writeFileSync('state.json', stateJson);
      showStatus("State dumped to state.json", false);
    } catch (e) {
      showStatus("State saved to localStorage", false);
    }
  } else {
    showStatus("State saved to localStorage (check console)", false);
    console.log(stateJson);
  }
});

// ============ BENCHMARK SYSTEM ============

// Non-animated solver step - returns true if improvement made
function solverStepInstant() {
  count = intersections(graph.links);
  if (count === 0) return { done: true, improved: false };
  
  // Try all strategies and pick best
  var moves_found = [];
  
  var centroidMove = findCentroidMove();
  if (centroidMove) moves_found.push(centroidMove);
  
  var uncrossMove = findUncrossMove();
  if (uncrossMove) moves_found.push(uncrossMove);
  
  var localMove = findLocalMove();
  if (localMove) moves_found.push(localMove);
  
  // Pick best improvement
  var bestMove = null;
  moves_found.forEach(function(m) {
    if (!bestMove || m.improvement > bestMove.improvement) {
      bestMove = m;
    }
  });
  
  if (!bestMove || bestMove.improvement <= 0) {
    // Try wiggle as last resort
    var wiggleMove = findWiggleMove();
    if (wiggleMove && wiggleMove.improvement > 0) {
      bestMove = wiggleMove;
    }
  }
  
  if (bestMove && bestMove.improvement > 0) {
    bestMove.node[0] = bestMove.toX;
    bestMove.node[1] = bestMove.toY;
    return { done: false, improved: true, strategy: bestMove.strategy, improvement: bestMove.improvement };
  }
  
  return { done: false, improved: false };
}

// Run solver until solved or stuck, return stats
function solveInstant(maxMoves) {
  maxMoves = maxMoves || 1000;
  var moveCount = 0;
  var stuckCount = 0;
  var maxStuck = 50; // Give up after 50 moves with no improvement
  var strategyUsage = {};
  
  var initialCrossings = intersections(graph.links);
  
  while (moveCount < maxMoves) {
    var result = solverStepInstant();
    
    if (result.done) {
      return {
        solved: true,
        moves: moveCount,
        initialCrossings: initialCrossings,
        finalCrossings: 0,
        strategyUsage: strategyUsage
      };
    }
    
    if (result.improved) {
      moveCount++;
      stuckCount = 0;
      strategyUsage[result.strategy] = (strategyUsage[result.strategy] || 0) + 1;
    } else {
      stuckCount++;
      if (stuckCount >= maxStuck) {
        return {
          solved: false,
          moves: moveCount,
          initialCrossings: initialCrossings,
          finalCrossings: count,
          strategyUsage: strategyUsage
        };
      }
      // Random wiggle to try to escape
      var wiggle = findWiggleMove();
      if (wiggle) {
        wiggle.node[0] = wiggle.toX;
        wiggle.node[1] = wiggle.toY;
        moveCount++;
        strategyUsage['wiggle_escape'] = (strategyUsage['wiggle_escape'] || 0) + 1;
      }
    }
  }
  
  return {
    solved: false,
    moves: moveCount,
    initialCrossings: initialCrossings,
    finalCrossings: count,
    strategyUsage: strategyUsage
  };
}

// Run benchmark on multiple puzzles
function runBenchmark(numPuzzles, nodeCount) {
  numPuzzles = numPuzzles || 10;
  nodeCount = nodeCount || 50;
  
  var results = [];
  var solved = 0;
  var totalMoves = 0;
  var totalInitialCrossings = 0;
  var totalFinalCrossings = 0;
  
  for (var i = 0; i < numPuzzles; i++) {
    // Generate fresh puzzle
    graph = scramble(planarGraph(nodeCount));
    
    var result = solveInstant(2000);
    results.push(result);
    
    if (result.solved) solved++;
    totalMoves += result.moves;
    totalInitialCrossings += result.initialCrossings;
    totalFinalCrossings += result.finalCrossings;
  }
  
  var report = {
    timestamp: new Date().toISOString(),
    config: { numPuzzles: numPuzzles, nodeCount: nodeCount },
    summary: {
      solved: solved,
      solveRate: (solved / numPuzzles * 100).toFixed(1) + '%',
      avgMoves: (totalMoves / numPuzzles).toFixed(1),
      avgInitialCrossings: (totalInitialCrossings / numPuzzles).toFixed(1),
      avgFinalCrossings: (totalFinalCrossings / numPuzzles).toFixed(1),
      avgCrossingReduction: ((1 - totalFinalCrossings / totalInitialCrossings) * 100).toFixed(1) + '%'
    },
    results: results
  };
  
  // Write report
  if (typeof require !== 'undefined') {
    try {
      var fs = require('fs');
      fs.writeFileSync('benchmark.json', JSON.stringify(report, null, 2));
      showStatus("Benchmark complete: " + report.summary.solveRate + " solved", false);
    } catch (e) {
      console.log(report);
    }
  }
  
  // Update display
  update();
  
  return report;
}

// Expose benchmark to console
window.runBenchmark = runBenchmark;

// Wire up benchmark button - use viz version with fewer puzzles
d3.select("#run-benchmark").on("click", function() {
  showStatus("Running benchmark (5 puzzles with viz)...", false);
  setTimeout(function() {
    runBenchmarkWithViz(5, 50);
  }, 100);
});

// ============ SVG EXPORT FOR VISUALIZATION ============

function exportGraphSVG(filename) {
  var svgWidth = 800;
  var svgHeight = 600;
  var padding = 20;
  
  var scaleX = function(v) { return padding + v * (svgWidth - 2 * padding); };
  var scaleY = function(v) { return padding + v * (svgHeight - 2 * padding); };
  
  var svg = '<?xml version="1.0" encoding="UTF-8"?>\n';
  svg += '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgWidth + '" height="' + svgHeight + '">\n';
  svg += '<rect width="100%" height="100%" fill="white"/>\n';
  
  // Draw edges
  graph.links.forEach(function(link, i) {
    var x1 = scaleX(link[0][0]);
    var y1 = scaleY(link[0][1]);
    var x2 = scaleX(link[1][0]);
    var y2 = scaleY(link[1][1]);
    var color = link.intersection ? '#000' : '#fc0';
    svg += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + color + '" stroke-width="1.5"/>\n';
  });
  
  // Draw nodes
  graph.nodes.forEach(function(node, i) {
    var cx = scaleX(node[0]);
    var cy = scaleY(node[1]);
    var fill = node.intersection ? '#0cf' : '#fc0';
    if (node === selectedNode) fill = '#f06';
    svg += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="6" fill="' + fill + '" stroke="#000" stroke-width="1"/>\n';
    svg += '<text x="' + (cx + 8).toFixed(1) + '" y="' + (cy + 4).toFixed(1) + '" font-size="10" fill="#333">' + i + '</text>\n';
  });
  
  // Add stats
  svg += '<text x="10" y="' + (svgHeight - 10) + '" font-size="12" fill="#333">Crossings: ' + count + ' | Nodes: ' + graph.nodes.length + ' | Edges: ' + graph.links.length + '</text>\n';
  
  svg += '</svg>';
  
  if (typeof require !== 'undefined') {
    try {
      var fs = require('fs');
      fs.writeFileSync(filename || 'graph.svg', svg);
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

// Enhanced benchmark that saves visualizations
function runBenchmarkWithViz(numPuzzles, nodeCount) {
  numPuzzles = numPuzzles || 5;
  nodeCount = nodeCount || 50;
  
  var results = [];
  var solved = 0;
  
  // Create viz directory
  if (typeof require !== 'undefined') {
    try {
      var fs = require('fs');
      if (!fs.existsSync('viz')) fs.mkdirSync('viz');
    } catch (e) {}
  }
  
  for (var p = 0; p < numPuzzles; p++) {
    // Generate fresh puzzle
    graph = scramble(planarGraph(nodeCount));
    count = intersections(graph.links);
    
    var initialCrossings = count;
    var moveLog = [];
    
    // Save initial state
    exportGraphSVG('viz/puzzle' + p + '_000_initial.svg');
    
    var moveNum = 0;
    var stuckCount = 0;
    var maxMoves = 500;
    var maxStuck = 30;
    
    while (moveNum < maxMoves && count > 0 && stuckCount < maxStuck) {
      var result = solverStepInstant();
      
      if (result.done) break;
      
      if (result.improved) {
        moveNum++;
        stuckCount = 0;
        moveLog.push({
          move: moveNum,
          strategy: result.strategy,
          improvement: result.improvement,
          crossings: count
        });
        
        // Save every 10th move
        if (moveNum % 10 === 0) {
          count = intersections(graph.links);
          exportGraphSVG('viz/puzzle' + p + '_' + String(moveNum).padStart(3, '0') + '_' + result.strategy + '.svg');
        }
      } else {
        stuckCount++;
        var wiggle = findWiggleMove();
        if (wiggle) {
          wiggle.node[0] = wiggle.toX;
          wiggle.node[1] = wiggle.toY;
        }
      }
    }
    
    count = intersections(graph.links);
    
    // Save final state
    exportGraphSVG('viz/puzzle' + p + '_final_' + count + 'crossings.svg');
    
    results.push({
      puzzle: p,
      solved: count === 0,
      moves: moveNum,
      initialCrossings: initialCrossings,
      finalCrossings: count,
      moveLog: moveLog.slice(-10) // Last 10 moves
    });
    
    if (count === 0) solved++;
  }
  
  var report = {
    timestamp: new Date().toISOString(),
    config: { numPuzzles: numPuzzles, nodeCount: nodeCount },
    summary: {
      solved: solved,
      solveRate: (solved / numPuzzles * 100).toFixed(1) + '%'
    },
    results: results
  };
  
  if (typeof require !== 'undefined') {
    try {
      var fs = require('fs');
      fs.writeFileSync('benchmark.json', JSON.stringify(report, null, 2));
    } catch (e) {}
  }
  
  update();
  showStatus("Benchmark: " + solved + "/" + numPuzzles + " solved. SVGs in viz/", false);
  
  return report;
}

window.runBenchmarkWithViz = runBenchmarkWithViz;
