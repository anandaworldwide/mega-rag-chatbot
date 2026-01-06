/**
 * Email campaign configuration constants
 * Centralizes magic numbers and hardcoded strings for email campaigns
 */

/**
 * NPS Survey campaign configuration
 */
export const NPS_SURVEY_CONFIG = {
  CAMPAIGN_ID: "nps-survey-6month",
  FREQUENCY_DAYS: 180, // 6 months between surveys
  ACTIVITY_WINDOW_HOURS: 72, // Must be active in last 72 hours (3 days)
  VERIFICATION_MIN_DAYS: 3, // Must have verified account at least 3 days ago
  MAX_SEND_RETRIES: 3, // Maximum retries for failed email sends
} as const;

/**
 * Email campaign tracking constants
 */
export const EMAIL_CAMPAIGN_TRACKING = {
  SOURCE: "email",
  MEDIUM: "email",
  SURVEY_INVITE_CAMPAIGN_ID: "survey-invite",
} as const;

/**
 * Email template cache configuration
 */
export const EMAIL_TEMPLATE_CACHE = {
  TTL_MS: 60 * 1000, // 1 minute cache
} as const;
