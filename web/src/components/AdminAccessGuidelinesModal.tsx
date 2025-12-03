import React, { useEffect } from "react";
import { SiteConfig } from "@/types/siteConfig";
import { formatGuidelinesText } from "./AdminAccessGuidelines";

interface AdminAccessGuidelinesModalProps {
  isOpen: boolean;
  onClose: () => void;
  siteConfig: SiteConfig | null;
}

/**
 * Modal component to display access guidelines information.
 * Used on the add users page.
 */
export function AdminAccessGuidelinesModal({ isOpen, onClose, siteConfig }: AdminAccessGuidelinesModalProps) {
  // Handle escape key press
  useEffect(() => {
    function handleEscapeKey(event: KeyboardEvent) {
      if (event.key === "Escape" && isOpen) {
        onClose();
      }
    }

    if (isOpen) {
      document.addEventListener("keydown", handleEscapeKey);
      // Prevent body scroll when modal is open
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("keydown", handleEscapeKey);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, onClose]);

  if (!isOpen || !siteConfig?.adminAccessGuidelines) {
    return null;
  }

  const guidelines = siteConfig.adminAccessGuidelines;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-[100] transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="fixed inset-0 z-[101] flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="bg-blue-50 border-b border-blue-200 px-6 py-4 rounded-t-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <span className="material-icons text-blue-600 mr-3">info</span>
                <h2 className="text-lg font-semibold text-blue-900">Who Can Access {siteConfig.shortname}?</h2>
              </div>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Close"
              >
                <span className="material-icons">close</span>
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="p-6">
            <p className="text-sm text-gray-700 leading-relaxed">{formatGuidelinesText(guidelines)}</p>
          </div>

          {/* Footer */}
          <div className="bg-gray-50 px-6 py-4 rounded-b-lg border-t border-gray-200">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
