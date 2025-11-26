import React, { useState, useEffect } from "react";
import { SiteConfig } from "@/types/siteConfig";

interface AdminAccessGuidelinesProps {
  siteConfig: SiteConfig | null;
}

/**
 * Component to display site-specific access guidelines for admins.
 * Uses localStorage to persist dismissal state across page refreshes.
 */
export function AdminAccessGuidelines({ siteConfig }: AdminAccessGuidelinesProps) {
  const [isDismissed, setIsDismissed] = useState(true); // Start as dismissed, will check localStorage

  const storageKey = `admin-guidelines-dismissed-${siteConfig?.siteId || "default"}`;

  useEffect(() => {
    // Check localStorage on mount
    try {
      const dismissed = localStorage.getItem(storageKey);
      setIsDismissed(dismissed === "true");
    } catch {
      // localStorage not available, show banner
      setIsDismissed(false);
    }
  }, [storageKey]);

  const handleDismiss = () => {
    setIsDismissed(true);
    try {
      localStorage.setItem(storageKey, "true");
    } catch {
      // localStorage not available, continue anyway
    }
  };

  // Only show for sites with guidelines configured
  if (!siteConfig?.adminAccessGuidelines || isDismissed) {
    return null;
  }

  const guidelines = siteConfig.adminAccessGuidelines;

  // Parse markdown-style bold text (**text**)
  const formatText = (text: string) => {
    const parts = text.split(/(\*\*.*?\*\*)/g);
    return parts.map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={index} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  return (
    <div className="bg-blue-50 border-l-4 border-blue-600 p-4 mb-6 rounded-r shadow-sm">
      <div className="flex items-start">
        <span className="material-icons text-blue-600 mr-3 mt-0.5">info</span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-blue-900 mb-2">Who Can Access {siteConfig.shortname}?</h3>
          <p className="text-sm text-gray-700 leading-relaxed">{formatText(guidelines)}</p>
        </div>
        <button
          onClick={handleDismiss}
          className="ml-4 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Dismiss"
        >
          <span className="material-icons text-sm">close</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Utility function to format guidelines text (used by modal)
 */
export function formatGuidelinesText(text: string): React.ReactNode {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={index} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={index}>{part}</span>;
  });
}
