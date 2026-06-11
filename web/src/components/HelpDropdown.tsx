/**
 * HelpDropdown Component
 *
 * Links to the site help page when configured.
 */

import React from "react";
import { logEvent } from "@/utils/client/analytics";

interface HelpDropdownProps {
  helpUrl?: string;
}

export default function HelpDropdown({ helpUrl }: HelpDropdownProps) {
  if (!helpUrl) {
    return null;
  }

  const handleHelpPageClick = () => {
    logEvent("help_page_click", "Help", "help_link");
  };

  return (
    <a
      href={helpUrl}
      onClick={handleHelpPageClick}
      aria-label="Help"
      className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors flex items-center"
      title="Help"
    >
      <span className="material-icons text-xl">help_outline</span>
    </a>
  );
}
