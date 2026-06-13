'use client';

import { event } from 'nextjs-google-analytics';
import { SuggestionType } from '@/types/Suggestion';

export type AnalyticsParams = Record<string, string | number | boolean>;

export const logEvent = (
  action: string,
  category: string,
  label: string,
  value?: number,
  params?: AnalyticsParams,
) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(
      'skipping logEvent in dev mode',
      action,
      category,
      label,
      value,
      params,
    );
  } else {
    event(action, {
      category: category,
      label: label,
      value: value,
      ...params,
    });
  }
};

/** Log a guided-workflow event with a GA4-queryable task_id parameter. */
export const logTaskEvent = (
  action: string,
  taskId: string,
  value?: number,
) => {
  logEvent(action, 'Tasks', taskId, value, { task_id: taskId });
};

/** Log a follow-up suggestion pill click with a GA4-queryable suggestion_type (deeper | apply | broader). */
export const logSuggestionPillClick = (
  suggestionType: SuggestionType,
  text: string,
  position: number,
) => {
  logEvent('suggestion_pill_click', 'Engagement', text, position, {
    suggestion_type: suggestionType,
  });
};

/** Log when a follow-up suggestion lane is shown (once per answer's suggestion set). */
export const logSuggestionPillLaneShown = (
  suggestionType: SuggestionType,
  pillCount: number,
) => {
  logEvent('suggestion_pill_shown', 'Engagement', suggestionType, pillCount, {
    suggestion_type: suggestionType,
    pill_count: pillCount,
  });
};
