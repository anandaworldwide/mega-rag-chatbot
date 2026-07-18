/**
 * Unit tests for input sanitization utilities
 */

import {
  sanitizeEmail,
  sanitizeForLogging,
  sanitizeName,
  sanitizeTextInput,
  validateAndSanitizeQuestion,
} from "@/utils/server/inputSanitization";

describe("sanitizeName", () => {
  it.each([
    ['ROBERT \\"RAMI\\" SMITH', 'ROBERT "RAMI" SMITH'],
    ["O\\'CONNOR", "O'CONNOR"],
    ["Name\\with\\multiple\\backslashes", "Namewithmultiplebackslashes"],
    ['ROBERT "RAMI" SMITH', 'ROBERT "RAMI" SMITH'],
    ["O'CONNOR", "O'CONNOR"],
    ['Jean-Pierre "JP" O\'Brien', 'Jean-Pierre "JP" O\'Brien'],
    ["José O'Connor", "José O'Connor"],
    ["Mary-Jane", "Mary-Jane"],
    ["", ""],
    ["   ", ""],
    ["|&;`$(){}[]", ""],
  ])("sanitizes %#", (input, expected) => {
    const result = sanitizeName(input);
    expect(result).toBe(expected);
    expect(result).not.toContain("\\");
  });

  it("strips XSS / HTML / event-handler payloads", () => {
    expect(sanitizeName('John<script>alert("XSS")</script>Doe')).toBe("JohnDoe");
    expect(sanitizeName("John onclick=\"alert('XSS')\" Doe")).not.toContain("onclick=");
    expect(sanitizeName("javascript:alert('XSS')")).not.toContain("javascript:");
    expect(sanitizeName('data:text/html,<script>alert("XSS")</script>')).not.toContain("data:text/html");
    expect(sanitizeName("<strong>John</strong> Doe")).toBe("John Doe");
    expect(sanitizeName('John<script>alert("XSS")</script> "Bob" Doe')).toBe('John "Bob" Doe');
  });

  it.each(["|", "&", ";", "`", "$", "(", ")", "{", "}", "[", "]"])(
    "removes command-injection char %s",
    (char) => {
      expect(sanitizeName(`John${char}Doe`)).toBe("JohnDoe");
    }
  );

  it("removes null bytes and control characters while preserving spaces", () => {
    expect(sanitizeName("John\0Doe")).toBe("JohnDoe");
    expect(sanitizeName("John\x01\x02\x03Doe")).toBe("JohnDoe");
    expect(sanitizeName("John Doe")).toBe("John Doe");
    expect(sanitizeName("  John    Doe  ")).toBe("John Doe");
    expect(sanitizeName("John\tDoe")).toBe("John Doe");
  });

  it("enforces length and type constraints", () => {
    expect(sanitizeName("A".repeat(100))).toBe("A".repeat(100));
    expect(() => sanitizeName("A".repeat(101))).toThrow("exceeds maximum length");
    expect(() => sanitizeName("A".repeat(51), 50)).toThrow("exceeds maximum length");
    expect(() => sanitizeName(null as any)).toThrow("Input must be a string");
    expect(() => sanitizeName(123 as any)).toThrow("Input must be a string");
  });
});

describe("sanitizeEmail", () => {
  it("lowercases and accepts a valid email", () => {
    expect(sanitizeEmail("  User@Example.COM  ")).toBe("user@example.com");
  });

  it.each([
    ["user@example.com\r\nBcc:evil@x.com", "invalid characters"],
    ["user@example.com\n", "invalid characters"],
    ["user@example.com\t", "invalid characters"],
    ["user%0a@example.com", "dangerous patterns"],
    ["user\0@example.com", "invalid characters"],
    ["not-an-email", "Invalid email format"],
    ["a".repeat(255) + "@x.com", "exceeds maximum length"],
  ])("rejects %s", (email, messagePart) => {
    expect(() => sanitizeEmail(email)).toThrow(messagePart);
  });

  it("rejects non-string input", () => {
    expect(() => sanitizeEmail(null as any)).toThrow("Email must be a string");
    expect(() => sanitizeEmail(undefined as any)).toThrow("Email must be a string");
  });
});

describe("validateAndSanitizeQuestion", () => {
  it("accepts a normal question and collapses newlines", () => {
    expect(validateAndSanitizeQuestion("What is\n\nKriya?")).toBe("What is Kriya?");
  });

  it("rejects empty, whitespace-only, oversized, and non-string input", () => {
    expect(() => validateAndSanitizeQuestion("")).toThrow("Question cannot be empty");
    expect(() => validateAndSanitizeQuestion("   \n\t  ")).toThrow("Question cannot be empty");
    expect(() => validateAndSanitizeQuestion("a".repeat(4001))).toThrow("exceeds maximum length");
    expect(() => validateAndSanitizeQuestion(null as any)).toThrow("Question must be a string");
    expect(() => validateAndSanitizeQuestion(42 as any)).toThrow("Question must be a string");
  });

  it("strips script tags and nested tag smuggling attempts", () => {
    const result = validateAndSanitizeQuestion('Hello <scr<script>ipt>alert(1)</script> world');
    expect(result).not.toMatch(/script/i);
    expect(result).toContain("Hello");
    expect(result).toContain("world");
  });
});

describe("sanitizeTextInput / sanitizeForLogging", () => {
  it("throws on non-string and oversized text input", () => {
    expect(() => sanitizeTextInput(null as any)).toThrow("Input must be a string");
    expect(() => sanitizeTextInput("x".repeat(11), { maxLength: 10 })).toThrow("exceeds maximum length");
  });

  it("strips control characters and truncates log lines safely", () => {
    expect(sanitizeTextInput("a\x00b\nc", { allowNewlines: false })).toBe("abc");
    const logged = sanitizeForLogging("line1\nline2" + "x".repeat(600), 40);
    expect(logged).not.toContain("\n");
    expect(logged.length).toBeLessThanOrEqual(60);
    expect(sanitizeForLogging(null as any)).toBe("null");
  });
});
