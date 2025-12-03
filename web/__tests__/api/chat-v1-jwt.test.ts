/**
 * Test for JWT authentication in Chat API v1
 *
 * This file tests the JWT authentication implementation for the App Router chat endpoint.
 * It verifies that:
 * 1. Requests without a token are rejected
 * 2. Requests with an invalid token are rejected
 * 3. Requests with a valid token are processed
 */

import jwt from "jsonwebtoken";
import { JwtPayload } from "@/utils/server/jwtUtils";
import { getTokenFromAppRequest, withAppRouterJwtAuth } from "@/utils/server/appRouterJwtUtils";

// Mock NextRequest and NextResponse
jest.mock("next/server", () => ({
  NextRequest: jest.fn().mockImplementation(() => ({
    headers: {
      get: jest.fn(),
    },
  })),
  NextResponse: {
    json: jest.fn().mockImplementation((body, init) => ({
      ...body,
      status: init?.status || 200,
    })),
  },
}));

// Mock environment variables
process.env.SECURE_TOKEN = "test-secure-token";

describe("Chat API v1 JWT Authentication", () => {
  // Test token extraction
  describe("getTokenFromAppRequest", () => {
    it("should throw an error if no authorization header is present", () => {
      const req = {
        headers: {
          get: jest.fn().mockReturnValue(null),
        },
      };

      expect(() => getTokenFromAppRequest(req as any)).toThrow("No token provided");
    });

    it("should throw an error if authorization header does not start with Bearer", () => {
      const req = {
        headers: {
          get: jest.fn().mockReturnValue("Invalid-format"),
        },
      };

      expect(() => getTokenFromAppRequest(req as any)).toThrow("No token provided");
    });

    it("should throw an error if token is invalid", () => {
      const req = {
        headers: {
          get: jest.fn().mockReturnValue("Bearer invalid-token"),
        },
      };

      expect(() => getTokenFromAppRequest(req as any)).toThrow("Invalid or expired token");
    });
  });

  // Test JWT middleware
  describe("withAppRouterJwtAuth", () => {
    it("should return 401 for requests without a token", async () => {
      const req = {
        headers: {
          get: jest.fn().mockReturnValue(null),
        },
      };

      const handler = jest.fn();
      const wrappedHandler = withAppRouterJwtAuth(handler);
      const result = (await wrappedHandler(req as any, {})) as {
        status: number;
        error: string;
      };

      expect(result).toBeDefined();
      expect(result.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should return 401 for requests with an invalid token", async () => {
      const req = {
        headers: {
          get: jest.fn().mockReturnValue("Bearer invalid-token"),
        },
      };

      const handler = jest.fn();
      const wrappedHandler = withAppRouterJwtAuth(handler);
      const result = (await wrappedHandler(req as any, {})) as {
        status: number;
        error: string;
      };

      expect(result).toBeDefined();
      expect(result.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should call the handler for requests with a valid token", async () => {
      // Create a valid token with issuer and audience
      const token = jwt.sign(
        { client: "web", iat: Math.floor(Date.now() / 1000) },
        process.env.SECURE_TOKEN as string,
        {
          expiresIn: "15m",
          algorithm: "HS256",
          issuer: "mega-rag-chatbot",
          audience: "mega-rag-chatbot-users",
        }
      );

      const req = {
        headers: {
          get: jest.fn().mockReturnValue(`Bearer ${token}`),
        },
      };

      const expectedPayload: JwtPayload = {
        client: "web",
        iat: expect.any(Number),
        exp: expect.any(Number),
      };

      const handler = jest.fn().mockResolvedValue({ status: 200 });
      const wrappedHandler = withAppRouterJwtAuth(handler);
      await wrappedHandler(req as any, {});

      expect(handler).toHaveBeenCalledWith(req, {}, expect.objectContaining(expectedPayload));
    });
  });
});
