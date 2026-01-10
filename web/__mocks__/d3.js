/**
 * Mock for D3.js library
 * This mock provides a chainable API structure that mirrors D3's patterns
 */

const createMockSelection = () => {
  const mockSelection = {
    selectAll: jest.fn(() => mockSelection),
    select: jest.fn(() => mockSelection),
    remove: jest.fn(() => mockSelection),
    append: jest.fn(() => mockSelection),
    attr: jest.fn(() => mockSelection),
    style: jest.fn(() => mockSelection),
    on: jest.fn(() => mockSelection),
    text: jest.fn(() => mockSelection),
    data: jest.fn(() => mockSelection),
    enter: jest.fn(() => mockSelection),
    exit: jest.fn(() => mockSelection),
    join: jest.fn(() => mockSelection),
    call: jest.fn(() => mockSelection),
    merge: jest.fn(() => mockSelection),
    transition: jest.fn(() => mockSelection),
    duration: jest.fn(() => mockSelection),
    filter: jest.fn(() => mockSelection),
    each: jest.fn((callback) => {
      // Mock each method - call callback with mock data
      return mockSelection;
    }),
  };
  return mockSelection;
};

const mockSimulation = {
  force: jest.fn(() => mockSimulation),
  on: jest.fn(() => mockSimulation),
  stop: jest.fn(),
  alphaTarget: jest.fn(() => mockSimulation),
  restart: jest.fn(() => mockSimulation),
  nodes: jest.fn(() => mockSimulation),
  alpha: jest.fn(() => mockSimulation),
};

module.exports = {
  select: jest.fn(() => createMockSelection()),
  selectAll: jest.fn(() => createMockSelection()),
  forceSimulation: jest.fn(() => mockSimulation),
  forceLink: jest.fn(() => ({
    id: jest.fn().mockReturnThis(),
    distance: jest.fn().mockReturnThis(),
    strength: jest.fn().mockReturnThis(),
    links: jest.fn().mockReturnThis(),
  })),
  forceManyBody: jest.fn(() => ({
    strength: jest.fn().mockReturnThis(),
    distanceMax: jest.fn().mockReturnThis(),
    distanceMin: jest.fn().mockReturnThis(),
  })),
  forceCenter: jest.fn(() => ({
    x: jest.fn().mockReturnThis(),
    y: jest.fn().mockReturnThis(),
  })),
  forceCollide: jest.fn(() => ({
    radius: jest.fn().mockReturnThis(),
    strength: jest.fn().mockReturnThis(),
  })),
  forceX: jest.fn(() => ({
    strength: jest.fn().mockReturnThis(),
    x: jest.fn().mockReturnThis(),
  })),
  forceY: jest.fn(() => ({
    strength: jest.fn().mockReturnThis(),
    y: jest.fn().mockReturnThis(),
  })),
  forceRadial: jest.fn(() => ({
    strength: jest.fn().mockReturnThis(),
    radius: jest.fn().mockReturnThis(),
    x: jest.fn().mockReturnThis(),
    y: jest.fn().mockReturnThis(),
  })),
  zoom: jest.fn(() => ({
    scaleExtent: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    transform: jest.fn().mockReturnThis(),
  })),
  zoomIdentity: {
    translate: jest.fn().mockReturnThis(),
    scale: jest.fn().mockReturnThis(),
  },
  drag: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    filter: jest.fn().mockReturnThis(),
  })),
  scaleLinear: jest.fn(() => {
    const scale = jest.fn((x) => x);
    scale.domain = jest.fn(() => scale);
    scale.range = jest.fn(() => scale);
    return scale;
  }),
  scaleOrdinal: jest.fn(() => {
    const scale = jest.fn((x) => x);
    scale.domain = jest.fn(() => scale);
    scale.range = jest.fn(() => scale);
    return scale;
  }),
  extent: jest.fn(() => [0, 100]),
  max: jest.fn(() => 100),
  min: jest.fn(() => 0),
  line: jest.fn(() => {
    const line = jest.fn(() => "M0,0");
    line.x = jest.fn(() => line);
    line.y = jest.fn(() => line);
    line.curve = jest.fn(() => line);
    return line;
  }),
  arc: jest.fn(() => {
    const arc = jest.fn(() => "M0,0");
    arc.innerRadius = jest.fn(() => arc);
    arc.outerRadius = jest.fn(() => arc);
    arc.startAngle = jest.fn(() => arc);
    arc.endAngle = jest.fn(() => arc);
    return arc;
  }),
  pie: jest.fn(() => {
    const pie = jest.fn(() => []);
    pie.value = jest.fn(() => pie);
    pie.sort = jest.fn(() => pie);
    return pie;
  }),
  hierarchy: jest.fn(() => ({
    sum: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    descendants: jest.fn(() => []),
    links: jest.fn(() => []),
  })),
  tree: jest.fn(() => ({
    size: jest.fn().mockReturnThis(),
    nodeSize: jest.fn().mockReturnThis(),
  })),
  treemap: jest.fn(() => ({
    size: jest.fn().mockReturnThis(),
    padding: jest.fn().mockReturnThis(),
  })),
  // Event helpers
  event: null,
  pointer: jest.fn(() => [0, 0]),
  // Color helpers
  rgb: jest.fn(() => ({ r: 0, g: 0, b: 0, toString: () => "rgb(0,0,0)" })),
  hsl: jest.fn(() => ({ h: 0, s: 0, l: 0, toString: () => "hsl(0,0%,0%)" })),
  color: jest.fn(() => ({ toString: () => "#000000" })),
  interpolate: jest.fn(() => jest.fn()),
  interpolateRgb: jest.fn(() => jest.fn()),
};
