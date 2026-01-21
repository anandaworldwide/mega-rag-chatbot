// Footer component for the application
import React from "react";
import Link from "next/link";
import { SiteConfig } from "@/types/siteConfig";
import { getFooterConfig } from "@/utils/client/siteConfig";

interface FooterProps {
  siteConfig: SiteConfig | null;
}

const Footer: React.FC<FooterProps> = ({ siteConfig }) => {
  const footerConfig = getFooterConfig(siteConfig);

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
          </div>
        </div>
      </footer>
      {/* Mobile spacing for feedback button */}
      <div className="pb-20 md:pb-0" />
    </>
  );
};

export default Footer;
