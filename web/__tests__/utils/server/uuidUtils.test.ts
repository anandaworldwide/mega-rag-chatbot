import { createMocks } from "node-mocks-http";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { JwtPayload } from "@/utils/server/jwtUtils";

// Set SECRET_KEY before importing uuidUtils (required for module initialization)
process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";

const mockSetCookie = jest.fn();
jest.mock("cookies", () =>
  jest.fn().mockImplementation(() => ({
    set: mockSetCookie,
    get: jest.fn(),
  }))
);
jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(true),
}));

import {
  getSecureUUID,
  createSignedUUIDCookie,
  ensureAnonymousVisitorUuidCookie,
  resolveSecureUuidFromAppRequest,
} from "@/utils/server/uuidUtils";
import { NextRequest } from "next/server";

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

      it("should reject unsigned UUID cookies", () => {
        const testUUID = "123e4567-e89b-12d3-a456-426614174000";
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: testUUID },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: false,
          error: "Invalid UUID cookie format",
          statusCode: 400,
        });
      });

      it("should reject signed cookies with invalid signatures", () => {
        const testUUID = "123e4567-e89b-12d3-a456-426614174000";
        const invalidSignature = "a".repeat(64);
        const invalidSignedCookie = `${testUUID}--${invalidSignature}`;

        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: invalidSignedCookie },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: false,
          error: "Invalid UUID cookie signature",
          statusCode: 400,
        });
      });

      it("should reject invalid UUID format in signed cookies", () => {
        const invalidUuid = "not-a-valid-uuid";
        const signedCookie = createSignedUUIDCookie(invalidUuid);

        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: signedCookie },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: false,
          error: "Invalid UUID format",
          statusCode: 400,
        });
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
        const testUUID = "123e4567-e89b-12d3-a456-426614174000";
        const signedCookie = createSignedUUIDCookie(testUUID);
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: signedCookie },
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
          uuid: testUUID,
        });
      });
    });

    describe("edge cases", () => {
      it("should handle missing site config", () => {
        mockLoadSiteConfigSync.mockReturnValue(null as any);

        const validUUID = "123e4567-e89b-12d3-a456-426614174000";
        const signedCookie = createSignedUUIDCookie(validUUID);
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: signedCookie },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: true,
          uuid: validUUID,
        });
      });

      it("should handle site config without requireLogin property", () => {
        mockLoadSiteConfigSync.mockReturnValue({
          siteId: "crystal",
          // requireLogin property missing
        } as any);

        const validUUID = "123e4567-e89b-12d3-a456-426614174000";
        const signedCookie = createSignedUUIDCookie(validUUID);
        const { req } = createMocks({
          method: "POST",
          cookies: { uuid: signedCookie },
        });

        const result = getSecureUUID(req as any);

        expect(result).toEqual({
          success: true,
          uuid: validUUID,
        });
      });
    });
  });

  describe("ensureAnonymousVisitorUuidCookie", () => {
    beforeEach(() => {
      mockLoadSiteConfigSync.mockReturnValue({
        requireLogin: false,
        siteId: "ananda-public",
      } as any);
    });

    it("sets a signed uuid cookie when none exists", () => {
      const { req, res } = createMocks({
        method: "GET",
        cookies: {},
        headers: { "x-forwarded-proto": "http" },
      });

      ensureAnonymousVisitorUuidCookie(req as any, res as any);

      expect(mockSetCookie).toHaveBeenCalledTimes(1);
      expect(mockSetCookie.mock.calls[0][0]).toBe("uuid");
      expect(mockSetCookie.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}--[0-9a-f]{64}$/i);
    });

    it("re-signs legacy unsigned uuid cookies", () => {
      const legacyUuid = "123e4567-e89b-12d3-a456-426614174000";
      const { req, res } = createMocks({
        method: "GET",
        cookies: { uuid: legacyUuid },
        headers: { "x-forwarded-proto": "http" },
      });

      ensureAnonymousVisitorUuidCookie(req as any, res as any);

      expect(mockSetCookie).toHaveBeenCalledTimes(1);
      expect(mockSetCookie.mock.calls[0][1]).toBe(createSignedUUIDCookie(legacyUuid));
    });

    it("does not overwrite a valid signed uuid cookie", () => {
      const testUUID = "123e4567-e89b-12d3-a456-426614174000";
      const { req, res } = createMocks({
        method: "GET",
        cookies: { uuid: createSignedUUIDCookie(testUUID) },
      });

      ensureAnonymousVisitorUuidCookie(req as any, res as any);

      expect(mockSetCookie).not.toHaveBeenCalled();
    });

    it("skips login-required sites", () => {
      mockLoadSiteConfigSync.mockReturnValue({
        requireLogin: true,
        siteId: "ananda",
      } as any);

      const { req, res } = createMocks({ method: "GET", cookies: {} });
      ensureAnonymousVisitorUuidCookie(req as any, res as any);

      expect(mockSetCookie).not.toHaveBeenCalled();
    });

    it("skips when authToken cookie is present", () => {
      const { req, res } = createMocks({
        method: "GET",
        cookies: { authToken: "logged-in-token" },
      });

      ensureAnonymousVisitorUuidCookie(req as any, res as any);

      expect(mockSetCookie).not.toHaveBeenCalled();
    });
  });

  describe("resolveSecureUuidFromAppRequest", () => {
    beforeEach(() => {
      mockLoadSiteConfigSync.mockReturnValue({
        requireLogin: false,
        siteId: "ananda-public",
      } as any);
    });

    it("rejects unsigned uuid cookies", async () => {
      const req = {
        cookies: {
          get: (name: string) => (name === "uuid" ? { value: "123e4567-e89b-12d3-a456-426614174000" } : undefined),
        },
      } as unknown as NextRequest;

      const result = await resolveSecureUuidFromAppRequest(req);

      expect(result).toEqual({
        success: false,
        error: "Invalid UUID cookie format",
        statusCode: 400,
      });
    });

    it("accepts valid signed uuid cookies", async () => {
      const testUUID = "123e4567-e89b-12d3-a456-426614174000";
      const signedCookie = createSignedUUIDCookie(testUUID);
      const req = {
        cookies: {
          get: (name: string) => (name === "uuid" ? { value: signedCookie } : undefined),
        },
      } as unknown as NextRequest;

      const result = await resolveSecureUuidFromAppRequest(req);

      expect(result).toEqual({
        success: true,
        uuid: testUUID,
      });
    });

    it("rejects invalid uuid cookie signatures", async () => {
      const testUUID = "123e4567-e89b-12d3-a456-426614174000";
      const req = {
        cookies: {
          get: (name: string) =>
            name === "uuid" ? { value: `${testUUID}--${"a".repeat(64)}` } : undefined,
        },
      } as unknown as NextRequest;

      const result = await resolveSecureUuidFromAppRequest(req);

      expect(result).toEqual({
        success: false,
        error: "Invalid UUID cookie signature",
        statusCode: 400,
      });
    });
  });
});
