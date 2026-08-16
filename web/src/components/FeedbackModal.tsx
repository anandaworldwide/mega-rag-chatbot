import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { SiteConfig } from "@/types/siteConfig";
import { getToken } from "@/utils/client/tokenManager";
import validator from "validator";

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  siteConfig: SiteConfig | null;
}

const FeedbackModal: React.FC<FeedbackModalProps> = ({ isOpen, onClose, siteConfig }) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldsAutoFilled, setFieldsAutoFilled] = useState(false);

  // Auto-fill user data for logged-in users
  useEffect(() => {
    const autoFillUserData = async () => {
      if (!isOpen) return;

      try {
        const token = await getToken();
        if (token && siteConfig?.requireLogin) {
          // Only try to fetch profile if login is required
          const profileResponse = await fetch("/api/profile", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          if (profileResponse.ok) {
            const profileData = await profileResponse.json();
            let autoFilled = false;

            if (profileData.firstName || profileData.lastName) {
              const nameParts = [profileData.firstName, profileData.lastName].filter(Boolean);
              const fullName = nameParts.join(" ");
              setName(fullName);
              autoFilled = true;
            }
            if (profileData.email) {
              setEmail(profileData.email);
              autoFilled = true;
            }

            // Only set as auto-filled if we actually got data
            if (autoFilled) {
              setFieldsAutoFilled(true);
            }
          }
        }
      } catch (error) {
        // Silently fail - user can still fill form manually
        console.warn("Failed to auto-fill user data:", error);
      }
    };

    autoFillUserData();
  }, [isOpen, siteConfig?.requireLogin]);

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setName("");
      setEmail("");
      setMessage("");
      setError(null);
      setIsSubmitting(false);
      setIsSubmitted(false);
      setFieldsAutoFilled(false);
    }
  }, [isOpen]);

  // Validate form inputs
  const validateInputs = () => {
    if (!validator.isLength(name, { min: 1, max: 100 })) {
      setError("Name must be between 1 and 100 characters");
      return false;
    }
    if (!validator.isEmail(email)) {
      setError("Invalid email address");
      return false;
    }
    if (!validator.isLength(message, { min: 1, max: 1000 })) {
      setError("Message must be between 1 and 1000 characters");
      return false;
    }
    return true;
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    if (!validateInputs()) {
      setIsSubmitting(false);
      return;
    }

    try {
      // Get a token first
      const token = await getToken();

      const res = await fetch("/api/contact?mode=feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, email, message }),
      });

      if (res.ok) {
        setIsSubmitted(true);
      } else {
        const data = await res.json();
        setError(data.message || "Failed to send feedback. Please try again later.");
      }
    } catch (error) {
      console.error("Error submitting feedback:", error);
      setError("Failed to send feedback. Please try again later.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      onClose();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Feedback" className="max-w-lg">
      {isSubmitted ? (
        <div className="text-center py-4">
          <div className="mb-4">
            <svg className="mx-auto h-12 w-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-green-600 mb-2">Thanks for your feedback!</h3>
          <p className="text-gray-600 mb-4">We appreciate your input and will use it to improve the site.</p>
          <button
            onClick={handleClose}
            className="bg-blue-500 text-white px-4 py-2 rounded-xl hover:bg-blue-600 transition-colors"
          >
            Close
          </button>
        </div>
      ) : (
        <>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
            <p className="text-blue-800 text-sm">
              We are constantly striving to improve the site and provide the best experience possible. Please send us
              your candid feedback - we appreciate all comments, suggestions, and insights!
            </p>
          </div>

          {/* Display error message if any */}
          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4" role="alert">
              <span className="block sm:inline">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" data-testid="feedback-form">
            <div className="flex space-x-4">
              {/* Name input field */}
              <div className="w-1/2">
                <label htmlFor="feedback-name-input" id="feedback-name-label" className="block text-sm font-medium text-gray-700">
                  Name
                </label>
                <input
                  id="feedback-name-input"
                  name="name"
                  type="text"
                  autoComplete="name"
                  aria-labelledby="feedback-name-label"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={`mt-1 block w-full border rounded-xl shadow-sm px-3 py-2 ${
                    fieldsAutoFilled
                      ? "bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed"
                      : "border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                  }`}
                  required
                  readOnly={fieldsAutoFilled}
                  disabled={isSubmitting}
                  maxLength={100}
                />
              </div>
              {/* Email input field */}
              <div className="w-1/2">
                <label htmlFor="feedback-email-input" id="feedback-email-label" className="block text-sm font-medium text-gray-700">
                  Email
                </label>
                <input
                  id="feedback-email-input"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-labelledby="feedback-email-label"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`mt-1 block w-full border rounded-xl shadow-sm px-3 py-2 ${
                    fieldsAutoFilled
                      ? "bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed"
                      : "border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                  }`}
                  required
                  readOnly={fieldsAutoFilled}
                  disabled={isSubmitting}
                />
              </div>
            </div>
            {/* Message textarea */}
            <div>
              <label htmlFor="feedback-message-input" id="feedback-message-label" className="block text-sm font-medium text-gray-700">
                Your Feedback
              </label>
              <textarea
                id="feedback-message-input"
                name="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-xl shadow-sm px-3 py-2 h-32 focus:ring-blue-500 focus:border-blue-500"
                required
                disabled={isSubmitting}
                maxLength={1000}
                placeholder="Please share your thoughts, suggestions, or any issues you've encountered..."
                aria-labelledby="feedback-message-label"
              />
              <div className="text-right text-xs text-gray-500 mt-1">{message.length}/1000 characters</div>
            </div>
            {/* Submit button */}
            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSubmitting}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-xl hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="bg-blue-500 text-white px-4 py-2 rounded-xl hover:bg-blue-600 disabled:bg-blue-300 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Sending Feedback..." : "Send Feedback"}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
};

export default FeedbackModal;
