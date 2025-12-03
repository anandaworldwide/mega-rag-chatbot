import { createMocks } from "node-mocks-http";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { JwtPayload } from "@/utils/server/jwtUtils";

// Set SECRET_KEY before importing uuidUtils (required for module initialization)
process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";

// Mock Cookies library for migration test
const mockSetCookie = jest.fn();
jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => ({
    set: mockSetCookie,
    get: jest.fn(),
  }));
});

// Mock isDevelopment to return true for tests
jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(true),
}));

import { getSecureUUID, createSignedUUIDCookie } from "@/utils/server/uuidUtils";

// Mock dependencies
jest.mock("@/utils/server/loadSiteConfig");
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

describe("uuidUtils", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetCookie.mockClear();
  });

  describe("getSecureUUID", () => {
    describe("for authenticated sites (requireLogin: true)", () => {
      beforeEach(() => {
        mockLoadSiteConfigSync.mockReturnValue({
          requireLogin: true,
          siteId: "ananda",
        } as any);
      });

      it("should return UUID from JWT payload when available", () => {
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: "cookie-uuid" },
        });

        const userPayload: JwtPayload = {
          client: "web",
          email: "test@example.com",
          role: "user",
          uuid: "jwt-uuid",
          iat: Date.now(),
          exp: Date.now() + 3600000,
        };

        const result = getSecureUUID(req as any, undefined, userPayload);

        expect(result).toEqual({
          success: true,
          uuid: "jwt-uuid",
        });
      });

      it("should return error when JWT UUID is missing", () => {
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: "cookie-uuid" },
        });

        const userPayload: JwtPayload = {
          client: "web",
          email: "test@example.com",
          role: "user",
          // uuid missing
          iat: Date.now(),
          exp: Date.now() + 3600000,
        };

        const result = getSecureUUID(req as any, undefined, userPayload);

        expect(result).toEqual({
          success: false,
          error: "UUID not found in authentication token",
          statusCode: 400,
        });
      });

      it("should return error when userPayload is undefined", () => {
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: "cookie-uuid" },
        });

        const result = getSecureUUID(req as any, undefined);

        expect(result).toEqual({
          success: false,
          error: "UUID not found in authentication token",
          statusCode: 400,
        });
      });
    });

    describe("for anonymous sites (requireLogin: false)", () => {
      beforeEach(() => {
        mockLoadSiteConfigSync.mockReturnValue({
          requireLogin: false,
          siteId: "ananda-public",
        } as any);
      });

      it("should return UUID from signed cookies when available", () => {
        const testUUID = "123e4567-e89b-12d3-a456-426614174000";
        const signedCookie = createSignedUUIDCookie(testUUID);

        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: signedCookie },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: true,
          uuid: testUUID,
        });
      });

      it("should upgrade unsigned UUID cookie to signed format (migration)", () => {
        const testUUID = "123e4567-e89b-12d3-a456-426614174000";
        const { req, res } = createMocks({
          method: "POST",
          cookies: { uuid: testUUID }, // Unsigned cookie
          headers: {
            "x-forwarded-proto": "http", // Simulate non-HTTPS for testing
          },
        });

        const result = getSecureUUID(req as any, res as any);

        // Should successfully return UUID
        expect(result).toEqual({
          success: true,
          uuid: testUUID,
        });

        // Should have called cookies.set to upgrade to signed cookie
        expect(mockSetCookie).toHaveBeenCalledTimes(1);
        expect(mockSetCookie).toHaveBeenCalledWith(
          "uuid",
          expect.stringContaining(testUUID),
          expect.objectContaining({
            httpOnly: false,
            sameSite: "lax",
            secure: false, // Because x-forwarded-proto is http
            maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
            path: "/",
          })
        );

        // Verify the cookie value is properly signed
        const cookieValue = mockSetCookie.mock.calls[0][1] as string;
        expect(cookieValue).toContain("--");
        const [uuid, signature] = cookieValue.split("--");
        expect(uuid).toBe(testUUID);
        expect(signature).toMatch(/^[0-9a-f]{64}$/i); // HMAC-SHA256 hex signature (64 hex chars)

        // Verify signature is correct by creating a new signed cookie and comparing
        const expectedSignedCookie = createSignedUUIDCookie(testUUID);
        expect(cookieValue).toBe(expectedSignedCookie);
      });

      it("should reject invalid UUID format", () => {
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: "not-a-valid-uuid" },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: false,
          error: "Invalid UUID format",
          statusCode: 400,
        });
      });

      it("should handle signed cookie with invalid signature (migration fallback)", () => {
        const testUUID = "123e4567-e89b-12d3-a456-426614174000";
        // Create invalid signature with correct length (64 hex chars) but wrong value
        const invalidSignature = "a".repeat(64); // 64 'a' characters
        const invalidSignedCookie = `${testUUID}--${invalidSignature}`;

        const { req, res } = createMocks({
          method: "POST",
          cookies: { uuid: invalidSignedCookie },
          headers: {
            "x-forwarded-proto": "http",
          },
        });

        // During migration period, invalid signatures fall back to unsigned handling
        // After June 2026, this should reject. For now, it will try to upgrade.
        const result = getSecureUUID(req as any, res as any);

        // Should still work during migration (treats as unsigned and upgrades)
        expect(result.success).toBe(true);
        expect(result).toEqual({
          success: true,
          uuid: testUUID,
        });

        // Should have upgraded to properly signed cookie
        expect(mockSetCookie).toHaveBeenCalledTimes(1);
        const cookieValue = mockSetCookie.mock.calls[0][1] as string;
        expect(cookieValue).toBe(createSignedUUIDCookie(testUUID));
      });

      it("should return error when cookie UUID is missing", () => {
        const { req } = createMocks({
          method: "POST",
          // no cookies
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: false,
          error: "UUID not found in cookies",
          statusCode: 400,
        });
      });

      it("should return error when cookie UUID is undefined", () => {
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: "" }, // Empty string simulates undefined/missing UUID
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: false,
          error: "UUID not found in cookies",
          statusCode: 400,
        });
      });

      it("should ignore JWT payload and use cookies for anonymous sites", () => {
        const cookieUUID = "123e4567-e89b-12d3-a456-426614174000";
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: cookieUUID },
        });

        const userPayload: JwtPayload = {
          client: "web",
          email: "test@example.com",
          role: "user",
          uuid: "jwt-uuid-1234-5678-90ab-cdef12345678",
          iat: Date.now(),
          exp: Date.now() + 3600000,
        };

        const result = getSecureUUID(req as any, undefined, userPayload);

        expect(result).toEqual({
          success: true,
          uuid: cookieUUID, // Should use cookie, not JWT
        });
      });
    });

    describe("edge cases", () => {
      it("should handle missing site config", () => {
        mockLoadSiteConfigSync.mockReturnValue(null as any);

        const validUUID = "123e4567-e89b-12d3-a456-426614174000";
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: validUUID },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: true,
          uuid: validUUID, // Should default to cookie behavior
        });
      });

      it("should handle site config without requireLogin property", () => {
        mockLoadSiteConfigSync.mockReturnValue({
          siteId: "crystal",
          // requireLogin property missing
        } as any);

        const validUUID = "123e4567-e89b-12d3-a456-426614174000";
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: validUUID },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: true,
          uuid: validUUID, // Should default to cookie behavior
        });
      });
    });
  });
});
