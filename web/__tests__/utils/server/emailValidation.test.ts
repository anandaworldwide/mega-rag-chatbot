/** @jest-environment node */
/**
 * Test suite for centralized email validation utilities
 *
 * Tests the new centralized email validation system that replaces
 * duplicated validation logic across multiple files
 */

import { validateEmail, validateUserEmail, EmailValidationLevel, EMAIL_REGEX } from "@/utils/server/emailValidation";
import { User } from "@/types/user";

describe("emailValidation", () => {
  describe("EMAIL_REGEX", () => {
    it("should validate standard email formats", () => {
      const validEmails = [
        "test@example.com",
        "user.name@domain.co.uk",
        "test+tag@gmail.com",
        "user_name@sub.domain.com",
      ];

      validEmails.forEach((email) => {
        expect(EMAIL_REGEX.test(email)).toBe(true);
      });
    });

    it("should reject invalid email formats", () => {
      // Basic regex rejects emails missing required structure (@ and domain with .)
      const invalidEmails = ["test", "test@", "@example.com", "test@example"];

      invalidEmails.forEach((email) => {
        expect(EMAIL_REGEX.test(email)).toBe(false);
      });
    });

    it("should note that consecutive dots are handled by sanitizeEmail, not basic regex", () => {
      // These edge cases pass basic regex but are caught by sanitizeEmail
      // This is by design - basic validation is fast, sanitization is thorough
      expect(EMAIL_REGEX.test("test..test@example.com")).toBe(true);
      expect(EMAIL_REGEX.test("test@example..com")).toBe(true);
    });
  });

  describe("validateEmail", () => {
    describe("BASIC validation level", () => {
      it("should validate basic email format", () => {
        const result = validateEmail("test@example.com", EmailValidationLevel.BASIC);
        expect(result.isValid).toBe(true);
        expect(result.email).toBe("test@example.com");
      });

      it("should reject invalid format", () => {
        const result = validateEmail("invalid-email", EmailValidationLevel.BASIC);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Invalid email format");
      });

      it("should handle non-string input", () => {
        const result = validateEmail(123 as any, EmailValidationLevel.BASIC);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("must be a string");
      });

      it("should reject empty email", () => {
        const result = validateEmail("", EmailValidationLevel.BASIC);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("cannot be empty");
      });
    });

    describe("SANITIZED validation level", () => {
      it("should sanitize and validate email", () => {
        const result = validateEmail("  Test@Example.COM  ", EmailValidationLevel.SANITIZED);
        expect(result.isValid).toBe(true);
        expect(result.email).toBe("test@example.com");
      });

      it("should reject emails with dangerous characters", () => {
        const result = validateEmail("test@example.com\r\nBCC:evil@example.com", EmailValidationLevel.SANITIZED);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("invalid characters");
      });
    });

    describe("STRICT validation level", () => {
      it("should apply full sanitization and validation", () => {
        const result = validateEmail("test@example.com", EmailValidationLevel.STRICT);
        expect(result.isValid).toBe(true);
        expect(result.email).toBe("test@example.com");
      });
    });
  });

  describe("validateUserEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
    };

    it("should validate user with valid email", () => {
      const result = validateUserEmail(mockUser);
      expect(result.isValid).toBe(true);
      expect(result.email).toBe("test@example.com");
    });

    it("should handle null/undefined user", () => {
      const result = validateUserEmail(null);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("User object is required");
    });

    it("should handle user without id", () => {
      const userWithoutId = { ...mockUser, id: undefined };
      const result = validateUserEmail(userWithoutId);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("email (id) is missing");
    });

    it("should handle user with invalid email", () => {
      const userWithInvalidEmail = { ...mockUser, id: "invalid-email" };
      const result = validateUserEmail(userWithInvalidEmail);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Invalid email format");
    });

    it("should support different validation levels", () => {
      const result = validateUserEmail(mockUser, EmailValidationLevel.BASIC);
      expect(result.isValid).toBe(true);
    });
  });
});
