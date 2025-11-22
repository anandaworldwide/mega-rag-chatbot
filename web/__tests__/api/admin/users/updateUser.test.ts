import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Mock JWT wrapper to no-op
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: (handler: any) => handler,
  verifyToken: jest.fn(),
  getTokenFromRequest: jest.fn(() => ({ email: "admin@example.com", role: "admin" })),
}));

// Mock firebase-admin timestamps used by handler
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1, nanoseconds: 0 })),
      fromDate: jest.fn((date: Date) => ({ seconds: Math.floor(date.getTime() / 1000), nanoseconds: 0 })),
    },
  },
}));

// Users collection name (site-scoped)
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
  getAnswersCollectionName: jest.fn(() => "test_answers"),
}));

// Mock site config for email brand
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(() => ({ name: "Test Site", shortname: "test", siteId: "test" })),
  loadSiteConfig: jest.fn().mockResolvedValue({ name: "Test Site", shortname: "test", siteId: "test" }),
}));

// Mock AWS SES client so we don't actually send mail
jest.mock("@aws-sdk/client-ses", () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  SendEmailCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));

// Spy on audit log writes
const writeAuditLogSpy = jest.fn();
jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: (...args: any[]) => writeAuditLogSpy(...args),
}));

// Mock Firestore retry utils
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreQueryGet: jest.fn().mockResolvedValue({
    docs: [], // Empty array for conversation count tests
  }),
  isCode14Error: jest.fn((error: unknown) => {
    // Check if error has code 14 (unavailable)
    return (error as any)?.code === 14;
  }),
  retryOnCode14: jest.fn((fn: () => Promise<any>) => fn()),
}));

// Mock Redis cache deletion
jest.mock("@/utils/server/redisUtils", () => ({
  deleteFromCache: jest.fn().mockResolvedValue(undefined),
}));

// Minimal in-memory Firestore mock with transaction support
jest.mock("@/services/firebase", () => {
  const __docMap: Record<string, any> = {};
  const runTransaction = async (fn: any) => {
    // Provide a shim so that tx.get can be passed the same object shape used inside the handler
    const db = {
      collection: (name: string) => ({
        __name: name,
        doc: (id: string) => ({
          __id: id,
          get: async () => {
            const entry = __docMap[id];
            if (entry === undefined) return { exists: false, data: () => ({}) };
            return { exists: true, data: () => entry };
          },
          set: async (data: any) => {
            __docMap[id] = { ...(__docMap[id] || {}), ...data };
          },
          delete: async () => {
            delete __docMap[id];
          },
        }),
      }),
    } as any;
    return fn({
      get: async (docRef: any) =>
        db
          .collection(docRef._colName || "test_users")
          .doc(docRef._id || docRef.id)
          .get(),
      set: (docRef: any, data: any) =>
        db
          .collection(docRef._colName || "test_users")
          .doc(docRef._id || docRef.id)
          .set(data),
      delete: (docRef: any) =>
        db
          .collection(docRef._colName || "test_users")
          .doc(docRef._id || docRef.id)
          .delete(),
    });
  };
  const db = {
    __docMap,
    collection: (name: string) => ({
      __name: name,
      doc: (id: string) => ({
        _colName: name,
        _id: id,
        get: async () => {
          const entry = __docMap[id];
          if (entry === undefined) return { exists: false, data: () => ({}) };
          return { exists: true, data: () => entry };
        },
        set: async (data: any) => {
          __docMap[id] = { ...(__docMap[id] || {}), ...data };
        },
        delete: async () => {
          delete __docMap[id];
        },
      }),
    }),
    runTransaction,
  };
  return { db };
});

import handler from "@/pages/api/admin/users/[userId]";

describe("/api/admin/users/[userId] update user", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    writeAuditLogSpy.mockClear();
  });

  it("GET returns 403 for non-admin/superuser", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "user@example.com", role: "user" });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Forbidden" });
  });

  it("rejects invalid email format with 400", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "old@example.com" },
      body: { email: "not-an-email" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Invalid email format" });
  });

  it("enforces per-site uniqueness: 409 when new email already exists", async () => {
    // Seed an existing record that will conflict (requires superuser to set role)
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "root@example.com", role: "superuser" });
    const seedReq = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "seed@example.com" },
      cookies: { auth: "token" },
      body: { role: "user" },
    });
    await handler(seedReq.req, seedReq.res);
    expect(seedReq.res.statusCode).toBe(200);

    // Also create the current user that will attempt the change
    const seedCurrent = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "old@example.com" },
      cookies: { auth: "token" },
      body: { role: "user" },
    });
    await handler(seedCurrent.req, seedCurrent.res);
    expect(seedCurrent.res.statusCode).toBe(200);

    // Now attempt to change current user's email to the seeded one → conflict
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "old@example.com" },
      body: { email: "seed@example.com" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res._getJSONData()).toEqual({ error: "Email already in use" });
  });

  it("successfully changes email and writes audit log", async () => {
    // Create an initial record implicitly via role update (requires superuser)
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "root@example.com", role: "superuser" });
    const seed = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "from@example.com" },
      cookies: { auth: "token" },
      body: { role: "user" },
    });
    await handler(seed.req, seed.res);
    expect(seed.res.statusCode).toBe(200);

    // Now change the email
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "from@example.com" },
      body: { email: "to@example.com" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.user.id).toBe("to@example.com");
    expect(writeAuditLogSpy).toHaveBeenCalledWith(expect.anything(), "admin_change_email", "from@example.com", {
      newEmail: "to@example.com",
      outcome: "success",
    });
  });

  it("writes audit log on role change", async () => {
    // Make the requester a superuser for role change
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "root@example.com", role: "superuser" });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
      body: { role: "admin" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(writeAuditLogSpy).toHaveBeenCalledWith(expect.anything(), "admin_change_role", "target@example.com", {
      role: "admin",
      outcome: "success",
    });
  });

  it("GET returns conversation count for all admin roles, no chat details", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");

    // Test admin user - should get conversation count only
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });
    const adminReq = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
    });

    await handler(adminReq.req, adminReq.res);
    expect(adminReq.res.statusCode).toBe(200);
    const adminResponse = adminReq.res._getJSONData();
    expect(adminResponse.user).not.toHaveProperty("chats"); // No chats field at all
    expect(adminResponse.user).toHaveProperty("conversationCount");
    expect(typeof adminResponse.user.conversationCount).toBe("number");

    // Test superuser - should also only get conversation count, no chat details
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });
    const superReq = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
    });

    await handler(superReq.req, superReq.res);
    expect(superReq.res.statusCode).toBe(200);
    const superResponse = superReq.res._getJSONData();
    expect(superResponse.user).not.toHaveProperty("chats"); // No chats field for superusers either
    expect(superResponse.user).toHaveProperty("conversationCount");
    expect(typeof superResponse.user.conversationCount).toBe("number");
  });

  it("should update JWT cookie when admin changes their own email", async () => {
    // Mock JWT token verification to return admin@example.com as the requester
    const mockVerifyToken = jest.requireMock("@/utils/server/jwtUtils").verifyToken;
    mockVerifyToken.mockReturnValue({
      email: "admin@example.com",
      role: "admin",
      site: "test",
      client: "web",
    });

    // Mock environment variables for JWT signing
    process.env.SECURE_TOKEN = "test-jwt-secret";
    process.env.SITE_ID = "test";

    // Set up initial admin user document
    const mockDb = jest.requireMock("@/services/firebase").db;
    mockDb.__docMap["admin@example.com"] = {
      email: "admin@example.com",
      role: "admin",
      uuid: "admin-uuid-123",
      firstName: "Admin",
      lastName: "User",
    };

    // Create request for admin changing their own email
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "admin@example.com" },
      body: { email: "newadmin@example.com" },
      cookies: { auth: "mock-jwt-token" },
      headers: { "x-forwarded-proto": "https" },
    });

    const handler = jest.requireActual("@/pages/api/admin/users/[userId]").default;
    await handler(req, res);

    expect(res.statusCode).toBe(200);

    // Verify the user document was moved to new email
    expect(mockDb.__docMap["admin@example.com"]).toBeUndefined();
    expect(mockDb.__docMap["newadmin@example.com"]).toBeDefined();
    // Note: email is now stored as document ID, not as a field
    expect(mockDb.__docMap["newadmin@example.com"].email).toBeUndefined();

    // Verify JWT cookie was updated
    const setCookieHeaders = res.getHeaders()["set-cookie"] as string[];
    expect(setCookieHeaders).toBeDefined();
    expect(setCookieHeaders.length).toBeGreaterThan(0);

    const authCookie = setCookieHeaders.find((cookie) => cookie.startsWith("auth="));
    expect(authCookie).toBeDefined();
    expect(authCookie).toContain("HttpOnly");
    expect(authCookie).toContain("Secure");
    expect(authCookie).toContain("SameSite=Lax");

    // Verify audit log was written
    expect(writeAuditLogSpy).toHaveBeenCalledWith(expect.anything(), "admin_change_email", "admin@example.com", {
      newEmail: "newadmin@example.com",
      outcome: "success",
    });
  });
});
