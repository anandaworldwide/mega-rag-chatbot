import { isDevelopment } from "@/utils/env";

let hasLoggedOverride = false;
let hasLoggedInvalidValue = false;

function getDefaultQueryRateLimitMax(queriesPerUserPerDay: number): number {
  return isDevelopment() ? queriesPerUserPerDay * 10 : queriesPerUserPerDay;
}

function canReadDevQueryRateLimitOverride(): boolean {
  return isDevelopment() && !process.env.VERCEL;
}

function parsePositiveInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * Resolve the chat query rate-limit max.
 *
 * In local development the default is queriesPerUserPerDay times 10.
 * QUERY_RATE_LIMIT_DEV_MAX can replace that default. The process reads
 * the variable only when NODE_ENV is development and VERCEL is not set.
 * The process ignores the variable in production, in test, and on Vercel.
 */
export function resolveQueryRateLimitMax(queriesPerUserPerDay: number): number {
  const defaultMax = getDefaultQueryRateLimitMax(queriesPerUserPerDay);

  if (!canReadDevQueryRateLimitOverride()) {
    return defaultMax;
  }

  const raw = process.env.QUERY_RATE_LIMIT_DEV_MAX;
  if (raw === undefined || raw.trim() === "") {
    return defaultMax;
  }

  const overrideMax = parsePositiveInteger(raw);
  if (overrideMax === null) {
    if (!hasLoggedInvalidValue) {
      hasLoggedInvalidValue = true;
      console.warn(`[rateLimit] QUERY_RATE_LIMIT_DEV_MAX is not a valid positive integer; using default ${defaultMax}`);
    }
    return defaultMax;
  }

  if (!hasLoggedOverride) {
    hasLoggedOverride = true;
    console.log(`[rateLimit] QUERY_RATE_LIMIT_DEV_MAX override active: ${overrideMax}`);
  }
  return overrideMax;
}

export function resetQueryRateLimitDevMaxLogForTests(): void {
  hasLoggedOverride = false;
  hasLoggedInvalidValue = false;
}
