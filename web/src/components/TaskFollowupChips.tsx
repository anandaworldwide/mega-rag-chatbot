import React from "react";
import { logEvent } from "@/utils/client/analytics";

interface TaskFollowupChipsProps {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
  visible: boolean;
  loading?: boolean;
}

export const TaskFollowupChips: React.FC<TaskFollowupChipsProps> = ({
  suggestions,
  onSelect,
  visible,
  loading = false,
}) => {
  if (!visible || suggestions.length === 0) {
    return null;
  }

  const handleClick = (suggestion: string) => {
    logEvent("followup_chip_click", "Tasks", suggestion);
    onSelect(suggestion);
  };

  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Suggested next steps</h4>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((suggestion, index) => (
          <button
            key={index}
            onClick={() => handleClick(suggestion)}
            disabled={loading}
            className={`
              inline-flex items-center px-3 py-1.5 rounded-xl text-sm font-medium
              bg-blue-50 text-blue-700 border border-blue-200
              hover:bg-blue-100 hover:border-blue-300 hover:text-blue-900
              active:bg-blue-200 active:border-blue-400
              transition-all duration-150 ease-in-out
              disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1
              whitespace-nowrap
            `}
            title={`${suggestion}`}
          >
            <span className="material-icons text-blue-500 mr-1.5 text-sm">arrow_forward</span>
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
};
