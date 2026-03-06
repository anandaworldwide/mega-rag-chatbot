import React from "react";
import { logEvent } from "@/utils/client/analytics";

interface TaskFollowupChipsProps {
  dynamicSuggestions: string[]; // AI-generated context-specific suggestions
  staticSuggestions: string[]; // From task definition (general actions)
  onSelect: (suggestion: string) => void;
  visible: boolean;
  loading?: boolean;
  isLoadingDynamic?: boolean; // Show skeleton for dynamic suggestions while loading
}

export const TaskFollowupChips: React.FC<TaskFollowupChipsProps> = ({
  dynamicSuggestions,
  staticSuggestions,
  onSelect,
  visible,
  loading = false,
  isLoadingDynamic = false,
}) => {
  const hasDynamic = dynamicSuggestions.length > 0;
  const hasStatic = staticSuggestions.length > 0;

  if (!visible || (!hasDynamic && !hasStatic && !isLoadingDynamic)) {
    return null;
  }

  const handleClick = (suggestion: string, isDynamic: boolean) => {
    logEvent("followup_chip_click", "Tasks", `${isDynamic ? "dynamic" : "static"}|${suggestion}`);
    onSelect(suggestion);
  };

  const chipBaseClasses = `
    inline-flex items-center px-3 py-1.5 rounded-xl text-sm font-medium
    transition-all duration-150 ease-in-out
    disabled:opacity-50 disabled:cursor-not-allowed
    focus:outline-none focus:ring-2 focus:ring-offset-1
    text-left
  `;

  const dynamicChipClasses = `
    ${chipBaseClasses}
    bg-blue-50 text-blue-700 border border-blue-200
    hover:bg-blue-100 hover:border-blue-300 hover:text-blue-900
    active:bg-blue-200 active:border-blue-400
    focus:ring-blue-500
  `;

  const staticChipClasses = `
    ${chipBaseClasses}
    bg-gray-50 text-gray-600 border border-gray-200
    hover:bg-gray-100 hover:border-gray-300 hover:text-gray-800
    active:bg-gray-200 active:border-gray-400
    focus:ring-gray-400
  `;

  // Skeleton loader for dynamic suggestions while loading
  const DynamicSkeleton = () => (
    <div className="flex flex-wrap gap-2">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-8 bg-blue-100 rounded-xl animate-pulse"
          style={{ width: `${120 + i * 30}px` }}
        />
      ))}
    </div>
  );

  return (
    <div className="mt-4 space-y-4">
      {/* Dynamic (AI-generated) suggestions section */}
      {(hasDynamic || isLoadingDynamic) && (
        <div>
          <h4 className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <span className="material-icons text-sm">auto_awesome</span>
            From this response
          </h4>
          {isLoadingDynamic ? (
            <DynamicSkeleton />
          ) : (
            <div className="flex flex-wrap gap-2">
              {dynamicSuggestions.map((suggestion, index) => (
                <button
                  key={`dynamic-${index}`}
                  onClick={() => handleClick(suggestion, true)}
                  disabled={loading}
                  className={dynamicChipClasses}
                  title={suggestion}
                >
                  <span className="material-icons text-blue-500 mr-1.5 text-sm">arrow_forward</span>
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Static (general) suggestions section - only show after streaming completes */}
      {hasStatic && !loading && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">General options</h4>
          <div className="flex flex-wrap gap-2">
            {staticSuggestions.map((suggestion, index) => (
              <button
                key={`static-${index}`}
                onClick={() => handleClick(suggestion, false)}
                disabled={loading}
                className={staticChipClasses}
                title={suggestion}
              >
                <span className="material-icons text-gray-400 mr-1.5 text-sm">arrow_forward</span>
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Legacy interface for backward compatibility
 * Use this when you only have a flat list of suggestions (non-task conversations)
 */
interface LegacyTaskFollowupChipsProps {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
  visible: boolean;
  loading?: boolean;
}

export const LegacyTaskFollowupChips: React.FC<LegacyTaskFollowupChipsProps> = ({
  suggestions,
  onSelect,
  visible,
  loading = false,
}) => {
  return (
    <TaskFollowupChips
      dynamicSuggestions={[]}
      staticSuggestions={suggestions}
      onSelect={onSelect}
      visible={visible}
      loading={loading}
      isLoadingDynamic={false}
    />
  );
};
