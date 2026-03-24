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
    graph = scramble(planarGraph(50));

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

generate();

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

// Save game state to localStorage
function saveGame() {
  var state = {
    nodes: graph.nodes,
    links: graph.links.map(function(link) {
      // Store links as indices to avoid circular references
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
    canvasHeight: h
  };
  localStorage.setItem('planarityGame', JSON.stringify(state));
  alert('Game saved!');
}

// Load game state from localStorage
function loadGame() {
  var savedState = localStorage.getItem('planarityGame');
  if (!savedState) {
    alert('No saved game found!');
    return false;
  }

  var state = JSON.parse(savedState);

  // Reconstruct the graph
  graph = {
    nodes: state.nodes,
    links: state.links.map(function(linkIndices) {
      return [state.nodes[linkIndices[0]], state.nodes[linkIndices[1]]];
    })
  };

  // Restore game state
  moves = state.moves;
  start = state.startTime;
  highlightIntersections = state.highlightIntersections;
  d3.select("#nodes").property("value", state.nodeCount);
  d3.select("#intersections").property("checked", highlightIntersections);

  // Restore canvas dimensions
  if (state.canvasWidth && state.canvasHeight) {
    d3.select("#canvas-width").property("value", state.canvasWidth);
    d3.select("#canvas-height").property("value", state.canvasHeight);
    resizeCanvas();
  }

  moveCounter.text(moves + " move" + (moves !== 1 ? "s" : ""));
  update();

  return true;
}

// Check for saved game on load
function checkForSavedGame() {
  return localStorage.getItem('planarityGame') !== null;
}

// Auto-save on every move
var originalUpdate = update;
update = function() {
  originalUpdate();
  // Auto-save after each update
  if (moves > 0) {
    var state = {
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
      canvasHeight: h
    };
    localStorage.setItem('planarityGame', JSON.stringify(state));
  }
};

// Wire up save/load buttons
d3.select("#save").on("click", saveGame);
d3.select("#load").on("click", function() {
  if (loadGame()) {
    alert('Game loaded!');
  }
});
d3.select("#resume").on("click", function() {
  if (checkForSavedGame()) {
    loadGame();
  } else {
    alert('No saved game to resume!');
  }
});
