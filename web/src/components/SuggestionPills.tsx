import React from "react";
import { TypedSuggestion } from "@/types/Suggestion";

interface SuggestionPillsProps {
  suggestions: TypedSuggestion[];
  onSuggestionClick: (suggestion: TypedSuggestion, position: number) => void;
  loading?: boolean;
}

const SuggestionPills: React.FC<SuggestionPillsProps> = ({ suggestions, onSuggestionClick, loading = false }) => {
  if (suggestions.length === 0) {
    return null;
  }

  // Separate suggestions by type
  const deeperSuggestions = suggestions.filter((s) => s.type === "deeper");
  const broaderSuggestions = suggestions.filter((s) => s.type === "broader");

  const renderSuggestionButton = (suggestion: TypedSuggestion, position: number) => {
    return (
      <button
        key={suggestion.id}
        onClick={() => onSuggestionClick(suggestion, position)}
        disabled={loading}
        className={`
          inline-flex items-center px-3 py-1.5 rounded-xl text-sm font-medium
          bg-gray-100 text-gray-700 border border-gray-200
          hover:bg-gray-200 hover:border-gray-300 hover:text-gray-900
          active:bg-gray-300 active:border-gray-400
          transition-all duration-150 ease-in-out
          disabled:opacity-50 disabled:cursor-not-allowed
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1
          whitespace-nowrap
        `}
        title={`Ask: ${suggestion.text}`}
      >
        <span className="material-icons text-gray-500 mr-1.5 text-sm">lightbulb</span>
        {suggestion.text}
      </button>
    );
  };

  return (
    <div className="mt-4 space-y-3">
      {/* Deeper suggestions lane */}
      {deeperSuggestions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Go deeper</h4>
          <div className="flex flex-wrap gap-2">
            {deeperSuggestions.map((suggestion, index) => renderSuggestionButton(suggestion, index))}
          </div>
        </div>
      )}

      {/* Broader suggestions lane */}
      {broaderSuggestions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Go broader</h4>
          <div className="flex flex-wrap gap-2">
            {broaderSuggestions.map((suggestion, index) => renderSuggestionButton(suggestion, index))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SuggestionPills;
