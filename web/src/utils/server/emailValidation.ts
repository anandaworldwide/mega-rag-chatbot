/**
 * Email validation utilities for email sending functions
 * Centralizes all email validation logic to prevent duplication and inconsistencies
 */

import { sanitizeEmail } from "./inputSanitization";
import { User } from "@/types/user";

/**
 * Centralized email regex pattern - RFC 5322 compliant basic validation
 * Requires at least one character before and after @, and proper domain structure
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email validation levels for different use cases
 */
export enum EmailValidationLevel {
  /** Basic format check only */
  BASIC = "basic",
  /** Format + sanitization (removes injection attempts) */
  SANITIZED = "sanitized",
  /** Full validation including business rules */
  STRICT = "strict",
}

/**
 * Result type for email validation
 */
export interface EmailValidationResult {
  isValid: boolean;
  email?: string;
  error?: string;
}

/**
 * Centralized email validation function with configurable strictness
 *
 * @param email - Email string to validate
 * @param level - Validation level (default: SANITIZED)
 * @param options - Additional validation options
 * @returns Validation result
 */
export function validateEmail(
  email: string,
  level: EmailValidationLevel = EmailValidationLevel.SANITIZED,
  options: { maxLength?: number } = {}
): EmailValidationResult {
  const { maxLength = 254 } = options;

  // Type check
  if (typeof email !== "string") {
    return { isValid: false, error: "Email must be a string" };
  }

  // Empty check
  if (!email.trim()) {
    return { isValid: false, error: "Email cannot be empty" };
  }

  try {
    // For strict validation, use the comprehensive sanitizeEmail function
    if (level === EmailValidationLevel.STRICT || level === EmailValidationLevel.SANITIZED) {
      const sanitized = sanitizeEmail(email, maxLength);
      return { isValid: true, email: sanitized };
    }

    // For basic validation, just check format
    const trimmed = email.trim().toLowerCase();

    if (trimmed.length > maxLength) {
      return { isValid: false, error: `Email exceeds maximum length of ${maxLength} characters` };
    }

    if (!EMAIL_REGEX.test(trimmed)) {
      return { isValid: false, error: "Invalid email format" };
    }

    return { isValid: true, email: trimmed };
  } catch (error: any) {
    return { isValid: false, error: error.message || "Email validation failed" };
  }
}

/**
 * Validates and extracts email from user object
 * User email is stored in the id field (document ID)
 *
 * @param user - User object
 * @param validationLevel - Email validation strictness level
 * @returns Validation result with sanitized email or error
 */
export function validateUserEmail(
  user: User | null | undefined,
  validationLevel: EmailValidationLevel = EmailValidationLevel.SANITIZED
): EmailValidationResult {
  if (!user) {
    return { isValid: false, error: "User object is required" };
  }

  if (!user.id) {
    return { isValid: false, error: "User email (id) is missing" };
  }

  if (typeof user.id !== "string") {
    return { isValid: false, error: "User email (id) must be a string" };
  }

  return validateEmail(user.id, validationLevel);
}

/**
 * Validates a URL for use in email links
 *
 * @param url - URL to validate
 * @param baseUrl - Base URL for relative URL resolution
 * @returns Validation result with normalized URL or error
 */
export function validateEmailUrl(url: string | undefined, baseUrl: string): EmailValidationResult {
  if (!url) {
    return { isValid: false, error: "URL is required" };
  }

  try {
    // Resolve relative URLs
    const resolvedUrl = url.startsWith("http") ? url : new URL(url, baseUrl).toString();

    // Basic URL validation
    const urlObj = new URL(resolvedUrl);
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      return { isValid: false, error: "Only HTTP and HTTPS URLs are allowed" };
    }

    return { isValid: true, email: resolvedUrl }; // Reusing email field for URL
  } catch (_error) {
    return { isValid: false, error: "Invalid URL format" };
  }
}
