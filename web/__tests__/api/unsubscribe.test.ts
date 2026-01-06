import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/unsubscribe";
import jwt from "jsonwebtoken";
import * as firestoreRetryUtils from "@/utils/server/firestoreRetryUtils";
import * as firestoreUtils from "@/utils/server/firestoreUtils";
import * as loadSiteConfig from "@/utils/server/loadSiteConfig";

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        // Mock document reference
      })),
    })),
  },
}));

jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/firestoreUtils");
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/corsMiddleware", () => ({
  createErrorCorsHeaders: jest.fn(() => ({})),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true), // Always allow in tests
}));

jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
    },
  },
}));

const mockFirestoreGet = firestoreRetryUtils.firestoreGet as jest.MockedFunction<
  typeof firestoreRetryUtils.firestoreGet
>;
const mockFirestoreSet = firestoreRetryUtils.firestoreSet as jest.MockedFunction<
  typeof firestoreRetryUtils.firestoreSet
>;
const mockGetUsersCollectionName = firestoreUtils.getUsersCollectionName as jest.MockedFunction<
  typeof firestoreUtils.getUsersCollectionName
>;
const mockLoadSiteConfig = loadSiteConfig.loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig.loadSiteConfig>;

describe("/api/unsubscribe", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SECURE_TOKEN = "test-jwt-secret";
    mockGetUsersCollectionName.mockReturnValue("test_users");
    mockLoadSiteConfig.mockResolvedValue({
      name: "Test Site Newsletter",
      shortname: "Newsletter",
      siteId: "test",
    } as any);
  });

  afterEach(() => {
    delete process.env.SECURE_TOKEN;
  });

  it("should return 405 for non-GET requests", async () => {
    const { req, res } = createMocks({
      method: "POST",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toEqual({ error: "Method not allowed" });
  });

  it("should return 400 for missing token", async () => {
    const { req, res } = createMocks({
      method: "GET",
      query: {},
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid or missing token" });
  });

  it("should return 400 for invalid token type", async () => {
    const { req, res } = createMocks({
      method: "GET",
      query: { token: ["array", "token"] },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid or missing token" });
  });

  it("should return 500 when SECURE_TOKEN is not set", async () => {
    delete process.env.SECURE_TOKEN;

    const { req, res } = createMocks({
      method: "GET",
      query: { token: "some-token" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getData())).toEqual({ error: "Server configuration error" });
  });

  it("should return 400 for invalid JWT token", async () => {
    const { req, res } = createMocks({
      method: "GET",
      query: { token: "invalid-jwt-token" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid unsubscribe token" });
  });

  it("should return 400 for token with wrong purpose", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "wrong_purpose" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    const { req, res } = createMocks({
      method: "GET",
      query: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid token purpose" });
  });

  it("should return 404 for non-existent user", async () => {
    const token = jwt.sign({ email: "nonexistent@example.com", purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    mockFirestoreGet.mockResolvedValue({
      exists: false,
    } as any);

    const { req, res } = createMocks({
      method: "GET",
      query: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getData())).toEqual({ error: "User not found" });
  });

  it("should successfully unsubscribe existing user", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    mockFirestoreGet.mockResolvedValue({
      exists: true,
      data: () => ({ email: "test@example.com", newsletterSubscribed: true }),
    } as any);

    mockFirestoreSet.mockResolvedValue(undefined);

    const { req, res } = createMocks({
      method: "GET",
      query: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader("Content-Type")).toBe("text/html");
    expect(res._getData()).toContain("Unsubscribed Successfully");
    expect(res._getData()).toContain("test@example.com");
    expect(res._getData()).toContain("Newsletter");
    expect(res._getData()).toContain("Resubscribe to newsletter updates");
    expect(res._getData()).toContain("Go to Home Page");
    expect(res._getData()).toContain('href="/"');

    // Verify Firestore update was called
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newsletterSubscribed: false,
        updatedAt: expect.anything(),
      }),
      { merge: true },
      "unsubscribe from newsletters"
    );
  });

  it("should handle expired JWT token", async () => {
    const token = jwt.sign(
      { email: "test@example.com", purpose: "newsletter_unsubscribe" },
      "test-jwt-secret",
      { expiresIn: "-1h" } // Expired token
    );

    const { req, res } = createMocks({
      method: "GET",
      query: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Unsubscribe link has expired" });
  });

  it("should use fallback site name when config is null", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    mockFirestoreGet.mockResolvedValue({
      exists: true,
      data: () => ({ email: "test@example.com", newsletterSubscribed: true }),
    } as any);

    mockFirestoreSet.mockResolvedValue(undefined);
    mockLoadSiteConfig.mockResolvedValue(null);

    const { req, res } = createMocks({
      method: "GET",
      query: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).toContain("Newsletter");
    expect(res._getData()).toContain("Resubscribe to newsletter updates");
    expect(res._getData()).toContain("Go to Home Page");
  });

  it("should handle Firestore errors gracefully", async () => {
    const token = jwt.sign({ email: "test@example.com", purpose: "newsletter_unsubscribe" }, "test-jwt-secret", {
      expiresIn: "1h",
    });

    mockFirestoreGet.mockRejectedValue(new Error("Firestore connection failed"));

    const { req, res } = createMocks({
      method: "GET",
      query: { token },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getData())).toEqual({ error: "Failed to process unsubscribe request" });
  });
});
