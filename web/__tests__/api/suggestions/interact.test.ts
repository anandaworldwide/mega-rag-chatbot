/**
 * Tests for the suggestion interaction API endpoint
 *
 * Tests logging of suggestion clicks for analytics and future ranking improvements.
 */

import { NextRequest } from "next/server";
import { POST } from "@/app/api/suggestions/interact/route";

// Mock Firebase - use a factory function to avoid hoisting issues
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(),
      add: jest.fn(),
    })),
  },
}));

// Mock firestore utilities
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreAdd: jest.fn().mockResolvedValue({ id: "test-id" }),
}));

// Mock rate limiter
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

// Mock input sanitization
jest.mock("@/utils/server/inputSanitization", () => ({
  sanitizeForLogging: jest.fn((input: string) => input),
}));

// Mock firestore utils
jest.mock("@/utils/server/firestoreUtils", () => ({
  getSuggestionsInteractionsCollectionName: jest.fn(() => "prod_suggestions_interactions"),
}));

import { firestoreAdd } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { db } from "@/services/firebase";
import { getSuggestionsInteractionsCollectionName } from "@/utils/server/firestoreUtils";

describe("/api/suggestions/interact", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockRequest = (body: any): NextRequest => {
    return {
      json: jest.fn().mockResolvedValue(body),
      headers: {
        get: jest.fn((name: string) => {
          if (name === "x-forwarded-for") return "192.168.1.1";
          if (name === "x-real-ip") return null;
          return null;
        }),
      },
    } as unknown as NextRequest;
  };

  it("successfully logs a valid suggestion interaction", async () => {
    const mockCollection = {
      add: jest.fn(),
    };
    // db is mocked, so it will exist in tests
    (db!.collection as jest.Mock).mockReturnValue(mockCollection);

    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(genericRateLimiter).toHaveBeenCalled();
    expect(getSuggestionsInteractionsCollectionName).toHaveBeenCalled();
    expect(db!.collection).toHaveBeenCalledWith("prod_suggestions_interactions");
    expect(firestoreAdd).toHaveBeenCalled();
  });

  it("logs broader type suggestions correctly", async () => {
    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-789",
      type: "broader",
      position: 1,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    const addCall = (firestoreAdd as jest.Mock).mock.calls[0];
    const interactionData = addCall[1];
    expect(interactionData.type).toBe("broader");
    expect(interactionData.position).toBe(1);
  });

  it("includes optional questionHash when provided", async () => {
    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
      questionHash: "hash-abc123",
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    const addCall = (firestoreAdd as jest.Mock).mock.calls[0];
    const interactionData = addCall[1];
    expect(interactionData.questionHash).toBe("hash-abc123");
  });

  it("returns 400 for missing convId", async () => {
    const mockBody = {
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid convId");
  });

  it("returns 400 for missing suggestionId", async () => {
    const mockBody = {
      convId: "conv-123",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid suggestionId");
  });

  it("returns 400 for invalid type", async () => {
    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "invalid",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("Invalid type");
  });

  it("returns 400 for invalid position (negative)", async () => {
    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: -1,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("Invalid position");
  });

  it("returns 400 for invalid position (too high)", async () => {
    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 11,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("Invalid position");
  });

  it("returns 429 when rate limit is exceeded", async () => {
    (genericRateLimiter as jest.Mock).mockResolvedValueOnce(false);

    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data.error).toContain("Too many requests");
  });

  // Note: Testing db === null is complex with Jest mocks
  // The error handling for database unavailability is tested through the error handling test below

  it("handles errors gracefully", async () => {
    (firestoreAdd as jest.Mock).mockRejectedValueOnce(new Error("Firestore error"));

    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe("Failed to log interaction");
  });

  it("extracts client IP from headers correctly", async () => {
    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    await POST(req);

    expect(firestoreAdd).toHaveBeenCalled();
    const addCall = (firestoreAdd as jest.Mock).mock.calls[0];
    // firestoreAdd signature: (ref, data, ...)
    const interactionData = addCall[1];
    expect(interactionData.ip).toBe("192.168.1.1");
  });

  it("sets questionHash to null when not provided", async () => {
    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    await POST(req);

    expect(firestoreAdd).toHaveBeenCalled();
    const addCall = (firestoreAdd as jest.Mock).mock.calls[0];
    // firestoreAdd signature: (ref, data, ...)
    const interactionData = addCall[1];
    expect(interactionData.questionHash).toBeNull();
  });

  it("uses environment-prefixed collection name (prod)", async () => {
    (getSuggestionsInteractionsCollectionName as jest.Mock).mockReturnValue("prod_suggestions_interactions");

    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    await POST(req);

    expect(getSuggestionsInteractionsCollectionName).toHaveBeenCalled();
    expect(db!.collection).toHaveBeenCalledWith("prod_suggestions_interactions");
  });

  it("uses environment-prefixed collection name (dev)", async () => {
    (getSuggestionsInteractionsCollectionName as jest.Mock).mockReturnValue("dev_suggestions_interactions");

    const mockBody = {
      convId: "conv-123",
      suggestionId: "suggestion-456",
      type: "deeper",
      position: 0,
    };

    const req = createMockRequest(mockBody);
    await POST(req);

    expect(getSuggestionsInteractionsCollectionName).toHaveBeenCalled();
    expect(db!.collection).toHaveBeenCalledWith("dev_suggestions_interactions");
  });
});
