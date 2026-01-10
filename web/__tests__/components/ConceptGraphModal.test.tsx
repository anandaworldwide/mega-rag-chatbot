/**
 * Tests for ConceptGraphModal component
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import ConceptGraphModal from "@/components/ConceptGraphModal";
import { Document } from "langchain/document";
import { DocMetadata } from "@/types/DocMetadata";

// Mock dependencies
jest.mock("@/components/ui/Modal", () => ({
  Modal: ({ isOpen, children, title }: any) =>
    isOpen ? (
      <div data-testid="modal">
        <div data-testid="modal-title">{title}</div>
        {children}
      </div>
    ) : null,
}));

jest.mock("@/components/ForceGraph", () => {
  return function ForceGraph() {
    return <div data-testid="force-graph">Force Graph</div>;
  };
});

jest.mock("@/components/ConceptListView", () => {
  return function ConceptListView() {
    return <div data-testid="concept-list-view">Concept List View</div>;
  };
});

jest.mock("@/utils/client/graphUtils", () => ({
  buildInitialGraph: jest.fn().mockReturnValue({
    nodes: [{ id: "query-node", type: "query", label: "Test Query", metadata: {} }],
    edges: [],
  }),
  mergeGraphData: jest.fn().mockImplementation((existing, _expanded) => existing),
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    nodes: [],
    edges: [],
  }),
});

describe("ConceptGraphModal", () => {
  const mockSourceDocs: Document<DocMetadata>[] = [
    {
      pageContent: "Test content",
      metadata: {
        title: "Test Title",
        library: "Test Library",
        type: "text",
      },
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not render when closed", () => {
    render(
      <ConceptGraphModal
        isOpen={false}
        onClose={jest.fn()}
        sourceDocs={mockSourceDocs}
        query="test query"
      />
    );

    expect(screen.queryByTestId("modal")).not.toBeInTheDocument();
  });

  it("should render when open", () => {
    render(
      <ConceptGraphModal
        isOpen={true}
        onClose={jest.fn()}
        sourceDocs={mockSourceDocs}
        query="test query"
      />
    );

    expect(screen.getByTestId("modal")).toBeInTheDocument();
    expect(screen.getByTestId("modal-title")).toHaveTextContent("Concept Graph");
  });

  it("should show loading state initially", async () => {
    render(
      <ConceptGraphModal
        isOpen={true}
        onClose={jest.fn()}
        sourceDocs={mockSourceDocs}
        query="test query"
      />
    );

    // Should show loading indicator
    expect(screen.getByText(/Loading concept graph/i)).toBeInTheDocument();
  });

  it("should fetch graph data on open", async () => {
    render(
      <ConceptGraphModal
        isOpen={true}
        onClose={jest.fn()}
        sourceDocs={mockSourceDocs}
        query="test query"
      />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/concept-graph", expect.any(Object));
    });
  });
});
