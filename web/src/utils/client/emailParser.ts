/**
 * Parses email addresses from a multi-line text input.
 * Supports both comma and newline separation.
 * Handles both bare email addresses and names with angle brackets (e.g., "John Doe <john@example.com>")
 */

interface ParsedEmail {
  email: string;
  name?: string;
}

/**
 * Parses a string containing multiple email addresses separated by commas or newlines
 * @param input - The input string containing email addresses
 * @returns Array of parsed email objects with email and optional name
 */
export function parseEmailAddresses(input: string): ParsedEmail[] {
  if (!input || typeof input !== "string" || !input.trim()) {
    return [];
  }

  // Validate UTF-8 encoding
  try {
    const encoded = new TextEncoder().encode(input);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    if (decoded !== input) {
      return []; // Invalid UTF-8
    }
  } catch {
    return []; // UTF-8 validation failed
  }

  // Prevent buffer overflow from extremely long inputs
  // Allow up to 10KB of input (reasonable for bulk email entry)
  if (input.length > 10000) {
    return [];
  }

  // Split by both commas and newlines, then filter out empty entries
  const entries = input
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const parsed: ParsedEmail[] = [];

  for (const entry of entries) {
    const emailData = parseEmailEntry(entry);
    if (emailData) {
      parsed.push(emailData);
    }
  }

  return parsed;
}

/**
 * Parses a single email entry which can be either:
 * - A bare email address: "user@example.com"
 * - A name with angle brackets: "John Doe <user@example.com>"
 * @param entry - The email entry to parse
 * @returns Parsed email object or null if invalid
 */
function parseEmailEntry(entry: string): ParsedEmail | null {
  // Validate UTF-8 and length to prevent buffer overflows
  try {
    const encoded = new TextEncoder().encode(entry);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    if (decoded !== entry) {
      return null; // Invalid UTF-8
    }
  } catch {
    return null; // UTF-8 validation failed
  }

  // Prevent buffer overflow from overly long inputs (RFC 5321: 254 chars for email, allow extra for name)
  if (entry.length > 500) {
    return null;
  }

  const trimmed = entry.trim();

  if (!trimmed) {
    return null;
  }

  // Check if it has angle brackets (name format)
  const angleMatch = trimmed.match(/^(.+?)\s*<(.+?)>$/);

  if (angleMatch) {
    // Format: "Name <email@example.com>"
    const name = angleMatch[1].trim().replace(/^["']|["']$/g, ""); // Remove quotes if present
    const email = angleMatch[2].trim();

    if (isValidEmail(email)) {
      return { email, name };
    }
  } else {
    // Format: "email@example.com" (bare email)
    if (isValidEmail(trimmed)) {
      return { email: trimmed };
    }
  }

  return null;
}

/**
 * Validates if a string is a valid email address
 * Includes UTF-8 validation and length checks to prevent buffer overflows
 * @param email - The email string to validate
 * @returns True if valid email format
 */
export function isValidEmail(email: string): boolean {
  if (typeof email !== "string") {
    return false;
  }

  // Check UTF-8 validity
  try {
    const encoded = new TextEncoder().encode(email);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    if (decoded !== email) {
      return false;
    }
  } catch {
    return false;
  }

  // Check length (RFC 5321 specifies 254 character limit for email addresses)
  if (email.length > 254) {
    return false;
  }

  // Check for email header injection patterns
  const dangerousChars = /[\r\n\t]/;
  if (dangerousChars.test(email)) {
    return false;
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Extracts just the email addresses from parsed email data
 * @param parsedEmails - Array of parsed email objects
 * @returns Array of email address strings
 */
export function extractEmailAddresses(parsedEmails: ParsedEmail[]): string[] {
  return parsedEmails.map((item) => item.email);
}

/**
 * Validates all parsed email addresses and returns validation results
 * @param input - The input string to parse and validate
 * @returns Object with valid emails, invalid entries, and validation summary
 */
export function validateEmailInput(input: string): {
  validEmails: string[];
  invalidEntries: string[];
  totalEntries: number;
  validCount: number;
} {
  if (!input || typeof input !== "string" || !input.trim()) {
    return {
      validEmails: [],
      invalidEntries: [],
      totalEntries: 0,
      validCount: 0,
    };
  }

  // Validate UTF-8 encoding
  try {
    const encoded = new TextEncoder().encode(input);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    if (decoded !== input) {
      return {
        validEmails: [],
        invalidEntries: [input.substring(0, 100)], // Include truncated input in invalid entries
        totalEntries: 1,
        validCount: 0,
      };
    }
  } catch {
    return {
      validEmails: [],
      invalidEntries: [input.substring(0, 100)],
      totalEntries: 1,
      validCount: 0,
    };
  }

  // Prevent buffer overflow from extremely long inputs
  if (input.length > 10000) {
    return {
      validEmails: [],
      invalidEntries: ["Input exceeds maximum length"],
      totalEntries: 1,
      validCount: 0,
    };
  }

  // Split by both commas and newlines, then filter out empty entries
  const entries = input
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const validEmails: string[] = [];
  const invalidEntries: string[] = [];

  for (const entry of entries) {
    const emailData = parseEmailEntry(entry);
    if (emailData) {
      validEmails.push(emailData.email);
    } else {
      invalidEntries.push(entry);
    }
  }

  return {
    validEmails,
    invalidEntries,
    totalEntries: entries.length,
    validCount: validEmails.length,
  };
}
