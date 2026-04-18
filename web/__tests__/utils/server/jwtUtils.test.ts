/**
 * Tests for JWT Authentication Utilities
 *
 * This file tests the functionality of the JWT utilities, including:
 * - Token verification
 * - Token extraction from request headers
 * - JWT authentication middleware
 */

import { NextApiRequest, NextApiResponse } from "next";
import jwt from "jsonwebtoken";
import { verifyToken, getTokenFromRequest, withJwtAuth, JwtPayload } from "@/utils/server/jwtUtils";
import * as blacklistMod from "@/utils/server/blacklist";
import * as auditLogMod from "@/utils/server/auditLog";

// Mock jsonwebtoken module
jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
  checkEmailBlacklist: jest
    .fn()
    .mockResolvedValue({ blocked: false, skipped: false, cacheHit: true, fetchMs: 0 }),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  createErrorCorsHeaders: jest.fn().mockReturnValue({}),
}));

jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => ({
    set: jest.fn(),
  }));
});

const mockCheckEmailBlacklist = blacklistMod.checkEmailBlacklist as jest.MockedFunction<
  typeof blacklistMod.checkEmailBlacklist
>;
const mockWriteAuditLog = auditLogMod.writeAuditLog as jest.MockedFunction<typeof auditLogMod.writeAuditLog>;

describe("JWT Utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SECURE_TOKEN = "test-secure-token";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("verifyToken", () => {
    it("should verify a valid token", () => {
      const mockPayload: JwtPayload = {
        client: "web",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900, // 15 minutes
      };

      (jwt.verify as jest.Mock).mockReturnValueOnce(mockPayload);

      const result = verifyToken("valid-token");

      expect(jwt.verify).toHaveBeenCalledWith("valid-token", "test-secure-token", {
        algorithms: ["HS256"],
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      });
      expect(result).toEqual(mockPayload);
    });

    it("should throw an error when SECURE_TOKEN is not configured", () => {
      delete process.env.SECURE_TOKEN;

      expect(() => verifyToken("any-token")).toThrow("JWT signing key is not configured");
      expect(jwt.verify).not.toHaveBeenCalled();
    });

    it("should throw a standardized error for invalid tokens", () => {
      (jwt.verify as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Token expired");
      });

      expect(() => verifyToken("expired-token")).toThrow("Invalid or expired token");
      expect(jwt.verify).toHaveBeenCalledWith("expired-token", "test-secure-token", {
        algorithms: ["HS256"],
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      });
    });
  });

  describe("getTokenFromRequest", () => {
    it("should extract and verify a valid token from request headers", () => {
      const mockReq = {
        headers: {
          authorization: "Bearer valid-token",
        },
      } as NextApiRequest;

      const mockPayload: JwtPayload = {
        client: "web",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      };

      (jwt.verify as jest.Mock).mockReturnValueOnce(mockPayload);

      const result = getTokenFromRequest(mockReq);

      expect(jwt.verify).toHaveBeenCalledWith("valid-token", "test-secure-token", {
        algorithms: ["HS256"],
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      });
      expect(result).toEqual(mockPayload);
    });

    it("should throw an error when authorization header is missing", () => {
      const mockReq = {
        headers: {},
      } as NextApiRequest;

      expect(() => getTokenFromRequest(mockReq)).toThrow("No token provided");
      expect(jwt.verify).not.toHaveBeenCalled();
    });

    it("should throw an error when authorization header does not have Bearer prefix", () => {
      const mockReq = {
        headers: {
          authorization: "invalid-format",
        },
      } as NextApiRequest;

      expect(() => getTokenFromRequest(mockReq)).toThrow("No token provided");
      expect(jwt.verify).not.toHaveBeenCalled();
    });
  });

  describe("withJwtAuth", () => {
    it("should call the handler when token is valid", async () => {
      const mockHandler = jest.fn();
      const mockReq = {
        headers: {
          authorization: "Bearer valid-token",
        },
      } as NextApiRequest;
      const mockRes = {} as NextApiResponse;

      const mockPayload: JwtPayload = {
        client: "web",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      };

      (jwt.verify as jest.Mock).mockReturnValueOnce(mockPayload);

      const wrappedHandler = withJwtAuth(mockHandler);
      await wrappedHandler(mockReq, mockRes);

      expect(jwt.verify).toHaveBeenCalledWith("valid-token", "test-secure-token", {
        algorithms: ["HS256"],
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      });
      expect(mockHandler).toHaveBeenCalledWith(mockReq, mockRes);
    });

    it("should return 401 when token verification fails", async () => {
      const mockHandler = jest.fn();
      const mockReq = {
        headers: {},
      } as NextApiRequest;

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as NextApiResponse;

      const wrappedHandler = withJwtAuth(mockHandler);
      await wrappedHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "No token provided" });
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("should revoke session and return 401 session_revoked when email is blacklisted", async () => {
      process.env.SITE_ID = "login-site";
      mockCheckEmailBlacklist.mockResolvedValueOnce({
        blocked: true,
        skipped: false,
        cacheHit: true,
        fetchMs: 0,
      });

      const mockHandler = jest.fn();
      const mockReq = {
        headers: { authorization: "Bearer valid-token" },
        url: "/api/some/endpoint",
      } as unknown as NextApiRequest;
      const mockRes = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as NextApiResponse;

      const mockPayload: JwtPayload = {
        client: "web",
        email: "blocked@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      };
      (jwt.verify as jest.Mock).mockReturnValueOnce(mockPayload);

      const wrappedHandler = withJwtAuth(mockHandler);
      await wrappedHandler(mockReq, mockRes);

      expect(mockCheckEmailBlacklist).toHaveBeenCalledWith("blocked@example.com", "login-site");
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ message: "session_revoked" });
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        mockReq,
        "blacklist_session_revoked",
        "blocked@example.com",
        expect.objectContaining({ endpoint: "/api/some/endpoint" })
      );
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("should allow request when email is not blacklisted", async () => {
      process.env.SITE_ID = "login-site";
      mockCheckEmailBlacklist.mockResolvedValueOnce({
        blocked: false,
        skipped: false,
        cacheHit: true,
        fetchMs: 0,
      });

      const mockHandler = jest.fn();
      const mockReq = {
        headers: { authorization: "Bearer valid-token" },
      } as unknown as NextApiRequest;
      const mockRes = {} as NextApiResponse;

      const mockPayload: JwtPayload = {
        client: "web",
        email: "good@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      };
      (jwt.verify as jest.Mock).mockReturnValueOnce(mockPayload);

      const wrappedHandler = withJwtAuth(mockHandler);
      await wrappedHandler(mockReq, mockRes);

      expect(mockCheckEmailBlacklist).toHaveBeenCalledWith("good@example.com", "login-site");
      expect(mockHandler).toHaveBeenCalledWith(mockReq, mockRes);
    });

    it("should skip blacklist check when token has no email (e.g. wordpress client)", async () => {
      process.env.SITE_ID = "login-site";

      const mockHandler = jest.fn();
      const mockReq = {
        headers: { authorization: "Bearer valid-token" },
      } as unknown as NextApiRequest;
      const mockRes = {} as NextApiResponse;

      const mockPayload: JwtPayload = {
        client: "wordpress",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      };
      (jwt.verify as jest.Mock).mockReturnValueOnce(mockPayload);

      const wrappedHandler = withJwtAuth(mockHandler);
      await wrappedHandler(mockReq, mockRes);

      expect(mockCheckEmailBlacklist).not.toHaveBeenCalled();
      expect(mockHandler).toHaveBeenCalled();
    });

    it("should pass additional arguments to the handler", async () => {
      const mockHandler = jest.fn();
      const mockReq = {
        headers: {
          authorization: "Bearer valid-token",
        },
      } as NextApiRequest;
      const mockRes = {} as NextApiResponse;
      const extraArg = { custom: "value" };

      const mockPayload: JwtPayload = {
        client: "web",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      };

      (jwt.verify as jest.Mock).mockReturnValueOnce(mockPayload);

      const wrappedHandler = withJwtAuth(mockHandler);
      await wrappedHandler(mockReq, mockRes, extraArg);

      expect(mockHandler).toHaveBeenCalledWith(mockReq, mockRes, extraArg);
    });
  });
});
