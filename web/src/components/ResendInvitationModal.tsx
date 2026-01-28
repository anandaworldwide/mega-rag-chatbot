import React, { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { SiteConfig } from "@/types/siteConfig";

interface ResendInvitationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResend: (email: string, customMessage?: string) => Promise<void>;
  email: string;
  isSubmitting?: boolean;
  siteConfig: SiteConfig | null;
}

export function ResendInvitationModal({
  isOpen,
  onClose,
  onResend,
  email,
  isSubmitting = false,
  siteConfig,
}: ResendInvitationModalProps) {
  const [customMessage, setCustomMessage] = useState("");
  const [adminFirstName, setAdminFirstName] = useState<string>("Admin");
  // Tracks whether the admin has typed in the textarea. If true we stop
  // overwriting their input when the admin name loads or the modal re-opens.
  const messageModifiedRef = useRef(false);

  const buildDefaultMessage = useCallback(() => {
    const siteName = siteConfig?.shortname || siteConfig?.name || "our chatbot";
    const siteTagline = siteConfig?.tagline || "explore and discover answers to your questions";
    return `Please join us in using ${siteName} to ${siteTagline.toLowerCase()}\n\nAums,\n${adminFirstName}`;
  }, [adminFirstName, siteConfig]);

  function resetMessageState() {
    messageModifiedRef.current = false;
  }

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

  // Set default message when admin name is available or modal opens
  useEffect(() => {
    if (isOpen && !messageModifiedRef.current) {
      setCustomMessage(buildDefaultMessage());
    }
  }, [adminFirstName, buildDefaultMessage, isOpen, siteConfig]);

  // Reset modified flag when modal is closed so next open re-initialises textarea
  useEffect(() => {
    if (!isOpen) {
      resetMessageState();
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await onResend(email, customMessage.trim() || undefined);
      // Clear the form and close modal on success
      setCustomMessage(buildDefaultMessage());
      resetMessageState();
      onClose();
    } catch (_error) {
      // Error handling is done by the parent component
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setCustomMessage(buildDefaultMessage());
      resetMessageState();
      onClose();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Resend Invitation" className="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <p className="text-sm text-gray-600 mb-4">
            Resending invitation to: <strong>{email}</strong>
          </p>
        </div>

        <div>
          <label htmlFor="custom-message" className="block text-sm font-medium text-gray-700 mb-2">
            Custom Message (Optional)
          </label>
          <textarea
            id="custom-message"
            value={customMessage}
            onChange={(e) => {
              messageModifiedRef.current = true;
              setCustomMessage(e.target.value);
            }}
            disabled={isSubmitting}
            className="w-full h-32 px-3 py-2 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="Enter a personal message to include in the invitation email..."
          />
          <p className="mt-1 text-xs text-gray-500">
            This message will appear prominently at the top of the invitation email. You can edit the default message or
            clear it to use the standard invitation.
          </p>
        </div>

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
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Resending..." : "Resend Invitation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
