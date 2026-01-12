/* eslint-disable */
/**
 * Global D3 mock for Jest tests
 * Mocks the D3 functions used by ClusterMapGraph component
 */

const createMockSelection = () => {
  const mockSelection = {
    selectAll: jest.fn((selector) => {
      if (selector === "*") {
        return { remove: jest.fn() };
      }
      return mockSelection;
    }),
    remove: jest.fn(),
    append: jest.fn(() => mockSelection),
    attr: jest.fn(() => mockSelection),
    style: jest.fn(() => mockSelection),
    on: jest.fn(() => mockSelection),
    data: jest.fn(() => ({
      enter: jest.fn(() => ({
        append: jest.fn(() => mockSelection),
      })),
      join: jest.fn(() => mockSelection),
    })),
    call: jest.fn(() => mockSelection),
    text: jest.fn(() => mockSelection),
  };
  return mockSelection;
};

// Create callable scale functions with chainable methods
const createScale = () => {
  const scale = jest.fn((value) => value * 400);
  scale.domain = jest.fn(() => scale);
  scale.range = jest.fn(() => scale);
  return scale;
};

module.exports = {
  select: jest.fn(() => createMockSelection()),
  scaleOrdinal: jest.fn(() => createScale()),
  scaleLinear: jest.fn(() => createScale()),
  extent: jest.fn((data, accessor) => {
    if (!data || data.length === 0) return [undefined, undefined];
    const values = accessor ? data.map(accessor) : data;
    return [Math.min(...values), Math.max(...values)];
  }),
  schemeTableau10: ["#4e79a7", "#f28e2c", "#e15759", "#76b7b2", "#59a14f"],
  rgb: jest.fn(() => ({ r: 78, g: 121, b: 167 })),
  zoom: jest.fn(() => ({
    scaleExtent: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    transform: jest.fn(),
  })),
  zoomIdentity: {
    translate: jest.fn(() => ({ scale: jest.fn(() => ({ x: 0, y: 0, k: 1 })) })),
  },
};
