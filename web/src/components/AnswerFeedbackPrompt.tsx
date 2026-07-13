import React, { useEffect, useRef, useState } from "react";

interface AnswerFeedbackPromptProps {
  docId: string;
  onUpvote: (docId: string) => void;
  onDownvote: (docId: string) => void;
  onDismiss: () => void;
}

/**
 * Soft, non-modal prompt shown once after the first answer of a conversation.
 * Bar thumbs remain available; this is an extra nudge for feedback collection.
 */
export default function AnswerFeedbackPrompt({ docId, onUpvote, onDownvote, onDismiss }: AnswerFeedbackPromptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasTriggeredShimmerRef = useRef(false);
  const [isShimmering, setIsShimmering] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let shimmerTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || hasTriggeredShimmerRef.current) {
          return;
        }
        hasTriggeredShimmerRef.current = true;
        observer.disconnect();
        shimmerTimeoutId = setTimeout(() => {
          setIsShimmering(true);
        }, 500);
      },
      { threshold: 0.4 }
    );

    observer.observe(container);
    return () => {
      observer.disconnect();
      if (shimmerTimeoutId !== null) {
        clearTimeout(shimmerTimeoutId);
      }
    };
  }, []);

  return (
    <div className="mt-3 mb-1 flex justify-center">
      <div
        ref={containerRef}
        className={`relative inline-flex items-center gap-3 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 ${
          isShimmering ? "answer-feedback-shimmer" : ""
        }`}
        role="group"
        aria-label="Answer feedback"
        onAnimationEnd={() => setIsShimmering(false)}
      >
        <span className="font-medium text-gray-700">How did we do?</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onUpvote(docId)}
            className="flex h-8 w-8 items-center justify-center rounded-xl hover:bg-white transition-colors"
            title="Thumbs up"
            aria-label="Thumbs up"
          >
            <span className="material-icons text-gray-500 text-[20px]">thumb_up_off_alt</span>
          </button>
          <button
            type="button"
            onClick={() => onDownvote(docId)}
            className="flex h-8 w-8 items-center justify-center rounded-xl hover:bg-white transition-colors"
            title="Thumbs down"
            aria-label="Thumbs down"
          >
            <span className="material-icons text-gray-500 text-[20px]">thumb_down_off_alt</span>
          </button>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-8 w-8 items-center justify-center rounded-xl text-gray-400 hover:bg-white hover:text-gray-600 transition-colors"
          title="Dismiss"
          aria-label="Dismiss feedback prompt"
        >
          <span className="material-icons text-[18px]">close</span>
        </button>
      </div>
    </div>
  );
}
