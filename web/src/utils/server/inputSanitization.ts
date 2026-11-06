/**
 * Input Sanitization Utilities
 *
 * Provides comprehensive input sanitization and validation functions to prevent:
 * - XSS attacks
 * - SQL injection (defense in depth, though Firestore is parameterized)
 * - Command injection
 * - Buffer overflows
 * - Email header injection
 * - Log injection
 */

import { EMAIL_REGEX } from "./emailValidation";
import type { ChatMessage } from "@/utils/shared/chatHistory";

/**
 * Sanitizes text input to prevent XSS and injection attacks
 * Removes or escapes potentially dangerous characters and patterns
 *
 * @param input - The input string to sanitize
 * @param options - Sanitization options
 * @returns Sanitized string safe for storage and logging
 */
export function sanitizeTextInput(
  input: string,
  options: {
    maxLength?: number;
    allowNewlines?: boolean;
    allowSpecialChars?: boolean;
    preserveUserPunctuation?: boolean;
    stripXssPatterns?: boolean;
    escapeQuotes?: boolean;
  } = {}
): string {
  const {
    maxLength = 10000,
    allowNewlines = false,
    allowSpecialChars = false,
    preserveUserPunctuation = false,
    stripXssPatterns = true,
    escapeQuotes = true,
  } = options;

  if (typeof input !== "string") {
    throw new Error("Input must be a string");
  }

  // Check UTF-8 validity and length first
  if (!isValidUTF8(input)) {
    throw new Error("Input contains invalid UTF-8 encoding");
  }

  if (input.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength} characters`);
  }

  let sanitized = input.trim();

  // Remove null bytes and control characters (except newlines if allowed)
  if (allowNewlines) {
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
  } else {
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, "");
  }

  // Remove script tags and event handlers unless the caller keeps markup
  // and escapes HTML later (email HTML bodies).
  if (stripXssPatterns) {
    sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, "");
    sanitized = sanitized.replace(/on\w+\s*=/gi, ""); // onclick=, onload=, etc.
    sanitized = sanitized.replace(/javascript:/gi, "");
    sanitized = sanitized.replace(/data:text\/html/gi, "");
  }

  // SQL-style quote escaping is defense-in-depth for parameterized stores.
  // Skip it when allowSpecialChars is true so apostrophes and quotes stay as typed
  // (Google Sheets and other free-text sinks must not store didn't as didn''t).
  // Skip it when preserveUserPunctuation is true. This app does not send that
  // text to SQL or a shell.
  // Skip it when escapeQuotes is false. The chat model path keeps ' and " as typed
  // and still strips command-injection characters.
  if (!allowSpecialChars && !preserveUserPunctuation && escapeQuotes) {
    sanitized = sanitized.replace(/['";\\]/g, (match) => {
      if (match === "'") return "''";
      if (match === '"') return '\\"';
      if (match === ";") return "";
      return match;
    });
  }

  // Command injection patterns. Skip when the caller keeps user punctuation.
  if (!preserveUserPunctuation) {
    sanitized = sanitized.replace(/[|&;`$(){}[\]]/g, "");
  }

  // Remove HTML/XML tags if not allowing special chars
  if (!allowSpecialChars) {
    sanitized = sanitized.replace(/<[^>]+>/g, "");
  }

  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, " ");

  return sanitized;
}

/**
 * Prefixes a leading apostrophe when Google Sheets would treat the cell as a formula.
 * USER_ENTERED appends interpret values that start with = + - @ as formulas.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  if (value.length === 0) {
    return value;
  }

  const firstChar = value.charAt(0);
  if (firstChar === "=" || firstChar === "+" || firstChar === "-" || firstChar === "@") {
    return `'${value}`;
  }

  return value;
}

/**
 * Sanitizes free-text for a Google Sheets cell.
 * Preserves apostrophes and double quotes. Neutralizes formula injection.
 */
export function sanitizeSpreadsheetText(
  input: string,
  options: { maxLength?: number; allowNewlines?: boolean } = {}
): string {
  const sanitized = sanitizeTextInput(input, {
    maxLength: options.maxLength,
    allowNewlines: options.allowNewlines ?? true,
    allowSpecialChars: true,
  });
  return neutralizeSpreadsheetFormula(sanitized);
}

/**
 * Sanitizes free-text for chat questions and email bodies.
 * Keeps apostrophes, quotes, and common punctuation as typed.
 * Still checks length, UTF-8, and control characters.
 * By default strips HTML tags and XSS patterns. Email callers can keep markup
 * and escape it when the HTML is built.
 */
export function sanitizeUserText(
  input: string,
  options: { maxLength?: number; allowNewlines?: boolean; keepMarkup?: boolean } = {}
): string {
  const keepMarkup = options.keepMarkup === true;
  return sanitizeTextInput(input, {
    maxLength: options.maxLength,
    allowNewlines: options.allowNewlines ?? false,
    allowSpecialChars: keepMarkup,
    preserveUserPunctuation: true,
    stripXssPatterns: !keepMarkup,
  }).trim();
}

/**
 * Sanitizes names (first name, last name, etc.) to prevent XSS attacks
 * Allows quotes and apostrophes (common in names) but removes dangerous patterns
 *
 * @param input - The name string to sanitize
 * @param maxLength - Maximum length for the name (default: 100)
 * @returns Sanitized name safe for storage and display
 */
export function sanitizeName(input: string, maxLength: number = 100): string {
  if (typeof input !== "string") {
    throw new Error("Input must be a string");
  }

  // Check UTF-8 validity and length first
  if (!isValidUTF8(input)) {
    throw new Error("Input contains invalid UTF-8 encoding");
  }

  if (input.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength} characters`);
  }

  let sanitized = input.trim();

  // Remove null bytes and control characters (except spaces)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");

  // Remove potentially dangerous patterns
  // Script tags and event handlers
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, "");
  sanitized = sanitized.replace(/on\w+\s*=/gi, ""); // onclick=, onload=, etc.
  sanitized = sanitized.replace(/javascript:/gi, "");
  sanitized = sanitized.replace(/data:text\/html/gi, "");

  // Remove HTML/XML tags
  sanitized = sanitized.replace(/<[^>]+>/g, "");

  // Remove backslashes to prevent escaping bypass and ensure data consistency
  // This prevents names like "ROBERT \"RAMI\" SMITH" from being stored with backslashes
  sanitized = sanitized.replace(/\\/g, "");

  // Remove command injection patterns (but allow quotes and apostrophes)
  sanitized = sanitized.replace(/[|&;`$(){}[\]]/g, "");

  // Remove semicolons (SQL injection defense)
  sanitized = sanitized.replace(/;/g, "");

  // Normalize whitespace (but preserve single spaces)
  sanitized = sanitized.replace(/\s+/g, " ");

  return sanitized;
}

/**
 * Validates UTF-8 encoding
 * @param input - String to validate
 * @returns True if valid UTF-8
 */
export function isValidUTF8(input: string): boolean {
  try {
    // Try to encode and decode the string
    const encoded = new TextEncoder().encode(input);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    return decoded === input;
  } catch {
    return false;
  }
}

/**
 * Sanitizes email addresses to prevent header injection and validate format
 * @param email - Email address to sanitize
 * @param maxLength - Maximum email length (default: 254 per RFC 5321)
 * @returns Sanitized email address
 * @throws Error if email is invalid or exceeds length
 */
export function sanitizeEmail(email: string, maxLength: number = 254): string {
  if (typeof email !== "string") {
    throw new Error("Email must be a string");
  }

  // Check UTF-8 validity
  if (!isValidUTF8(email)) {
    throw new Error("Email contains invalid UTF-8 encoding");
  }

  // Check length (RFC 5321 specifies 254 character limit)
  if (email.length > maxLength) {
    throw new Error(`Email exceeds maximum length of ${maxLength} characters`);
  }

  // Check before trim so trailing CR/LF/TAB are not silently dropped.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\t\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(email)) {
    throw new Error("Email contains invalid characters (newlines, tabs, or carriage returns)");
  }

  const trimmed = email.trim().toLowerCase();

  // Basic email format validation using centralized regex
  if (!EMAIL_REGEX.test(trimmed)) {
    throw new Error("Invalid email format");
  }

  // Additional validation: check for common injection patterns
  /* eslint-disable no-control-regex */
  const injectionPatterns = [
    /\b(cc|bcc|to|from|subject|content-type):/i, // Email header injection
    /%0[a-d]/i, // URL-encoded newlines
    /\x00/, // Null bytes
  ];
  /* eslint-enable no-control-regex */

  for (const pattern of injectionPatterns) {
    if (pattern.test(trimmed)) {
      throw new Error("Email contains potentially dangerous patterns");
    }
  }

  return trimmed;
}

/**
 * Sanitizes text for safe logging (prevents log injection)
 * Removes newlines and control characters that could manipulate log output
 *
 * @param input - Text to sanitize for logging
 * @param maxLength - Maximum length for log entries (default: 500)
 * @returns Sanitized string safe for logging
 */
export function sanitizeForLogging(input: string, maxLength: number = 500): string {
  if (typeof input !== "string") {
    return String(input).substring(0, maxLength);
  }

  let sanitized = input;

  // Truncate if too long
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "... [truncated]";
  }

  // Remove all control characters including newlines
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x1F\x7F-\x9F]/g, "");

  // Replace multiple spaces with single space
  sanitized = sanitized.replace(/\s+/g, " ");

  return sanitized.trim();
}

export type SanitizedQuestionPair = {
  display: string;
  model: string;
};

/**
 * Validates a chat question and returns two sanitized values.
 * display: keep user punctuation for storage and the UI.
 * model: same strip rules as main, except apostrophes and quotes stay as typed.
 *
 * @param question - Question string to validate
 * @param maxLength - Maximum question length (default: 4000)
 * @returns Display value and model-path value
 * @throws Error if validation fails
 */
export function validateAndSanitizeQuestion(
  question: string,
  maxLength: number = 4000
): SanitizedQuestionPair {
  if (typeof question !== "string") {
    throw new Error("Question must be a string");
  }

  // Check UTF-8 validity
  if (!isValidUTF8(question)) {
    throw new Error("Question contains invalid UTF-8 encoding");
  }

  // Check length
  if (question.length === 0) {
    throw new Error("Question cannot be empty");
  }

  if (question.length > maxLength) {
    throw new Error(`Question exceeds maximum length of ${maxLength} characters`);
  }

  const display = sanitizeUserText(question, {
    maxLength,
    allowNewlines: true,
  })
    .replace(/\n+/g, " ")
    .trim();

  // Model path matches main sanitizeTextInput, except ' and " stay as typed.
  const model = sanitizeTextInput(question, {
    maxLength,
    allowNewlines: true,
    allowSpecialChars: false,
    preserveUserPunctuation: false,
    escapeQuotes: false,
  })
    .replace(/\n+/g, " ")
    .trim();

  if (display.length === 0 || model.length === 0) {
    throw new Error("Question cannot be empty");
  }
  return { display, model };
}

/**
 * Validates client-supplied chat history. The latest question is sanitized
 * separately; history must use the same rules so prompt-injection strings
 * cannot arrive only on prior turns.
 */
export function sanitizeChatHistory(
  history: unknown,
  options: { maxMessages?: number; maxLength?: number } = {}
): ChatMessage[] | undefined {
  if (history === undefined || history === null) {
    return undefined;
  }
  if (!Array.isArray(history)) {
    throw new Error("History must be an array");
  }

  const maxMessages = options.maxMessages ?? 40;
  const maxLength = options.maxLength ?? 4000;
  if (history.length > maxMessages) {
    throw new Error(`History exceeds maximum of ${maxMessages} messages`);
  }

  const sanitized: ChatMessage[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("History items must be objects");
    }
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") {
      throw new Error("History role must be user or assistant");
    }
    if (typeof content !== "string") {
      throw new Error("History content must be a string");
    }
    const { model } = validateAndSanitizeQuestion(content, maxLength);
    sanitized.push({ role, content: model });
  }
  return sanitized;
}
