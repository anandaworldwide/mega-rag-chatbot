import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Wrap middleware to no-op so we can control auth in test
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

// Users collection name
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
  getAnswersCollectionName: jest.fn(() => "test_answers"),
}));

// Mock Redis cache deletion
jest.mock("@/utils/server/redisUtils", () => ({
  deleteFromCache: jest.fn().mockResolvedValue(undefined),
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

// Mock site config
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(() => ({ name: "Test Site", shortname: "test", siteId: "test" })),
  loadSiteConfig: jest.fn().mockResolvedValue({ name: "Test Site", shortname: "test", siteId: "test" }),
}));

// Mock audit log
jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn(),
}));

// Minimal DB mock with internal state and transaction support
jest.mock("@/services/firebase", () => {
  const __docMap: Record<string, any> = {};
  const runTransaction = async (fn: any) => {
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
          set: async (data: any, options?: any) => {
            if (options?.merge) {
              __docMap[id] = { ...(__docMap[id] || {}), ...data };
            } else {
              __docMap[id] = data;
            }
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
      set: (docRef: any, data: any, options?: any) => {
        const doc = db.collection(docRef._colName || "test_users").doc(docRef._id || docRef.id);
        return doc.set(data, options);
      },
    });
  };
  const db = {
    __docMap,
    runTransaction,
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
        set: async (data: any, options?: any) => {
          if (options?.merge) {
            __docMap[id] = { ...(__docMap[id] || {}), ...data };
          } else {
            __docMap[id] = data;
          }
        },
      }),
    }),
  };
  return { db };
});

import handler from "@/pages/api/admin/users/[userId]";

describe("/api/admin/users/[userId] role change authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows superuser to change role", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

    // Target user id
    const targetEmail = "target@example.com";

    // Pre-populate the user in the mock database
    const mockDb = jest.requireMock("@/services/firebase").db;
    mockDb.__docMap[targetEmail] = {
      email: targetEmail,
      role: "user",
    };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: targetEmail },
      cookies: { auth: "token" },
      body: { role: "admin" },
    });

    await handler(req, res);
    // withApiMiddleware returns void/Promise<void>; assertions on res
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.user.email).toBe(targetEmail);
    expect(["admin", "superuser", "user"]).toContain(data.user.role);
  });

  it("rejects admin attempting to change role (403)", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
      body: { role: "superuser" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Only superuser may change role" });
  });

  it("rejects invalid role with 400", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
      body: { role: "owner" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Invalid role" });
  });
});
