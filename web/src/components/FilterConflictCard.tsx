import React from "react";
import { FilterConflictAction, TitleScopeFilterConflictPayload } from "@/types/titleScope";

interface FilterConflictCardProps {
  payload: TitleScopeFilterConflictPayload;
  onApplyAction: (action: FilterConflictAction) => void;
  onDismiss?: () => void;
}

/**
 * Inline recovery when the selected source cannot match current author / library / media filters.
 */
export const FilterConflictCard: React.FC<FilterConflictCardProps> = ({ payload, onApplyAction, onDismiss }) => {
  return (
    <div
      className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950"
      role="region"
      aria-label="Filter conflict"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-amber-900">This source does not match your current filters</h4>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
          >
            Dismiss
          </button>
        ) : null}
      </div>
      <p className="mt-2 whitespace-pre-line text-sm text-amber-900">{payload.summaryMessage}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {payload.actions.map((action, index) => (
          <button
            key={`${action.kind}-${index}-${action.label}`}
            type="button"
            onClick={() => onApplyAction(action)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              action.isPrimary
                ? "bg-amber-700 text-white hover:bg-amber-800"
                : "border border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
            }`}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
};
