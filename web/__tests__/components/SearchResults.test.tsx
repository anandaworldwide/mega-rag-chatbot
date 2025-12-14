import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import SearchResults from "@/components/SearchResults";
import { SearchResult } from "@/types/SearchTypes";

// Mock next/router
jest.mock("next/router", () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}));

// Mock analytics
jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

describe("SearchResults", () => {
  const mockResults: SearchResult[] = [
    {
      pageContent: "This is test content about meditation",
      metadata: {
        title: "Test Title",
        author: "Test Author",
        type: "text",
        library: "Test Library",
      },
      score: 0.95,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns null when no results", () => {
    const { container } = render(
      <SearchResults
        results={[]}
        query="test"
        loading={false}
        total={0}
        windowSize={200}
        hasMore={false}
        onLoadMore={jest.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders results", () => {
    render(
      <SearchResults
        results={mockResults}
        query="test"
        loading={false}
        total={1}
        windowSize={200}
        hasMore={false}
        onLoadMore={jest.fn()}
      />
    );

    expect(screen.getByText("Test Title")).toBeInTheDocument();

    // Use a custom matcher for split text nodes
    const headerSpan = screen.getByText((_content, element) => {
      return (
        element?.tagName.toLowerCase() === "span" &&
        Boolean(element.textContent?.includes("Showing") && element.textContent?.includes("of top 1"))
      );
    });
    expect(headerSpan).toBeInTheDocument();
  });

  it("shows load more button when hasMore is true", () => {
    const onLoadMore = jest.fn();
    render(
      <SearchResults
        results={mockResults}
        query="test"
        loading={false}
        total={2}
        windowSize={200}
        hasMore={true}
        onLoadMore={onLoadMore}
      />
    );

    const loadMoreButton = screen.getByText("Load More");
    expect(loadMoreButton).toBeInTheDocument();

    fireEvent.click(loadMoreButton);
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("disables load more button when loading", () => {
    render(
      <SearchResults
        results={mockResults}
        query="test"
        loading={true}
        total={2}
        windowSize={200}
        hasMore={true}
        onLoadMore={jest.fn()}
      />
    );

    const loadMoreButton = screen.getByText("Loading...");
    expect(loadMoreButton).toBeDisabled();
  });
});
