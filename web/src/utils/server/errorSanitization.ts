/**
 * Error Sanitization Utilities
 *
 * Prevents information leakage in production by:
 * - Removing stack traces from user-facing errors
 * - Sanitizing error messages to remove API keys, tokens, and sensitive data
 * - Providing safe error messages for production vs development
 */

import { isDevelopment } from "@/utils/env";

/** User-facing copy for LLM auth/quota and infra outages — do not claim Ops email was sent. */
export const CHATBOT_UNAVAILABLE_USER_MESSAGE =
  "The chatbot is temporarily unavailable. Please try again later.";

/**
 * Patterns that indicate sensitive information in error messages
 */
const SENSITIVE_PATTERNS = [
  // API keys and tokens
  /api[_-]?key["\s:=]+([a-zA-Z0-9_-]{20,})/gi,
  /token["\s:=]+([a-zA-Z0-9_-]{20,})/gi,
  /secret["\s:=]+([a-zA-Z0-9_-]{20,})/gi,
  /password["\s:=]+([^\s"']+)/gi,
  /bearer\s+([a-zA-Z0-9_-]{20,})/gi,

  // Pinecone API keys (UUID format)
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,

  // OpenAI API keys (sk- prefix)
  /sk-[a-zA-Z0-9]{32,}/gi,

  // AWS credentials
  /AKIA[0-9A-Z]{16}/gi,
  /aws[_-]?access[_-]?key[_-]?id["\s:=]+([A-Z0-9]{20,})/gi,
  /aws[_-]?secret[_-]?access[_-]?key["\s:=]+([A-Za-z0-9/+=]{40,})/gi,

  // JWT tokens
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,

  // Database connection strings
  /mongodb:\/\/[^\s"']+/gi,
  /postgres:\/\/[^\s"']+/gi,
  /mysql:\/\/[^\s"']+/gi,

  // Email addresses (sometimes sensitive)
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  // File paths (may reveal server structure)
  /\/[a-zA-Z0-9_/-]+\.(key|pem|crt|env|config)/gi,
];

/**
 * True when the error is an LLM provider API-key / auth failure (xAI, OpenAI, Anthropic, etc.).
 * These must never be shown raw to chat users.
 * Requires API-key / provider cues — bare "authentication_error" alone is not enough
 * (avoids misclassifying unrelated auth failures).
 */
export function isLlmProviderAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  return (
    lower.includes("incorrect api key") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("console.x.ai") ||
    /openai[_ ]?api[_ ]?key.*(missing|required|invalid|incorrect)/i.test(message) ||
    /anthropic[_ ]?api[_ ]?key.*(missing|required|invalid|incorrect)/i.test(message) ||
    /xai[_ ]?api[_ ]?key.*(missing|required|invalid|incorrect)/i.test(message) ||
    (/\b(401|403)\b/.test(message) && lower.includes("api key")) ||
    // Anthropic-style auth errors: require both authentication_error and an API-key cue
    (lower.includes("authentication_error") &&
      (lower.includes("api key") ||
        lower.includes("api_key") ||
        lower.includes("api-key") ||
        lower.includes("x-api-key") ||
        lower.includes("anthropic")))
  );
}

/**
 * True when the provider reports credits exhausted, spending limits, or billing/quota blocks.
 * Includes xAI 403 spending-limit messages that mention team UUIDs (never show those to users).
 */
export function isLlmProviderQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  return (
    lower.includes("used all available credits") ||
    lower.includes("purchase more credits") ||
    lower.includes("spending limit") ||
    lower.includes("monthly spending") ||
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient credits") ||
    lower.includes("credit balance") ||
    lower.includes("exceeded your current quota") ||
    (lower.includes("billing") && (lower.includes("hard limit") || lower.includes("quota"))) ||
    (/\b403\b/.test(message) && (lower.includes("credit") || lower.includes("spending") || lower.includes("quota")))
  );
}

/** HTTP 429 / rate-limit style provider blocks (often billed as quota exhaustion). */
export function isLlmProviderRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  return (
    /\b429\b/.test(message) ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  );
}

export type LlmChatFailureKind = "auth" | "quota";

export type LlmChatFailurePlan = {
  kind: LlmChatFailureKind;
  userMessage: string;
  provider: string;
  errorType: "llm_provider_auth_failure" | "llm_provider_quota_failure";
  opsSubject: string;
  opsBody: string;
  throttleKey: string;
};

/**
 * Classifies LLM provider auth / quota / rate-limit failures for chat SSE handling.
 * Auth is checked before quota so credential errors are not mislabeled as billing.
 */
export function classifyLlmProviderChatFailure(error: unknown): LlmChatFailurePlan | null {
  if (isLlmProviderAuthError(error)) {
    const provider = inferLlmProviderFromError(error);
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "auth",
      userMessage: CHATBOT_UNAVAILABLE_USER_MESSAGE,
      provider,
      errorType: "llm_provider_auth_failure",
      opsSubject: `CRITICAL: ${provider} API Key / Auth Failure`,
      opsBody: `${provider} rejected the API key or authentication during chat request processing.

This prevents the system from generating AI responses for affected model arms.

IMMEDIATE ACTION REQUIRED:
1. Verify the provider API key env var for this site (e.g. XAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY)
2. Confirm the key is active and has access to the configured model
3. Rotate the key if it was revoked or leaked

Error details: ${detail}`,
      throttleKey: "llm_provider_auth_failure",
    };
  }

  if (isLlmProviderQuotaError(error) || isLlmProviderRateLimitError(error)) {
    const provider = inferLlmProviderFromError(error);
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "quota",
      userMessage: CHATBOT_UNAVAILABLE_USER_MESSAGE,
      provider,
      errorType: "llm_provider_quota_failure",
      opsSubject: `CRITICAL: ${provider} Credits / Quota / Rate Limit`,
      opsBody: `${provider} returned a credits, spending-limit, quota, or rate-limit error during chat request processing.

This prevents the system from generating AI responses for affected model arms.

IMMEDIATE ACTION REQUIRED:
1. Check the provider console for remaining credits and monthly spending limits
2. Purchase more credits, raise the spending limit, or wait out rate limits
3. Confirm billing status for the team/account used by this site

Error details: ${detail}`,
      throttleKey: "llm_provider_quota_failure",
    };
  }

  return null;
}

/** Best-effort provider label for ops alerts (not shown to users). */
export function inferLlmProviderFromError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (message.includes("x.ai") || message.includes("xai") || message.includes("grok")) {
    return "xAI (Grok)";
  }
  if (message.includes("anthropic") || message.includes("claude")) {
    return "Anthropic";
  }
  if (message.includes("openai") || message.includes("gpt-")) {
    return "OpenAI";
  }
  // xAI credit errors often say "Your team <uuid>" with no provider name; Grok is the usual source.
  if (isLlmProviderQuotaError(error) && /your team [0-9a-f-]{36}/i.test(message)) {
    return "xAI (Grok)";
  }
  return "LLM provider";
}

/**
 * Sanitizes an error message to remove sensitive information
 * @param errorMessage - The error message to sanitize
 * @returns Sanitized error message safe for user-facing output
 */
export function sanitizeErrorMessage(errorMessage: string): string {
  if (!errorMessage || typeof errorMessage !== "string") {
    return "An error occurred";
  }

  let sanitized = errorMessage;

  // Remove sensitive patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Replace with generic placeholder
      if (match.includes("@")) {
        return "[email-redacted]";
      }
      if (match.includes("://")) {
        return "[connection-string-redacted]";
      }
      if (match.length > 20) {
        return "[redacted]";
      }
      return match.substring(0, 4) + "...";
    });
  }

  // Remove common error stack trace indicators
  sanitized = sanitized.replace(/at\s+[^\n]+/g, "");
  sanitized = sanitized.replace(/Error:\s*/g, "");
  sanitized = sanitized.replace(/\s+/g, " ").trim();

  return sanitized || "An error occurred";
}

/**
 * Creates a safe error response for production
 * @param error - The error object
 * @param defaultMessage - Default message if error cannot be safely displayed
 * @returns Safe error message for user-facing output
 */
export function getSafeErrorMessage(
  error: unknown,
  defaultMessage: string = "An error occurred. Please try again later."
): string {
  // Never surface provider credential, quota, or rate-limit failures to end users (dev or prod).
  if (isLlmProviderAuthError(error) || isLlmProviderQuotaError(error) || isLlmProviderRateLimitError(error)) {
    return CHATBOT_UNAVAILABLE_USER_MESSAGE;
  }

  if (isDevelopment()) {
    // In development, show full error details for debugging
    if (error instanceof Error) {
      return error.message || defaultMessage;
    }
    return String(error) || defaultMessage;
  }

  // In production, sanitize error messages
  if (error instanceof Error) {
    const sanitized = sanitizeErrorMessage(error.message);
    // Only return sanitized message if it's meaningful, otherwise use default
    if (sanitized && sanitized.length > 0 && sanitized !== "An error occurred") {
      return sanitized;
    }
  }

  return defaultMessage;
}

/**
 * Sanitizes error details for logging (removes sensitive info but keeps useful context)
 * @param error - The error object
 * @returns Sanitized error object safe for logging
 */
export function sanitizeErrorForLogging(error: unknown): {
  message: string;
  name?: string;
  code?: string;
  type?: string;
} {
  if (error instanceof Error) {
    return {
      message: sanitizeErrorMessage(error.message),
      name: error.name,
      code: (error as any).code,
      type: error.constructor.name,
    };
  }

  return {
    message: sanitizeErrorMessage(String(error)),
  };
}

/**
 * Checks if an error message contains sensitive information
 * @param errorMessage - The error message to check
 * @returns True if sensitive patterns are detected
 */
export function containsSensitiveInfo(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }

  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}
