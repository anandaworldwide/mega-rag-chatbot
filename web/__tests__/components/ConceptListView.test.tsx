/**
 * Tests for ConceptListView component
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import ConceptListView from "@/components/ConceptListView";
import { GraphNode, GraphEdge } from "@/types/ConceptGraph";

describe("ConceptListView", () => {
  const mockNodes: GraphNode[] = [
    {
      id: "query-node",
      label: "Test Query",
      type: "query",
      metadata: {
        title: "Test Query",
        library: "",
        contentType: "text",
        snippet: "Test query",
      },
    },
    {
      id: "source-1",
      label: "Source 1",
      type: "source",
      metadata: {
        title: "Source 1",
        library: "Test Library",
        contentType: "text",
        snippet: "Test snippet",
      },
    },
  ];

  const mockEdges: GraphEdge[] = [
    {
      source: "query-node",
      target: "source-1",
      weight: 0.9,
    },
  ];

  it("should render query node", () => {
    render(
      <ConceptListView
        nodes={mockNodes}
        edges={mockEdges}
        onNodeClick={jest.fn()}
        selectedNode={null}
      />
    );

    expect(screen.getByText("Test Query")).toBeInTheDocument();
  });

  it("should render source nodes", () => {
    render(
      <ConceptListView
        nodes={mockNodes}
        edges={mockEdges}
        onNodeClick={jest.fn()}
        selectedNode={null}
      />
    );

    expect(screen.getByText("Source 1")).toBeInTheDocument();
  });

  it("should show expandable sections", () => {
    render(
      <ConceptListView
        nodes={mockNodes}
        edges={mockEdges}
        onNodeClick={jest.fn()}
        selectedNode={null}
      />
    );

    expect(screen.getByText(/Sources/i)).toBeInTheDocument();
  });
});
