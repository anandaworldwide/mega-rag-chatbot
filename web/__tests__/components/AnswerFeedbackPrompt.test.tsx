import React from "react";
import { render, fireEvent, screen, act } from "@testing-library/react";
import AnswerFeedbackPrompt from "@/components/AnswerFeedbackPrompt";

describe("AnswerFeedbackPrompt", () => {
  let intersectionCallback: IntersectionObserverCallback | null = null;

  beforeEach(() => {
    intersectionCallback = null;
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
      takeRecords = jest.fn(() => []);
      root = null;
      rootMargin = "";
      thresholds = [];
    }
    Object.defineProperty(window, "IntersectionObserver", {
      writable: true,
      configurable: true,
      value: MockIntersectionObserver,
    });
  });

  it("renders the prompt and wires upvote, downvote, and dismiss", () => {
    const onUpvote = jest.fn();
    const onDownvote = jest.fn();
    const onDismiss = jest.fn();

    render(
      <AnswerFeedbackPrompt docId="doc-1" onUpvote={onUpvote} onDownvote={onDownvote} onDismiss={onDismiss} />
    );

    expect(screen.getByText("How did we do?")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Answer feedback" })).toHaveClass("rounded-2xl");

    fireEvent.click(screen.getByLabelText("Thumbs up"));
    expect(onUpvote).toHaveBeenCalledWith("doc-1");

    fireEvent.click(screen.getByLabelText("Thumbs down"));
    expect(onDownvote).toHaveBeenCalledWith("doc-1");

    fireEvent.click(screen.getByLabelText("Dismiss feedback prompt"));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("adds a one-shot shimmer class 500ms after first scrolled into view", () => {
    jest.useFakeTimers();
    render(
      <AnswerFeedbackPrompt docId="doc-1" onUpvote={jest.fn()} onDownvote={jest.fn()} onDismiss={jest.fn()} />
    );

    const prompt = screen.getByRole("group", { name: "Answer feedback" });
    expect(prompt).not.toHaveClass("answer-feedback-shimmer");

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true, target: prompt } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(prompt).not.toHaveClass("answer-feedback-shimmer");

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(prompt).toHaveClass("answer-feedback-shimmer");

    fireEvent.animationEnd(prompt);
    expect(prompt).not.toHaveClass("answer-feedback-shimmer");
    jest.useRealTimers();
  });
});
