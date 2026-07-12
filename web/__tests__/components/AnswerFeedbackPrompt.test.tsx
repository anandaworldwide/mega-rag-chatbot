import React from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import AnswerFeedbackPrompt from "@/components/AnswerFeedbackPrompt";

describe("AnswerFeedbackPrompt", () => {
  it("renders the prompt and wires upvote, downvote, and dismiss", () => {
    const onUpvote = jest.fn();
    const onDownvote = jest.fn();
    const onDismiss = jest.fn();

    render(
      <AnswerFeedbackPrompt docId="doc-1" onUpvote={onUpvote} onDownvote={onDownvote} onDismiss={onDismiss} />
    );

    expect(screen.getByText("How did we do?")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Thumbs up"));
    expect(onUpvote).toHaveBeenCalledWith("doc-1");

    fireEvent.click(screen.getByLabelText("Thumbs down"));
    expect(onDownvote).toHaveBeenCalledWith("doc-1");

    fireEvent.click(screen.getByLabelText("Dismiss feedback prompt"));
    expect(onDismiss).toHaveBeenCalled();
  });
});
