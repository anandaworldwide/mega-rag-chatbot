// Footer component for the application
import React from "react";
import Link from "next/link";
import { SiteConfig } from "@/types/siteConfig";
import { getFooterConfig } from "@/utils/client/siteConfig";

interface FooterProps {
  siteConfig: SiteConfig | null;
  onFeedbackClick?: () => void;
}

// Get feedback icon based on site configuration
const getFeedbackIcon = (siteConfig: SiteConfig | null): string => {
  if (!siteConfig?.feedbackIcon) return "/bot-image.png"; // Default fallback
  return `/${siteConfig.feedbackIcon}`;
};

const Footer: React.FC<FooterProps> = ({ siteConfig, onFeedbackClick }) => {
  const footerConfig = getFooterConfig(siteConfig);
  const feedbackIcon = getFeedbackIcon(siteConfig);

  return (
    <>
      {/* Main footer section */}
      <footer className="bg-white text-gray-500 py-4 border-t border-t-slate-200">
        <div className="mx-auto max-w-[800px] px-4">
          <div className="flex flex-wrap justify-center items-center">
            {footerConfig.links.map((link, index) => {
              // Add default icons if not specified in config
              let icon = link.icon;
              if (!icon) {
                switch (link.label.toLowerCase()) {
                  case "help":
                    icon = "help_outline";
                    break;
                  case "contact":
                    icon = "mail_outline";
                    break;
                  case "open source":
                  case "open source project":
                    icon = "code";
                    break;
                  case "compare ai models":
                    icon = "compare";
                    break;
                }
              }

              const content = (
                <>
                  {link.label}
                  {icon && <span className="material-icons text-sm ml-1">{icon}</span>}
                </>
              );

              // Render non-clickable text
              if (!link.url) {
                return (
                  <span key={index} className="text-sm mx-2 my-1 inline-flex items-center">
                    {content}
                  </span>
                );
              }

              const isExternal = link.url.startsWith("http") || link.url.startsWith("//");

              // Render external link
              if (isExternal) {
                return (
                  <a
                    key={index}
                    href={link.url}
                    className="text-sm hover:text-slate-600 cursor-pointer mx-2 my-1 inline-flex items-center"
                  >
                    {content}
                  </a>
                );
              } else {
                // Render internal link
                return (
                  <Link
                    key={index}
                    href={link.url}
                    className="text-sm hover:text-slate-600 cursor-pointer mx-2 my-1 inline-flex items-center"
                  >
                    {content}
                  </Link>
                );
              }
            })}
            {/* Mobile-only feedback button - inline with other footer links */}
            {onFeedbackClick && (
              <button
                onClick={onFeedbackClick}
                className="md:hidden text-sm hover:text-slate-600 cursor-pointer mx-2 my-1 inline-flex items-center"
                aria-label="Give feedback"
              >
                <img
                  src={feedbackIcon}
                  alt=""
                  className="w-5 h-5 rounded-full object-cover mr-1"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    if (target.src !== "/bot-image.png") {
                      target.src = "/bot-image.png";
                    }
                  }}
                />
                Feedback
              </button>
            )}
          </div>
        </div>
      </footer>
    </>
  );
};

export default Footer;
