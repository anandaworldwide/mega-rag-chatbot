'use client';

import { event } from 'nextjs-google-analytics';

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
