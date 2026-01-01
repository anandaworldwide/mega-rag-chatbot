import { createMocks } from "node-mocks-http";
import jwt from "jsonwebtoken";
import handler from "@/pages/api/resubscribe";

// Mock Firebase
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
  },
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

jest.mock("@/utils/server/firestoreRetryUtils");

// Mock rate limiter to always allow requests in tests
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
    },
  },
}));

import * as firestoreRetryUtils from "@/utils/server/firestoreRetryUtils";

const mockFirestoreGet = firestoreRetryUtils.firestoreGet as jest.MockedFunction<
  typeof firestoreRetryUtils.firestoreGet
>;
const mockFirestoreSet = firestoreRetryUtils.firestoreSet as jest.MockedFunction<
  typeof firestoreRetryUtils.firestoreSet
>;

// Mock environment variables
process.env.SECURE_TOKEN = "test-jwt-secret";

describe("/api/resubscribe", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should reject non-POST requests", async () => {
    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toEqual({ error: "Method not allowed" });
  });

  it("should reject missing token", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {},
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid or missing token" });
  });

  it("should reject invalid token", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { token: "invalid-token" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid resubscribe token" });
  });

  it("should reject token with wrong purpose", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "wrong_purpose" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid token purpose" });
  });

  it("should reject token without email", async () => {
    const token = jwt.sign({ purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid email in token" });
  });

  it("should handle user not found", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    mockFirestoreGet.mockResolvedValue({
      exists: false,
    } as any);

    const { req, res } = createMocks({
      method: "POST",
      body: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getData())).toEqual({ error: "User not found" });
  });

  it("should successfully resubscribe existing user", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    mockFirestoreGet.mockResolvedValue({
      exists: true,
      data: () => ({ email: "test@example.com", newsletterSubscribed: false }),
    } as any);

    mockFirestoreSet.mockResolvedValue(undefined);

    const { req, res } = createMocks({
      method: "POST",
      body: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({
      success: true,
      message: "Successfully resubscribed to newsletter updates",
    });

    // Verify Firestore update was called
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newsletterSubscribed: true,
        updatedAt: expect.anything(),
      }),
      { merge: true },
      "resubscribe to newsletters"
    );
  });

  it("should handle expired JWT token", async () => {
    const token = jwt.sign(
      { email: "test@example.com", purpose: "newsletter_unsubscribe" },
      "test-jwt-secret",
      { expiresIn: "-1h" } // Expired token
    );

    const { req, res } = createMocks({
      method: "POST",
      body: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Resubscribe link has expired" });
  });

  it("should handle Firestore errors gracefully", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    mockFirestoreGet.mockRejectedValue(new Error("Firestore error"));

    const { req, res } = createMocks({
      method: "POST",
      body: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getData())).toEqual({ error: "Internal server error" });
  });
});
