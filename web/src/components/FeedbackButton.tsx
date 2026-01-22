// Floating feedback button component that appears in the bottom right corner
import React from "react";
import { SiteConfig } from "@/types/siteConfig";

interface FeedbackButtonProps {
  siteConfig: SiteConfig | null;
  onClick: () => void;
}

// Get feedback icon based on site configuration
const getFeedbackIcon = (siteConfig: SiteConfig | null): string => {
  if (!siteConfig?.feedbackIcon) return "/bot-image.png"; // Default fallback
  return `/${siteConfig.feedbackIcon}`;
};

const FeedbackButton: React.FC<FeedbackButtonProps> = ({ siteConfig, onClick }) => {
  const feedbackIcon = getFeedbackIcon(siteConfig);

  return (
    // Hidden on mobile, shown on desktop (md and up)
    <div className="hidden md:block fixed bottom-6 right-6 z-40">
      <button
        onClick={onClick}
        className="flex items-center bg-white rounded-full shadow-lg hover:shadow-xl transition-all duration-300 ease-in-out px-4 py-2 space-x-3 cursor-pointer"
        aria-label="Give feedback"
      >
        {/* Profile photo on the left */}
        <img
          src={feedbackIcon}
          alt="Feedback"
          className="w-10 h-10 rounded-full object-cover flex-shrink-0"
          onError={(e) => {
            // Fallback to default icon if site-specific icon fails to load
            const target = e.target as HTMLImageElement;
            if (target.src !== "/bot-image.png") {
              target.src = "/bot-image.png";
            }
          }}
        />

        {/* Feedback text on the right */}
        <span className="text-gray-800 text-sm font-medium whitespace-nowrap pr-1">Feedback</span>
      </button>
    </div>
  );
};

export default FeedbackButton;
