import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { validateEmailInput } from "@/utils/client/emailParser";
import { SiteConfig } from "@/types/siteConfig";

interface AddUsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddUsers: (emails: string[], customMessage?: string) => Promise<void>;
  isSubmitting?: boolean;
  siteConfig: SiteConfig | null;
}

export function AddUsersModal({ isOpen, onClose, onAddUsers, isSubmitting = false, siteConfig }: AddUsersModalProps) {
  const [emailInput, setEmailInput] = useState("");
  const [customMessage, setCustomMessage] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [adminFirstName, setAdminFirstName] = useState<string>("Admin");

  // Local storage key for persisting custom message
  const CUSTOM_MESSAGE_STORAGE_KEY = "admin-invitation-custom-message";

  // Fetch admin's profile to get first name
  useEffect(() => {
    async function fetchAdminProfile() {
      try {
        const res = await fetch("/api/profile");
        if (res.ok) {
          const profile = await res.json();
          const firstName = profile?.firstName?.trim();
          if (firstName) {
            setAdminFirstName(firstName);
          }
        }
      } catch (error) {
        // Keep default "Admin" if fetch fails
        console.error("Failed to fetch admin profile:", error);
      }
    }

    if (isOpen) {
      fetchAdminProfile();
    }
  }, [isOpen]);

  // Load custom message from local storage and set default when modal opens
  useEffect(() => {
    if (isOpen) {
      // Try to load saved custom message from local storage
      const savedMessage = localStorage.getItem(CUSTOM_MESSAGE_STORAGE_KEY);

      if (savedMessage) {
        // Use saved message exactly as it was saved
        setCustomMessage(savedMessage);
      } else {
        // Use default message if no saved message exists
        // Generate site-specific invitation message
        const siteName = siteConfig?.shortname || siteConfig?.name || "our chatbot";
        const siteTagline = siteConfig?.tagline || "explore and discover answers to your questions";
        const defaultMessage = `Please join us in using ${siteName} to ${siteTagline.toLowerCase()}\n\nAums,\n${adminFirstName}`;
        setCustomMessage(defaultMessage);
      }
    }
  }, [adminFirstName, isOpen, CUSTOM_MESSAGE_STORAGE_KEY, siteConfig]);

  // Save custom message to local storage when it changes
  const handleCustomMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newMessage = e.target.value;
    setCustomMessage(newMessage);

    // Save to local storage (debounced by React's batching)
    if (newMessage.trim()) {
      localStorage.setItem(CUSTOM_MESSAGE_STORAGE_KEY, newMessage);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!emailInput.trim()) {
      setValidationError("Please enter at least one email address");
      return;
    }

    const validation = validateEmailInput(emailInput);

    if (validation.validCount === 0) {
      setValidationError("No valid email addresses found");
      return;
    }

    if (validation.invalidEntries.length > 0) {
      setValidationError(
        `Invalid email format${validation.invalidEntries.length > 1 ? "s" : ""}: ${validation.invalidEntries.join(", ")}`
      );
      return;
    }

    // Check email limit (40 emails maximum)
    const EMAIL_LIMIT = 40;
    if (validation.validEmails.length > EMAIL_LIMIT) {
      setValidationError(
        `Too many email addresses. Please limit to ${EMAIL_LIMIT} emails per invitation batch. You entered ${validation.validEmails.length} emails.`
      );
      return;
    }

    setValidationError(null);

    try {
      // Save the current custom message to local storage before submitting
      if (customMessage.trim()) {
        localStorage.setItem(CUSTOM_MESSAGE_STORAGE_KEY, customMessage);
      }

      await onAddUsers(validation.validEmails, customMessage.trim() || undefined);
      // Clear the form and close modal on success
      setEmailInput("");
      // Don't reset custom message - it will be loaded from storage next time
      onClose();
    } catch (_error) {
      // Error handling is done by the parent component
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setEmailInput("");
      // Don't reset custom message - it will be loaded from storage next time
      setValidationError(null);
      onClose();
    }
  };

  const validation = validateEmailInput(emailInput);
  const hasContent = emailInput.trim().length > 0;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Add Users" className="max-w-4xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email-input" className="block text-sm font-medium text-gray-700 mb-2">
            Email Addresses
          </label>
          <textarea
            id="email-input"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            disabled={isSubmitting}
            className="w-full h-32 px-3 py-2 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="John Doe <john@example.com>, user@example.com"
          />
          <p className="mt-1 text-xs text-gray-500">
            Separate multiple email addresses with commas or new lines. You can use either bare email addresses or names
            with angle brackets. <strong>Maximum 40 emails per batch.</strong>
          </p>
        </div>

        <div>
          <label htmlFor="custom-message" className="block text-sm font-medium text-gray-700 mb-2">
            Custom Message (Optional)
          </label>
          <textarea
            id="custom-message"
            value={customMessage}
            onChange={handleCustomMessageChange}
            disabled={isSubmitting}
            className="w-full h-32 px-3 py-2 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="Enter a personal message to include in the invitation email..."
          />
          <p className="mt-1 text-xs text-gray-500">
            This message will appear prominently at the top of the invitation email. Your custom message will be
            remembered for future invitations.
          </p>
        </div>

        {hasContent && (
          <div className="text-sm text-gray-600">
            {validation.totalEntries > 0 && (
              <div>
                Found {validation.totalEntries} entr{validation.totalEntries === 1 ? "y" : "ies"}
                {validation.validCount > 0 && (
                  <span className="text-green-600">
                    , {validation.validCount} valid email{validation.validCount === 1 ? "" : "s"}
                  </span>
                )}
                {validation.invalidEntries.length > 0 && (
                  <span className="text-red-600">, {validation.invalidEntries.length} invalid</span>
                )}
              </div>
            )}
          </div>
        )}

        {validationError && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">{validationError}</div>
        )}

        <div className="flex justify-end space-x-3 pt-4">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-xl hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || validation.validCount === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Adding..." : `Add ${validation.validCount} User${validation.validCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
