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
          function(d) { return d.intersection; } : count);
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
d3.select("#solver-step").on("click", function() {
  stopSolver();
  solverStep(null);
});
d3.select("#solver-run").on("click", runSolver);
d3.select("#solver-stop").on("click", stopSolver);
