import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import SuggestionPills from "@/components/SuggestionPills";
import { TypedSuggestion } from "@/types/Suggestion";

describe("SuggestionPills", () => {
  const mockOnSuggestionClick = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders nothing when suggestions array is empty", () => {
    const { container } = render(<SuggestionPills suggestions={[]} onSuggestionClick={mockOnSuggestionClick} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders deeper suggestions in a labeled lane", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "1", text: "What are specific examples?", type: "deeper" },
      { id: "2", text: "How does this work?", type: "deeper" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    expect(screen.getByText("Go deeper")).toBeInTheDocument();
    expect(screen.getByText("What are specific examples?")).toBeInTheDocument();
    expect(screen.getByText("How does this work?")).toBeInTheDocument();
  });

  it("renders broader suggestions in a labeled lane", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "3", text: "Related topics?", type: "broader" },
      { id: "4", text: "What else should I know?", type: "broader" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    expect(screen.getByText("Go broader")).toBeInTheDocument();
    expect(screen.getByText("Related topics?")).toBeInTheDocument();
    expect(screen.getByText("What else should I know?")).toBeInTheDocument();
  });

  it("renders both deeper and broader lanes when both types are present", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "1", text: "Specific examples?", type: "deeper" },
      { id: "2", text: "How does this work?", type: "deeper" },
      { id: "3", text: "Related topics?", type: "broader" },
      { id: "4", text: "What else?", type: "broader" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    expect(screen.getByText("Go deeper")).toBeInTheDocument();
    expect(screen.getByText("Go broader")).toBeInTheDocument();
    expect(screen.getByText("Specific examples?")).toBeInTheDocument();
    expect(screen.getByText("Related topics?")).toBeInTheDocument();
  });

  it("calls onSuggestionClick with correct parameters when a suggestion is clicked", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "1", text: "What are examples?", type: "deeper" },
      { id: "2", text: "How does this work?", type: "deeper" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    const button = screen.getByText("How does this work?");
    fireEvent.click(button);

    expect(mockOnSuggestionClick).toHaveBeenCalledTimes(1);
    expect(mockOnSuggestionClick).toHaveBeenCalledWith(
      { id: "2", text: "How does this work?", type: "deeper" },
      1 // position (second item, 0-indexed)
    );
  });

  it("disables buttons when loading is true", () => {
    const suggestions: TypedSuggestion[] = [{ id: "1", text: "What are examples?", type: "deeper" }];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} loading={true} />);

    const button = screen.getByText("What are examples?");
    expect(button).toBeDisabled();
  });

  it("handles suggestions with sourceDocId and score", () => {
    const suggestions: TypedSuggestion[] = [
      {
        id: "1",
        text: "What are examples?",
        type: "deeper",
        sourceDocId: "doc123",
        score: 0.95,
      },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    expect(screen.getByText("What are examples?")).toBeInTheDocument();
  });
});
