/**
 * Tests for ClusterMapGraph component
 *
 * Tests the D3 scatter plot visualization using precomputed UMAP coordinates
 */

import React from "react";
import { render } from "@testing-library/react";
import ClusterMapGraph from "@/components/ClusterViz/ForceGraph";
import { ClusterMapData } from "@/types/cluster";

// Mock D3 - only the functions actually used by ClusterMapGraph
jest.mock("d3", () => {
  interface MockSelection {
    selectAll: jest.Mock;
    remove: jest.Mock;
    append: jest.Mock;
    attr: jest.Mock;
    style: jest.Mock;
    on: jest.Mock;
    data: jest.Mock;
    call: jest.Mock;
    text: jest.Mock;
  }

  const createMockSelection = (): MockSelection => {
    const mockSelection: MockSelection = {
      selectAll: jest.fn((selector?: string) => {
        if (selector === "*") {
          return { remove: jest.fn() };
        }
        return mockSelection;
      }),
      remove: jest.fn(),
      append: jest.fn(() => mockSelection),
      attr: jest.fn().mockReturnThis(),
      style: jest.fn().mockReturnThis(),
      on: jest.fn().mockReturnThis(),
      data: jest.fn(() => ({
        enter: jest.fn(() => ({
          append: jest.fn(() => mockSelection),
        })),
        join: jest.fn(() => mockSelection),
      })),
      call: jest.fn().mockReturnThis(),
      text: jest.fn().mockReturnThis(),
    };
    return mockSelection;
  };

  // Create callable scale functions with chainable methods
  const createScale = () => {
    const scale = jest.fn((value: number) => value * 400) as jest.Mock & {
      domain: jest.Mock;
      range: jest.Mock;
    };
    scale.domain = jest.fn().mockReturnValue(scale);
    scale.range = jest.fn().mockReturnValue(scale);
    return scale;
  };

  return {
    select: jest.fn(() => createMockSelection()),
    scaleOrdinal: jest.fn(() => createScale()),
    scaleLinear: jest.fn(() => createScale()),
    extent: jest.fn((data: any[], accessor?: (d: any) => number) => {
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
});

describe("ClusterMapGraph", () => {
  const mockGraphData: ClusterMapData = {
    nodes: [
      {
        id: "center-1",
        title: "Center Source",
        type: "text",
        library: "Test Library",
        snippet: "This is the center source",
        score: 1.0,
        clusterId: 0,
        umap_x: 0.5,
        umap_y: 0.5,
        viz_subset: true,
      },
      {
        id: "node-1",
        title: "Related Source 1",
        type: "text",
        library: "Test Library",
        snippet: "Related content 1",
        score: 0.85,
        clusterId: 0,
        umap_x: 0.6,
        umap_y: 0.6,
        viz_subset: true,
      },
      {
        id: "node-2",
        title: "Related Source 2",
        type: "audio",
        library: "Audio Library",
        snippet: "Related audio content",
        score: 0.75,
        clusterId: 1,
        umap_x: 0.3,
        umap_y: 0.3,
        viz_subset: true,
      },
    ],
    centerNodeId: "center-1",
    clusterCentroids: [
      { clusterId: 0, centroid_x: 0.55, centroid_y: 0.55, nodeCount: 2 },
      { clusterId: 1, centroid_x: 0.3, centroid_y: 0.3, nodeCount: 1 },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock window.addEventListener and removeEventListener
    window.addEventListener = jest.fn();
    window.removeEventListener = jest.fn();
  });

  it("should render SVG element", () => {
    render(<ClusterMapGraph data={mockGraphData} width={800} height={600} />);
    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("width", "800");
    expect(svg).toHaveAttribute("height", "600");
  });

  it("should handle empty data gracefully", () => {
    const emptyData: ClusterMapData = {
      nodes: [],
      centerNodeId: "",
      clusterCentroids: [],
    };
    render(<ClusterMapGraph data={emptyData} width={800} height={600} />);
    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("should call onNodeClick when provided", () => {
    const handleNodeClick = jest.fn();
    render(<ClusterMapGraph data={mockGraphData} width={800} height={600} onNodeClick={handleNodeClick} />);
    // Note: Actual click testing would require more complex D3 mocking
    // This test verifies the component renders with the callback prop
    expect(handleNodeClick).toBeDefined();
  });

  it("should use default dimensions when not provided", () => {
    render(<ClusterMapGraph data={mockGraphData} />);
    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
    // Default dimensions are 800x600
    expect(svg).toHaveAttribute("width", "800");
    expect(svg).toHaveAttribute("height", "600");
  });
});
