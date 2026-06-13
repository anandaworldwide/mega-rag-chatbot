import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import SuggestionPills from "@/components/SuggestionPills";
import { TypedSuggestion } from "@/types/Suggestion";
import { logSuggestionPillLaneShown } from "@/utils/client/analytics";

jest.mock("@/utils/client/analytics", () => ({
  logSuggestionPillLaneShown: jest.fn(),
}));

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

  it("renders apply suggestions in a labeled lane between deeper and broader", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "1", text: "Specific examples?", type: "deeper" },
      { id: "2", text: "A morning practice for this?", type: "apply" },
      { id: "3", text: "Related topics?", type: "broader" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    const labels = screen.getAllByRole("heading", { level: 4 }).map((el) => el.textContent);
    expect(labels).toEqual(["Go deeper", "Take into daily life", "Go broader"]);
    expect(screen.getByText("A morning practice for this?")).toBeInTheDocument();
  });

  it("hides apply lane when no apply suggestions are present", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "1", text: "Specific examples?", type: "deeper" },
      { id: "2", text: "Related topics?", type: "broader" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    expect(screen.queryByText("Take into daily life")).not.toBeInTheDocument();
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

  it("logs lane impression events when suggestions are shown", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "1", text: "Specific examples?", type: "deeper" },
      { id: "2", text: "A morning practice for this?", type: "apply" },
      { id: "3", text: "Related topics?", type: "broader" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    expect(logSuggestionPillLaneShown).toHaveBeenCalledWith("deeper", 1);
    expect(logSuggestionPillLaneShown).toHaveBeenCalledWith("apply", 1);
    expect(logSuggestionPillLaneShown).toHaveBeenCalledWith("broader", 1);
  });

  it("calls onSuggestionClick with apply suggestion position within the lane", () => {
    const suggestions: TypedSuggestion[] = [
      { id: "1", text: "Morning practice for this?", type: "apply" },
      { id: "2", text: "What if I forget?", type: "apply" },
    ];

    render(<SuggestionPills suggestions={suggestions} onSuggestionClick={mockOnSuggestionClick} />);

    fireEvent.click(screen.getByText("What if I forget?"));

    expect(mockOnSuggestionClick).toHaveBeenCalledWith(
      { id: "2", text: "What if I forget?", type: "apply" },
      1
    );
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
