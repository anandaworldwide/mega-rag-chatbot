/**
 * Unit tests for input sanitization utilities
 */

import {
  neutralizeSpreadsheetFormula,
  sanitizeEmail,
  sanitizeForLogging,
  sanitizeName,
  sanitizeSpreadsheetText,
  sanitizeTextInput,
  sanitizeUserText,
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
  it("accepts a normal question and collapses newlines on both paths", () => {
    const result = validateAndSanitizeQuestion("What is\n\nKriya?");
    expect(result.display).toBe("What is Kriya?");
    expect(result.model).toBe("What is Kriya?");
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
    expect(result.display).not.toMatch(/script/i);
    expect(result.model).not.toMatch(/script/i);
    expect(result.display).toContain("Hello");
    expect(result.display).toContain("world");
  });

  it("keeps apostrophes as typed on both paths", () => {
    const result = validateAndSanitizeQuestion("didn't");
    expect(result.display).toBe("didn't");
    expect(result.model).toBe("didn't");
    expect(result.model).not.toBe("didn''t");
  });

  it("keeps a quoted phrase as typed on both paths", () => {
    const result = validateAndSanitizeQuestion('What is "Kriya Yoga"?');
    expect(result.display).toBe('What is "Kriya Yoga"?');
    expect(result.model).toBe('What is "Kriya Yoga"?');
    expect(result.model).not.toBe('What is \\"Kriya Yoga\\"?');
  });

  it("keeps grouping marks on display and strips them on the model path", () => {
    const result = validateAndSanitizeQuestion("(Kriya) [initiation]");
    expect(result.display).toBe("(Kriya) [initiation]");
    expect(result.model).toBe("Kriya initiation");
  });

  it("strips a script tag and keeps the apostrophe", () => {
    const result = validateAndSanitizeQuestion("I didn't see <script>alert(1)</script> this");
    expect(result.display).toContain("didn't");
    expect(result.model).toContain("didn't");
    expect(result.display).not.toContain("didn''t");
    expect(result.model).not.toContain("didn''t");
    expect(result.display).not.toMatch(/<script/i);
    expect(result.model).not.toMatch(/<script/i);
    expect(result.display).not.toMatch(/alert/);
    expect(result.model).not.toMatch(/alert/);
  });

  it("splits display punctuation from the main-equivalent model path", () => {
    const input = "What's (Kriya) {path} [book] | & ; $";
    const result = validateAndSanitizeQuestion(input);

    expect(result.display).toBe(input);
    expect(result.display).toContain("(");
    expect(result.display).toContain(")");
    expect(result.display).toContain("{");
    expect(result.display).toContain("}");
    expect(result.display).toContain("[");
    expect(result.display).toContain("]");
    expect(result.display).toContain("|");
    expect(result.display).toContain("&");
    expect(result.display).toContain(";");
    expect(result.display).toContain("$");
    expect(result.display).toContain("'");

    // Main sanitizeTextInput would yield What''s Kriya path book.
    // This PR keeps the apostrophe as typed and still strips the rest.
    expect(result.model).toBe("What's Kriya path book");
    expect(result.model).not.toBe("What''s Kriya path book");
    expect(result.model).not.toMatch(/[(){}[\]|&;$]/);
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

  it("still applies SQL-style apostrophe escaping when allowSpecialChars is false", () => {
    expect(sanitizeTextInput("didn't")).toBe("didn''t");
  });

  it("keeps apostrophes and quotes when escapeQuotes is false", () => {
    expect(sanitizeTextInput("didn't", { escapeQuotes: false })).toBe("didn't");
    expect(sanitizeTextInput('He said "thanks"', { escapeQuotes: false })).toBe('He said "thanks"');
  });

  it("preserves apostrophes and double quotes when allowSpecialChars is true", () => {
    expect(sanitizeTextInput("didn't", { allowSpecialChars: true })).toBe("didn't");
    expect(sanitizeTextInput('He said "thanks"', { allowSpecialChars: true })).toBe('He said "thanks"');
  });
});

describe("sanitizeUserText", () => {
  it("keeps apostrophes, quotes, and grouping marks as typed", () => {
    expect(sanitizeUserText("didn't")).toBe("didn't");
    expect(sanitizeUserText('He said "thanks"')).toBe('He said "thanks"');
    expect(sanitizeUserText("(Kriya) [initiation]")).toBe("(Kriya) [initiation]");
  });

  it("strips script tags and keeps the apostrophe", () => {
    const result = sanitizeUserText("I didn't see <script>alert(1)</script> this");
    expect(result).toContain("didn't");
    expect(result).not.toContain("didn''t");
    expect(result).not.toMatch(/<script/i);
  });

  it("keeps markup when the caller will escape HTML later", () => {
    const result = sanitizeUserText("I didn't see <script>alert(1)</script>", { keepMarkup: true });
    expect(result).toBe("I didn't see <script>alert(1)</script>");
  });
});

describe("sanitizeSpreadsheetText", () => {
  it("round-trips apostrophes and double quotes exactly as typed", () => {
    expect(sanitizeSpreadsheetText("didn't")).toBe("didn't");
    expect(sanitizeSpreadsheetText('He said "thanks"')).toBe('He said "thanks"');
  });

  it("neutralizes a leading equals sign so Sheets stores text, not a formula", () => {
    expect(sanitizeSpreadsheetText("=1+1")).toBe("'=1+1");
    expect(neutralizeSpreadsheetFormula("=HYPERLINK")).toBe("'=HYPERLINK");
    expect(neutralizeSpreadsheetFormula("+cmd")).toBe("'+cmd");
    expect(neutralizeSpreadsheetFormula("-1")).toBe("'-1");
    expect(neutralizeSpreadsheetFormula("@SUM")).toBe("'@SUM");
    expect(neutralizeSpreadsheetFormula("normal text")).toBe("normal text");
    expect(neutralizeSpreadsheetFormula("")).toBe("");
  });
});
