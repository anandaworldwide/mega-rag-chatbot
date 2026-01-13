import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ConversationTitleBar from "@/components/ConversationTitleBar";
import StarButton from "@/components/StarButton";

// Mock StarButton component
jest.mock("@/components/StarButton", () => {
  return jest.fn(({ convId, isStarred, onStarChange, size, location, className }) => (
    <button
      data-testid="star-button"
      data-conv-id={convId}
      data-is-starred={isStarred}
      data-size={size}
      data-location={location}
      className={className}
      onClick={() => onStarChange(convId, !isStarred)}
    >
      {isStarred ? "★" : "☆"}
    </button>
  ));
});

const mockStarButton = StarButton as jest.MockedFunction<typeof StarButton>;

describe("ConversationTitleBar", () => {
  const mockOnStarChange = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockOnStarChange.mockResolvedValue(undefined);
  });

  describe("Rendering", () => {
    it("should render with conversation ID, title, and star state", () => {
      render(
        <ConversationTitleBar
          convId="test-conv-id"
          title="Test Conversation"
          isStarred={false}
          onStarChange={mockOnStarChange}
        />
      );

      expect(screen.getByText("Test Conversation")).toBeInTheDocument();
      expect(screen.getByTestId("star-button")).toBeInTheDocument();
    });

    it("should not render when convId is null", () => {
      const { container } = render(
        <ConversationTitleBar convId={null} title="Test" isStarred={false} onStarChange={mockOnStarChange} />
      );

      expect(container.firstChild).toBeNull();
    });

    it("should not render when convId is undefined", () => {
      const { container } = render(
        <ConversationTitleBar
          convId={undefined as any}
          title="Test"
          isStarred={false}
          onStarChange={mockOnStarChange}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it("should display 'Untitled Conversation' when title is null", () => {
      render(
        <ConversationTitleBar convId="test-conv-id" title={null} isStarred={false} onStarChange={mockOnStarChange} />
      );

      expect(screen.getByText("Untitled Conversation")).toBeInTheDocument();
    });

    it("should display 'Untitled Conversation' when title is empty string", () => {
      render(<ConversationTitleBar convId="test-conv-id" title="" isStarred={false} onStarChange={mockOnStarChange} />);

      expect(screen.getByText("Untitled Conversation")).toBeInTheDocument();
    });

    it("should display the provided title when available", () => {
      render(
        <ConversationTitleBar
          convId="test-conv-id"
          title="My Custom Title"
          isStarred={false}
          onStarChange={mockOnStarChange}
        />
      );

      expect(screen.getByText("My Custom Title")).toBeInTheDocument();
      expect(screen.queryByText("Untitled Conversation")).not.toBeInTheDocument();
    });

    it("should apply correct CSS classes", () => {
      const { container } = render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={false} onStarChange={mockOnStarChange} />
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass(
        "bg-white",
        "border-b",
        "border-gray-200",
        "py-2",
        "mb-4",
        "flex",
        "items-center",
        "gap-3"
      );
    });
  });

  describe("StarButton Integration", () => {
    it("should pass correct props to StarButton", () => {
      render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={true} onStarChange={mockOnStarChange} />
      );

      expect(mockStarButton).toHaveBeenCalledWith(
        expect.objectContaining({
          convId: "test-conv-id",
          isStarred: true,
          size: "sm",
          location: "title_bar",
          className: "flex-shrink-0",
        }),
        {}
      );
    });

    it("should pass unstarred state to StarButton", () => {
      render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={false} onStarChange={mockOnStarChange} />
      );

      expect(mockStarButton).toHaveBeenCalledWith(
        expect.objectContaining({
          isStarred: false,
        }),
        {}
      );
    });

    it("should pass starred state to StarButton", () => {
      render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={true} onStarChange={mockOnStarChange} />
      );

      expect(mockStarButton).toHaveBeenCalledWith(
        expect.objectContaining({
          isStarred: true,
        }),
        {}
      );
    });
  });

  describe("Star Change Handler", () => {
    it("should call onStarChange when star button is clicked", async () => {
      render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={false} onStarChange={mockOnStarChange} />
      );

      const starButton = screen.getByTestId("star-button");
      fireEvent.click(starButton);

      await waitFor(() => {
        expect(mockOnStarChange).toHaveBeenCalledWith("test-conv-id", true);
      });
    });

    it("should call onStarChange with false when unstarring", async () => {
      render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={true} onStarChange={mockOnStarChange} />
      );

      const starButton = screen.getByTestId("star-button");
      fireEvent.click(starButton);

      await waitFor(() => {
        expect(mockOnStarChange).toHaveBeenCalledWith("test-conv-id", false);
      });
    });

    it("should await onStarChange promise", async () => {
      let resolvePromise: () => void;
      const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });
      mockOnStarChange.mockReturnValue(promise);

      render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={false} onStarChange={mockOnStarChange} />
      );

      const starButton = screen.getByTestId("star-button");
      fireEvent.click(starButton);

      // Verify it was called
      expect(mockOnStarChange).toHaveBeenCalled();

      // Resolve the promise
      resolvePromise!();

      await waitFor(() => {
        expect(mockOnStarChange).toHaveBeenCalledWith("test-conv-id", true);
      });
    });
  });

  describe("Accessibility", () => {
    it("should have proper heading structure", () => {
      render(
        <ConversationTitleBar
          convId="test-conv-id"
          title="Test Conversation"
          isStarred={false}
          onStarChange={mockOnStarChange}
        />
      );

      const heading = screen.getByRole("heading", { level: 2 });
      expect(heading).toBeInTheDocument();
      expect(heading).toHaveTextContent("Test Conversation");
    });

    it("should have truncate class on title for long text", () => {
      render(
        <ConversationTitleBar
          convId="test-conv-id"
          title="Very Long Conversation Title That Should Be Truncated"
          isStarred={false}
          onStarChange={mockOnStarChange}
        />
      );

      const heading = screen.getByRole("heading", { level: 2 });
      expect(heading).toHaveClass("truncate");
    });
  });

  describe("Edge Cases", () => {
    it("should handle rapid star/unstar clicks", async () => {
      render(
        <ConversationTitleBar convId="test-conv-id" title="Test" isStarred={false} onStarChange={mockOnStarChange} />
      );

      const starButton = screen.getByTestId("star-button");

      // Rapid clicks
      fireEvent.click(starButton);
      fireEvent.click(starButton);
      fireEvent.click(starButton);

      await waitFor(() => {
        // Should be called multiple times (StarButton handles debouncing)
        expect(mockOnStarChange).toHaveBeenCalled();
      });
    });

    it("should handle very long conversation titles", () => {
      const longTitle = "A".repeat(200);
      render(
        <ConversationTitleBar
          convId="test-conv-id"
          title={longTitle}
          isStarred={false}
          onStarChange={mockOnStarChange}
        />
      );

      expect(screen.getByText(longTitle)).toBeInTheDocument();
    });

    it("should handle special characters in title", () => {
      const specialTitle = "Test & Conversation <with> 'quotes' and \"double quotes\"";
      render(
        <ConversationTitleBar
          convId="test-conv-id"
          title={specialTitle}
          isStarred={false}
          onStarChange={mockOnStarChange}
        />
      );

      expect(screen.getByText(specialTitle)).toBeInTheDocument();
    });
  });
});
