import React, { useState, useEffect } from "react";

interface DownvoteFeedbackModalProps {
  isOpen: boolean;
  docId: string | null;
  onConfirm: (docId: string, reason: string, comment: string, shareIdentity: boolean) => void;
  onCancel: () => void;
  error?: string | null; // Optional error message prop
  /** True while the parent is awaiting the vote/feedback API (show disabled + Sending state). */
  isSubmitting?: boolean;
}

const feedbackReasons = [
  "Incorrect Information",
  "Off-Topic Response",
  "Bad Links",
  "Vague or Unhelpful",
  "Technical Issue",
  "Poor Style or Tone",
  "Other",
];

const DownvoteFeedbackModal: React.FC<DownvoteFeedbackModalProps> = ({
  isOpen,
  docId,
  onConfirm,
  onCancel,
  error,
  isSubmitting = false,
}) => {
  const [selectedReason, setSelectedReason] = useState<string>("");
  const [commentText, setCommentText] = useState<string>("");
  const [shareIdentity, setShareIdentity] = useState<boolean>(true);

  // Reset state when modal opens or docId changes
  useEffect(() => {
    if (isOpen) {
      setSelectedReason("");
      setCommentText("");
      setShareIdentity(true);
    }
  }, [isOpen, docId]);

  // Handle Escape key to close modal
  useEffect(() => {
    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen && !isSubmitting) {
        onCancel();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscapeKey);
    }

    return () => {
      document.removeEventListener("keydown", handleEscapeKey);
    };
  }, [isOpen, isSubmitting, onCancel]);

  if (!isOpen || !docId) {
    return null;
  }

  const handleSubmit = () => {
    if (isSubmitting || !selectedReason || !docId) {
      return;
    }
    onConfirm(docId, selectedReason, commentText, shareIdentity);
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50"
      onClick={() => {
        if (!isSubmitting) {
          onCancel();
        }
      }}
    >
      <div
        className="bg-white p-6 rounded-xl shadow-xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()} // Prevent click inside from closing modal
      >
        <h2 className="text-xl font-semibold mb-4">Why the Downvote?</h2>
        <p className="text-sm text-gray-600 mb-4">
          Please select a reason for your downvote. Your feedback helps us improve.
        </p>

        <div className="space-y-2 mb-4">
          {feedbackReasons.map((reason) => (
            <label
              key={reason}
              className={`flex items-center space-x-2 ${isSubmitting ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
            >
              <input
                type="radio"
                name="feedbackReason"
                value={reason}
                checked={selectedReason === reason}
                onChange={(e) => setSelectedReason(e.target.value)}
                disabled={isSubmitting}
                className="form-radio h-4 w-4 text-indigo-600"
              />
              <span>{reason}</span>
            </label>
          ))}
        </div>

        <div className="mb-4">
          <label htmlFor="feedbackComment" className="block text-sm font-medium text-gray-700 mb-1">
            Optional Comment (max 1000 chars):
          </label>
          <textarea
            id="feedbackComment"
            rows={3}
            maxLength={1000}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            disabled={isSubmitting}
            className="w-full p-2 border border-gray-300 rounded-xl focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          />
        </div>

        <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-3">
          <label
            className={`flex items-start space-x-3 ${isSubmitting ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              checked={shareIdentity}
              onChange={(e) => setShareIdentity(e.target.checked)}
              disabled={isSubmitting}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600"
            />
            <div>
              <div className="text-sm font-medium text-gray-900">Share my identity with this feedback</div>
              <div className="text-sm text-gray-600">
                This is on by default so the team can follow up or reproduce the issue. Turn it off to stay anonymous.
              </div>
            </div>
          </label>
        </div>

        {/* Display error message if provided */}
        {error && (
          <div className="text-red-500 text-sm mb-3 p-2 bg-red-50 rounded border border-red-200">Error: {error}</div>
        )}

        <div className="flex flex-col items-end space-y-2">
          {isSubmitting && (
            <p className="text-sm text-gray-600 w-full text-right" aria-live="polite">
              Sending your feedback…
            </p>
          )}
          <div className="flex justify-end space-x-3 w-full">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!selectedReason || isSubmitting}
              className={`px-4 py-2 text-white rounded ${
                !selectedReason || isSubmitting ? "bg-indigo-300 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700"
              }`}
            >
              {isSubmitting ? "Sending…" : "Submit Feedback"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DownvoteFeedbackModal;
