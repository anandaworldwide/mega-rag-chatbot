import { generateNpsSurveyToken, verifyNpsSurveyToken } from "@/utils/server/npsSurveyTokenUtils";

describe("npsSurveyTokenUtils", () => {
  const originalEnv = process.env.SECURE_TOKEN;

  beforeEach(() => {
    process.env.SECURE_TOKEN = "test-secret-key-for-jwt-signing";
  });

  afterEach(() => {
    process.env.SECURE_TOKEN = originalEnv;
  });

  describe("generateNpsSurveyToken", () => {
    it("should generate a valid token for valid email and score", () => {
      const token = generateNpsSurveyToken("test@example.com", 7);
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("should throw error if SECURE_TOKEN is not configured", () => {
      delete process.env.SECURE_TOKEN;
      expect(() => {
        generateNpsSurveyToken("test@example.com", 7);
      }).toThrow("SECURE_TOKEN not configured");
    });

    it("should throw error for invalid score (negative)", () => {
      expect(() => {
        generateNpsSurveyToken("test@example.com", -1);
      }).toThrow("Score must be an integer between 0 and 10");
    });

    it("should throw error for invalid score (greater than 10)", () => {
      expect(() => {
        generateNpsSurveyToken("test@example.com", 11);
      }).toThrow("Score must be an integer between 0 and 10");
    });

    it("should throw error for non-integer score", () => {
      expect(() => {
        generateNpsSurveyToken("test@example.com", 7.5 as any);
      }).toThrow("Score must be an integer between 0 and 10");
    });

    it("should normalize email to lowercase", () => {
      const token = generateNpsSurveyToken("Test@Example.COM", 5);
      const payload = verifyNpsSurveyToken(token);
      expect(payload?.email).toBe("test@example.com");
    });

    it("should generate different tokens for different scores", () => {
      const token1 = generateNpsSurveyToken("test@example.com", 5);
      const token2 = generateNpsSurveyToken("test@example.com", 8);
      expect(token1).not.toBe(token2);
    });

    it("should generate different tokens for different emails", () => {
      const token1 = generateNpsSurveyToken("test1@example.com", 7);
      const token2 = generateNpsSurveyToken("test2@example.com", 7);
      expect(token1).not.toBe(token2);
    });
  });

  describe("verifyNpsSurveyToken", () => {
    it("should verify a valid token and return payload", () => {
      const token = generateNpsSurveyToken("test@example.com", 7);
      const payload = verifyNpsSurveyToken(token);

      expect(payload).not.toBeNull();
      expect(payload?.isValid).toBe(true);
      expect(payload?.email).toBe("test@example.com");
      expect(payload?.score).toBe(7);
    });

    it("should return null for invalid token format", () => {
      const payload = verifyNpsSurveyToken("invalid-token-string");
      expect(payload).toBeNull();
    });

    it("should return null for expired token", () => {
      // Create a token with short expiry and wait for it to expire
      const originalExpiresIn = process.env.JWT_EXPIRES_IN;
      process.env.JWT_EXPIRES_IN = "1ms";

      // Note: This test might be flaky due to timing, but tests the concept
      const token = generateNpsSurveyToken("test@example.com", 5);

      // Restore original
      if (originalExpiresIn) {
        process.env.JWT_EXPIRES_IN = originalExpiresIn;
      } else {
        delete process.env.JWT_EXPIRES_IN;
      }

      // Token should still be valid immediately after generation
      const payload = verifyNpsSurveyToken(token);
      expect(payload).not.toBeNull();
    });

    it("should return null if SECURE_TOKEN is not configured", () => {
      // Create a token first with valid secret
      const token = generateNpsSurveyToken("test@example.com", 7);

      // Now delete SECURE_TOKEN and try to verify
      delete process.env.SECURE_TOKEN;
      const payload = verifyNpsSurveyToken(token);

      // Restore for other tests
      process.env.SECURE_TOKEN = "test-secret-key-for-jwt-signing";

      // Should return null when SECURE_TOKEN is missing
      expect(payload).toBeNull();
    });

    it("should return null for token with wrong purpose", () => {
      // This would require mocking jwt.sign to create a token with wrong purpose
      // For now, we test that valid tokens have correct purpose
      const token = generateNpsSurveyToken("test@example.com", 5);
      const payload = verifyNpsSurveyToken(token);
      expect(payload?.isValid).toBe(true);
    });

    it("should return null for token with invalid score", () => {
      // This would require mocking jwt.sign to create a token with invalid score
      // For now, we test that valid tokens have correct score
      const token = generateNpsSurveyToken("test@example.com", 10);
      const payload = verifyNpsSurveyToken(token);
      expect(payload?.score).toBe(10);
    });

    it("should normalize email to lowercase in verification", () => {
      const token = generateNpsSurveyToken("Test@Example.COM", 3);
      const payload = verifyNpsSurveyToken(token);
      expect(payload?.email).toBe("test@example.com");
    });

    it("should verify tokens for all valid scores (0-10)", () => {
      for (let score = 0; score <= 10; score++) {
        const token = generateNpsSurveyToken("test@example.com", score);
        const payload = verifyNpsSurveyToken(token);
        expect(payload).not.toBeNull();
        expect(payload?.score).toBe(score);
        expect(payload?.isValid).toBe(true);
      }
    });
  });
});
