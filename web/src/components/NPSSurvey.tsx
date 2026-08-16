// This component implements a Net Promoter Score (NPS) survey for collecting user feedback.
// It handles survey display logic, user input, and submission of survey data to the server.

import React, { useState, useEffect } from "react";
import { SiteConfig } from "@/types/siteConfig";
import { getOrCreateUUID } from "@/utils/client/uuid";
import Toast from "@/components/Toast";
import { logEvent } from "@/utils/client/analytics";
import validator from "validator";
import { fetchWithAuth } from "@/utils/client/tokenManager";

interface NPSSurveyProps {
  siteConfig: SiteConfig;
  initialScore?: number | null;
}

const NPSSurvey: React.FC<NPSSurveyProps> = ({ siteConfig, initialScore = null }) => {
  // State variables for managing survey display and user input
  const [score, setScore] = useState<number | null>(initialScore);
  const [feedback, setFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [additionalComments, setAdditionalComments] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [canSubmit, setCanSubmit] = useState<boolean | null>(null);
  const [isCheckingEligibility, setIsCheckingEligibility] = useState(true);
  const [lastSubmissionDate, setLastSubmissionDate] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Check eligibility on component mount
  useEffect(() => {
    const checkEligibility = async () => {
      try {
        const uuid = getOrCreateUUID();
        const response = await fetchWithAuth(`/api/submitNpsSurvey?uuid=${uuid}`, {
          method: "GET",
        });

        if (response.ok) {
          const data = await response.json();
          setCanSubmit(data.canSubmit);
          setLastSubmissionDate(data.lastSubmissionDate);
        } else {
          // If check fails, allow submission attempt (will fail gracefully)
          setCanSubmit(true);
        }
      } catch (error) {
        console.error("Error checking survey eligibility:", error);
        // If check fails, allow submission attempt (will fail gracefully)
        setCanSubmit(true);
      } finally {
        setIsCheckingEligibility(false);
      }
    };

    checkEligibility();
  }, []);

  // Function to validate user input before submission
  const validateInput = () => {
    if (score === null) {
      setErrorMessage("Please select a score");
      return false;
    }
    if (!validator.isInt(score.toString(), { min: 0, max: 10 })) {
      setErrorMessage("Score must be between 0 and 10");
      return false;
    }
    if (feedback && feedback.length > 1000) {
      setErrorMessage("Feedback must be 1000 characters or less");
      return false;
    }
    if (additionalComments.length > 1000) {
      setErrorMessage("Additional comments must be 1000 characters or less");
      return false;
    }
    return true;
  };

  // Function to submit the survey data to the server
  const submitSurvey = async () => {
    if (!validateInput() || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    logEvent("Submit", "NPS_Survey", `Score: ${score}`, score ?? undefined);
    const uuid = getOrCreateUUID();
    const surveyData = {
      uuid,
      score: score!,
      feedback: feedback.trim(),
      additionalComments: additionalComments.trim(),
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await fetchWithAuth("/api/submitNpsSurvey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(surveyData),
      });

      const data = await response.json();

      if (response.ok) {
        // Update local storage and UI state on successful submission
        localStorage.setItem("npsSurveyCompleted", Date.now().toString());
        setErrorMessage(null);
        setToastMessage("Thank you for your feedback!");

        // Redirect to homepage after a delay
        setTimeout(() => {
          window.location.href = "/";
        }, 3000);
      } else {
        // Handle 429 (rate limit) error specially
        if (response.status === 429) {
          setCanSubmit(false);
          setErrorMessage(
            "You have already submitted a survey recently. You can submit another survey in one month. Thank you for your feedback!"
          );
        } else {
          setErrorMessage(data.error || "Error submitting survey. Please try again.");
        }
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error(error);
      setErrorMessage("Error submitting survey: An unexpected error occurred");
      setIsSubmitting(false);
    }
  };

  // Format date for display
  const formatSubmissionDate = (dateString: string | null) => {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    } catch {
      return dateString;
    }
  };

  // Render the survey component and toast message
  // Show loading state while checking eligibility
  if (isCheckingEligibility) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm">
        <div className="text-center py-8">
          <p className="text-gray-600">Loading survey...</p>
        </div>
      </div>
    );
  }

  // Show thank you message if user has already submitted
  if (canSubmit === false) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm">
        <div className="text-center py-8">
          <h1 className="text-2xl font-bold mb-4">Thank You!</h1>
          <p className="text-gray-600 mb-4">
            We appreciate your feedback! You&apos;ve already submitted a survey recently.
          </p>
          {lastSubmissionDate && (
            <p className="text-sm text-gray-500 mb-6">
              Your last submission was on {formatSubmissionDate(lastSubmissionDate)}.
            </p>
          )}
          <p className="text-gray-600 mb-6">
            You can submit another survey in one month. We value your continued feedback!
          </p>
          <button
            className="px-6 py-2 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            onClick={() => (window.location.href = "/")}
          >
            Return to Homepage
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white p-8 rounded-lg shadow-sm">
        {/* Survey questions and input fields */}
        <h1 className="text-2xl font-bold mb-6">
          How likely are you to recommend {siteConfig.shortname} to {siteConfig.other_visitors_reference}?
        </h1>
        {/* Score buttons */}
        <div className="flex flex-col mb-6">
          <div className="flex justify-between gap-2">
            {[...Array(11)].map((_, i) => (
              <button
                key={i}
                className={`flex-1 px-3 py-2 text-sm rounded transition-colors ${
                  score === i ? "bg-blue-500 text-white" : "bg-gray-200 hover:bg-gray-300"
                }`}
                onClick={() => setScore(i)}
              >
                {i}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-2">
            <span>Not likely</span>
            <span>Very likely</span>
          </div>
        </div>
        {/* Feedback textarea */}
        <h2 className="text-lg font-medium mb-2" id="nps-feedback-label">
          What&apos;s the main reason for your score?
        </h2>
        <textarea
          className="w-full p-3 border rounded mb-6 min-h-[100px]"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          maxLength={1000}
          placeholder="Please share your thoughts..."
          aria-labelledby="nps-feedback-label"
        />
        {/* Additional comments textarea */}
        <h2 className="text-lg font-medium mb-2" id="nps-comments-label">
          What would make it even better? Or other comments (optional).
        </h2>
        <textarea
          className="w-full p-3 border rounded mb-6 min-h-[100px]"
          value={additionalComments}
          onChange={(e) => setAdditionalComments(e.target.value)}
          maxLength={1000}
          placeholder="Any additional feedback..."
          aria-labelledby="nps-comments-label"
        />
        {/* Error message display */}
        {errorMessage && (
          <div className="text-red-500 mb-4 p-3 bg-red-50 border border-red-200 rounded">{errorMessage}</div>
        )}
        {/* Action buttons */}
        <div className="flex justify-end gap-3">
          <button
            className="px-6 py-2 rounded bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => (window.location.href = "/")}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            className={`px-6 py-2 rounded transition-colors ${
              score !== null && !isSubmitting
                ? "bg-blue-500 text-white hover:bg-blue-600"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
            onClick={submitSurvey}
            disabled={score === null || isSubmitting}
          >
            {isSubmitting ? "Submitting..." : "Submit"}
          </button>
        </div>
        {/* Privacy notice */}
        <p className="text-xs text-gray-500 mt-6">
          This survey information is collected solely to improve our service.
        </p>
      </div>

      {/* Toast message */}
      {toastMessage && <Toast message={toastMessage} onClose={() => setToastMessage(null)} />}
    </>
  );
};

export default NPSSurvey;
