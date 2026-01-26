/**
 * TipsModal Component
 *
 * This component displays site-specific tips and tricks in a modal dialog with carousel navigation.
 * It loads content from site-specific files and presents them in an interactive carousel format.
 *
 * Key features:
 * - Site-specific content loading from /data/[siteId]/tips.txt
 * - Carousel navigation with dots and arrow keys
 * - Modal overlay with backdrop click to close
 * - Keyboard accessibility (Escape key to close)
 * - Loading and error states
 * - Responsive design
 */

import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteTips, parseTipsContent, Tip, TipsData } from "@/utils/client/loadTips";
import { TipsCarousel } from "@/components/TipsCarousel";
import { logEvent } from "@/utils/client/analytics";

interface TipsModalProps {
  isOpen: boolean;
  onClose: () => void;
  siteConfig: SiteConfig | null;
  onVersionLoaded?: (version: number) => void;
}

export const TipsModal: React.FC<TipsModalProps> = ({ isOpen, onClose, siteConfig, onVersionLoaded }) => {
  const [tips, setTips] = useState<Tip[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load tips content when modal opens
  useEffect(() => {
    if (isOpen && siteConfig) {
      setIsLoading(true);
      setError(null);

      loadSiteTips(siteConfig)
        .then((tipsData: TipsData | null) => {
          if (tipsData) {
            const parsedTips = parseTipsContent(tipsData.content, tipsData.config);
            setTips(parsedTips);
            onVersionLoaded?.(tipsData.version);
            logEvent("tips_content_loaded", "Tips", siteConfig.siteId || "unknown", parsedTips.length);
          } else {
            setTips([]);
          }
        })
        .catch((err) => {
          console.error("Failed to load tips:", err);
          setError("Failed to load tips content");
          logEvent("tips_load_error", "Tips", siteConfig.siteId || "unknown");
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [isOpen, siteConfig, onVersionLoaded]);

  // Handle Escape key to close modal
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        onClose();
        logEvent("tips_modal_close", "UI", "escape_key");
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
      logEvent("tips_modal_close", "Tips", "backdrop_click");
    }
  };

  // Handle close button click
  const handleCloseClick = () => {
    logEvent("tips_modal_close", "Tips", "close_button");
    onClose();
  };

  // Don't render if not open or if we're on the server
  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  // Use portal to render at document body level, escaping any parent stacking contexts
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
            <span className="material-icons text-blue-500 mr-2">lightbulb</span>
            Tips & Tricks
          </h3>
          <button
            onClick={handleCloseClick}
            className="text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Close tips"
          >
            <span className="material-icons">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <span className="ml-3 text-gray-600">Loading tips...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              <span className="block sm:inline">{error}</span>
            </div>
          )}

          {!isLoading && !error && Array.isArray(tips) && tips.length === 0 && (
            <div className="text-center py-8 text-gray-600">
              <span className="material-icons text-4xl mb-2 block text-gray-400">info</span>
              No tips available for this site yet.
            </div>
          )}

          {!isLoading && !error && Array.isArray(tips) && tips.length > 0 && <TipsCarousel tips={tips} />}
        </div>

        {/* Footer */}
        {!isLoading && !error && Array.isArray(tips) && tips.length > 0 && (
          <div className="mt-6 pt-4 border-t border-gray-200">
            <p className="text-xs text-gray-500 text-center">
              Have suggestions for more tips? Use the feedback button to let us know!
            </p>
          </div>
        )}
      </div>
    </>,
    document.body
  );
};
