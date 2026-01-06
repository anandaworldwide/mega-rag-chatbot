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
  } = {}
): string {
  const { maxLength = 10000, allowNewlines = false, allowSpecialChars = false } = options;

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

  // Remove potentially dangerous patterns
  // Script tags and event handlers
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, "");
  sanitized = sanitized.replace(/on\w+\s*=/gi, ""); // onclick=, onload=, etc.
  sanitized = sanitized.replace(/javascript:/gi, "");
  sanitized = sanitized.replace(/data:text\/html/gi, "");

  // SQL injection patterns (defense in depth)
  sanitized = sanitized.replace(/['";\\]/g, (match) => {
    // Escape quotes and semicolons
    if (match === "'") return "''";
    if (match === '"') return '\\"';
    if (match === ";") return "";
    return match;
  });

  // Command injection patterns
  sanitized = sanitized.replace(/[|&;`$(){}[\]]/g, "");

  // Remove HTML/XML tags if not allowing special chars
  if (!allowSpecialChars) {
    sanitized = sanitized.replace(/<[^>]+>/g, "");
  }

  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, " ");

  return sanitized;
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

  const trimmed = email.trim().toLowerCase();

  // Remove email header injection patterns
  // These characters can be used to inject additional headers in email clients
  const dangerousChars = /[\r\n\t]/g;
  if (dangerousChars.test(trimmed)) {
    throw new Error("Email contains invalid characters (newlines, tabs, or carriage returns)");
  }

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

/**
 * Validates and sanitizes a question input for chat API
 * Combines multiple validation checks for security
 *
 * @param question - Question string to validate
 * @param maxLength - Maximum question length (default: 4000)
 * @returns Sanitized question
 * @throws Error if validation fails
 */
export function validateAndSanitizeQuestion(question: string, maxLength: number = 4000): string {
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

  // Sanitize for storage/logging (allows newlines for user input, but sanitizes dangerous patterns)
  const sanitized = sanitizeTextInput(question, {
    maxLength,
    allowNewlines: true, // Allow newlines in questions
    allowSpecialChars: false, // Remove HTML/script tags
  });

  // Normalize newlines to spaces for AI processing (as done in current implementation)
  return sanitized.replace(/\n+/g, " ").trim();
}
