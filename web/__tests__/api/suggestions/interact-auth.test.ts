/** @jest-environment node */

/**
 * JWT authentication tests for /api/suggestions/interact
 */

import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      add: jest.fn(),
    })),
  },
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreAdd: jest.fn().mockResolvedValue({ id: "test-id" }),
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/inputSanitization", () => ({
  sanitizeForLogging: jest.fn((input: string) => input),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getSuggestionsInteractionsCollectionName: jest.fn(() => "prod_suggestions_interactions"),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn().mockReturnValue({ requireLogin: true, siteId: "ananda" }),
}));

jest.mock("@/utils/server/conversationOwnershipUtils", () => ({
  conversationBelongsToUuid: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  addCorsHeaders: jest.fn().mockImplementation((response) => response),
}));

process.env.SECURE_TOKEN = "test-secure-token";
const TEST_AUTH_USER_UUID = "123e4567-e89b-12d3-a456-426614174000";

import { POST } from "@/app/api/suggestions/interact/route";
import { firestoreAdd } from "@/utils/server/firestoreRetryUtils";

describe("/api/suggestions/interact JWT authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockRequest = (body: Record<string, unknown>, authorization?: string | null): NextRequest => {
    return {
      json: jest.fn().mockResolvedValue(body),
      cookies: {
        get: jest.fn(() => undefined),
      },
      headers: {
        get: jest.fn((name: string) => {
          if (name === "authorization") return authorization ?? null;
          if (name === "x-forwarded-for") return "192.168.1.1";
          return null;
        }),
      },
    } as unknown as NextRequest;
  };

  const validBody = {
    convId: "conv-123",
    suggestionId: "suggestion-456",
    type: "deeper",
    position: 0,
  };

  it("returns 401 when no Authorization header is present", async () => {
    const req = createMockRequest(validBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("No token provided");
    expect(firestoreAdd).not.toHaveBeenCalled();
  });

  it("returns 401 when token is invalid", async () => {
    const req = createMockRequest(validBody, "Bearer invalid-token");
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("Invalid or expired token");
    expect(firestoreAdd).not.toHaveBeenCalled();
  });

  it("accepts requests with a valid JWT token", async () => {
    const token = jwt.sign({ client: "web", uuid: TEST_AUTH_USER_UUID }, process.env.SECURE_TOKEN as string, {
      expiresIn: "15m",
      algorithm: "HS256",
      issuer: "mega-rag-chatbot",
      audience: "mega-rag-chatbot-users",
    });

    const req = createMockRequest(validBody, `Bearer ${token}`);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(firestoreAdd).toHaveBeenCalled();

    const interactionData = (firestoreAdd as jest.Mock).mock.calls[0][1];
    expect(interactionData.userUuid).toBe(TEST_AUTH_USER_UUID);
  });
});
