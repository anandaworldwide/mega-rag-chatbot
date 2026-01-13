import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { toast } from "react-toastify";
import StarButton from "@/components/StarButton";
import { logEvent } from "@/utils/client/analytics";

// Mock dependencies
jest.mock("react-toastify", () => ({
  toast: {
    error: jest.fn(),
  },
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

const mockToast = toast as jest.Mocked<typeof toast>;
const mockLogEvent = logEvent as jest.MockedFunction<typeof logEvent>;

describe("StarButton", () => {
  const mockOnStarChange = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockOnStarChange.mockResolvedValue(undefined);
  });

  describe("Rendering", () => {
    it("should render unstarred state correctly", () => {
      render(<StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} />);

      const button = screen.getByRole("button", { name: "Star conversation" });
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent("☆");
      expect(button).toHaveAttribute("title", "Star conversation");
    });

    it("should render starred state correctly", () => {
      render(<StarButton convId="test-conv-id" isStarred={true} onStarChange={mockOnStarChange} />);

      const button = screen.getByRole("button", { name: "Unstar conversation" });
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent("★");
      expect(button).toHaveAttribute("title", "Unstar conversation");
    });

    it("should apply custom size classes", () => {
      render(<StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} size="lg" />);

      const button = screen.getByRole("button");
      expect(button).toHaveClass("w-6", "h-6", "text-lg");
    });

    it("should apply custom className", () => {
      render(
        <StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} className="custom-class" />
      );

      const button = screen.getByRole("button");
      expect(button).toHaveClass("custom-class");
    });
  });

  describe("Interaction", () => {
    it("should call onStarChange when clicked", async () => {
      render(<StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} />);

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockOnStarChange).toHaveBeenCalledWith("test-conv-id", true);
      });
    });

    it("should show loading state during operation", async () => {
      // Make onStarChange take some time to resolve
      mockOnStarChange.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      render(<StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} />);

      const button = screen.getByRole("button");
      fireEvent.click(button);

      // Should show loading spinner
      expect(screen.getByRole("button")).toHaveClass("opacity-50", "cursor-not-allowed");
      expect(screen.getByRole("button")).toBeDisabled();

      await waitFor(() => {
        expect(mockOnStarChange).toHaveBeenCalled();
      });
    });

    it("should track analytics on successful star action", async () => {
      render(<StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} />);

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockLogEvent).toHaveBeenCalledWith("star_conversation", "Conversation Management", "Star - other", 1);
      });
    });

    it("should track analytics with location prop", async () => {
      render(
        <StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} location="title_bar" />
      );

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockLogEvent).toHaveBeenCalledWith(
          "star_conversation",
          "Conversation Management",
          "Star - title_bar",
          1
        );
      });
    });

    it("should handle errors with rollback and toast notification", async () => {
      const mockError = new Error("Network error");
      mockOnStarChange.mockRejectedValue(mockError);

      render(<StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} />);

      const button = screen.getByRole("button");

      // Initial state should be unstarred
      expect(button).toHaveTextContent("☆");

      fireEvent.click(button);

      await waitFor(() => {
        // Should rollback to unstarred state after error
        expect(button).toHaveTextContent("☆");
        expect(mockToast.error).toHaveBeenCalledWith("Failed to update star status. Please try again.");
        expect(mockLogEvent).toHaveBeenCalledWith(
          "star_action_failed",
          "Conversation Management",
          "Failed Star - other",
          1
        );
      });
    });

    it("should prevent multiple clicks during loading", async () => {
      mockOnStarChange.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      render(<StarButton convId="test-conv-id" isStarred={false} onStarChange={mockOnStarChange} />);

      const button = screen.getByRole("button");

      // Click multiple times rapidly
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockOnStarChange).toHaveBeenCalledTimes(1);
      });
    });
  });
});
