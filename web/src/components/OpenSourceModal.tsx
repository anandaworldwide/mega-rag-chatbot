/**
 * OpenSourceModal Component
 *
 * This component displays information about the open source project in a modal dialog.
 */

import React from "react";
import { createPortal } from "react-dom";
import { logEvent } from "@/utils/client/analytics";

interface OpenSourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  githubUrl?: string;
}

export const OpenSourceModal: React.FC<OpenSourceModalProps> = ({ isOpen, onClose, githubUrl = "https://github.com/anandaworldwide/mega-rag-chatbot" }) => {
  // Handle Escape key to close modal
  React.useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        onClose();
        logEvent("open_source_modal_close", "UI", "escape_key");
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  // Handle backdrop click to close modal
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
      logEvent("open_source_modal_close", "UI", "backdrop_click");
    }
  };

  // Handle close button click
  const handleCloseClick = () => {
    logEvent("open_source_modal_close", "UI", "close_button");
    onClose();
  };

  // Handle GitHub link click
  const handleGitHubClick = () => {
    logEvent("open_source_github_click", "UI", "github_link");
  };

  // Don't render if not open or if we're on the server
  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  // Use portal to render at document body level
  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[1000]"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="fixed z-[1001] top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white p-6 rounded-xl shadow-lg max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <span className="material-icons text-blue-500 mr-2">code</span>
            About the Open Source Project
          </h3>
          <button
            onClick={handleCloseClick}
            className="text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Close"
          >
            <span className="material-icons">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="space-y-4">
          <p className="text-gray-700">
            The source code behind this site is open source and available for anyone to use. If you have a similar need
            or want to build your own RAG chatbot, you&apos;re free to use and modify this codebase.
          </p>

          <p className="text-gray-700">
            For more information, documentation, and to contribute to the project, visit the GitHub repository:
          </p>

          <div className="pt-2">
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleGitHubClick}
              className="inline-flex items-center text-blue-600 hover:text-blue-800 font-medium"
            >
              <span className="material-icons text-lg mr-2">open_in_new</span>
              View on GitHub
            </a>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
};
