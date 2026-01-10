/**
 * Tests for ForceGraph component
 * D3 is mocked globally via __mocks__/d3.js
 */

import React from "react";
import { render } from "@testing-library/react";
import ForceGraph from "@/components/ForceGraph";
import { GraphNode, GraphEdge } from "@/types/ConceptGraph";

describe("ForceGraph", () => {
  const mockNodes: GraphNode[] = [
    {
      id: "node-1",
      label: "Node 1",
      type: "source",
      metadata: {
        title: "Node 1",
        library: "Test Library",
        contentType: "text",
        snippet: "Test snippet",
      },
    },
  ];

  const mockEdges: GraphEdge[] = [];

  it("should render SVG element", () => {
    const { container } = render(
      <ForceGraph
        nodes={mockNodes}
        edges={mockEdges}
        onNodeClick={jest.fn()}
        selectedNode={null}
        width={800}
        height={600}
      />
    );

    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("should handle empty nodes gracefully", () => {
    const { container } = render(
      <ForceGraph nodes={[]} edges={[]} onNodeClick={jest.fn()} selectedNode={null} width={800} height={600} />
    );

    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("should set SVG dimensions from props", () => {
    const { container } = render(
      <ForceGraph
        nodes={mockNodes}
        edges={mockEdges}
        onNodeClick={jest.fn()}
        selectedNode={null}
        width={1000}
        height={700}
      />
    );

    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "1000");
    expect(svg).toHaveAttribute("height", "700");
  });
});
