import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import DownvoteFeedbackModal from "@/components/DownvoteFeedbackModal";

describe("DownvoteFeedbackModal", () => {
  const mockOnConfirm = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders modal when open", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    expect(screen.getByText("Why the Downvote?")).toBeInTheDocument();
    expect(
      screen.getByText("Please select a reason for your downvote. Your feedback helps us improve.")
    ).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(
      <DownvoteFeedbackModal isOpen={false} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    expect(screen.queryByText("Why the Downvote?")).not.toBeInTheDocument();
  });

  it("displays all feedback reason options", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    expect(screen.getByText("Incorrect Information")).toBeInTheDocument();
    expect(screen.getByText("Off-Topic Response")).toBeInTheDocument();
    expect(screen.getByText("Bad Links")).toBeInTheDocument();
    expect(screen.getByText("Vague or Unhelpful")).toBeInTheDocument();
    expect(screen.getByText("Technical Issue")).toBeInTheDocument();
    expect(screen.getByText("Poor Style or Tone")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("allows selecting a feedback reason", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    const incorrectInfoOption = screen.getByLabelText("Incorrect Information");
    fireEvent.click(incorrectInfoOption);

    expect(incorrectInfoOption).toBeChecked();
  });

  it("allows entering additional comments", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    const commentTextarea = screen.getByLabelText("Optional Comment (max 1000 chars):");
    fireEvent.change(commentTextarea, { target: { value: "Test comment" } });

    expect(commentTextarea).toHaveValue("Test comment");
  });

  it("calls onConfirm with correct parameters when submitted", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    // Select a reason
    fireEvent.click(screen.getByLabelText("Incorrect Information"));

    // Add a comment
    const commentTextarea = screen.getByLabelText("Optional Comment (max 1000 chars):");
    fireEvent.change(commentTextarea, { target: { value: "Test comment" } });

    // Submit
    fireEvent.click(screen.getByText("Submit Feedback"));

    expect(mockOnConfirm).toHaveBeenCalledWith("test-doc-id", "Incorrect Information", "Test comment", true);
  });

  it("defaults identity sharing to enabled", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("calls onCancel when cancel button is clicked", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it("resets form when modal reopens", async () => {
    const { rerender } = render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    // Select a reason and add comment
    fireEvent.click(screen.getByLabelText("Incorrect Information"));
    const commentTextarea = screen.getByLabelText("Optional Comment (max 1000 chars):");
    fireEvent.change(commentTextarea, { target: { value: "Test comment" } });

    // Close modal
    rerender(
      <DownvoteFeedbackModal isOpen={false} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    // Reopen modal
    rerender(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    // Form should be reset
    expect(screen.getByLabelText("Incorrect Information")).not.toBeChecked();
    expect(screen.getByLabelText("Optional Comment (max 1000 chars):")).toHaveValue("");
  });

  it("displays error message when provided", () => {
    render(
      <DownvoteFeedbackModal
        isOpen={true}
        docId="test-doc-id"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
        error="Test error message"
      />
    );

    // Check that error message container exists with the error text
    const errorContainer = screen.getByText(/Error:.*Test error message/s);
    expect(errorContainer).toBeInTheDocument();
  });

  it("requires reason selection before submission", () => {
    render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    // Try to submit without selecting a reason
    fireEvent.click(screen.getByText("Submit Feedback"));

    // onConfirm should not be called
    expect(mockOnConfirm).not.toHaveBeenCalled();
  });

  it("shows sending state and disables actions while isSubmitting", () => {
    const { rerender } = render(
      <DownvoteFeedbackModal isOpen={true} docId="test-doc-id" onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    fireEvent.click(screen.getByLabelText("Incorrect Information"));

    rerender(
      <DownvoteFeedbackModal
        isOpen={true}
        docId="test-doc-id"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
        isSubmitting={true}
      />
    );

    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByText("Sending your feedback…")).toBeInTheDocument();
    expect(screen.getByLabelText("Incorrect Information")).toBeDisabled();
    expect(screen.getByLabelText("Optional Comment (max 1000 chars):")).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});
