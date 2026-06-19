import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Wrap middleware to no-op so we can control auth in test
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: (handler: any) => handler,
  verifyToken: jest.fn(),
  getTokenFromRequest: jest.fn(() => ({ email: "admin@example.com", role: "admin" })),
}));

// Mock authz functions - behavior configured in individual tests via verifyToken mock
jest.mock("@/utils/server/authz", () => ({
  requireAdminRoleFromFirestore: jest.fn(),
  getRequesterRoleFromFirestore: jest.fn(),
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
import { requireAdminRoleFromFirestore, getRequesterRoleFromFirestore } from "@/utils/server/authz";

const mockRequireAdmin = requireAdminRoleFromFirestore as jest.Mock;
const mockGetRole = getRequesterRoleFromFirestore as jest.Mock;

describe("/api/admin/users/[userId] role change authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear mock database between tests to prevent test pollution
    const mockDb = jest.requireMock("@/services/firebase").db;
    Object.keys(mockDb.__docMap).forEach((key) => delete mockDb.__docMap[key]);

    // Set up authz mocks to check JWT role by default
    mockRequireAdmin.mockImplementation(async (req: any) => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      const payload = (jwtUtils.verifyToken as jest.Mock)(req.cookies?.authToken || "");
      const role = payload?.role || "user";
      if (role !== "admin" && role !== "superuser") {
        throw new Error("Unauthorized: Admin privileges required");
      }
    });

    mockGetRole.mockImplementation(async (req: any) => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      const payload = (jwtUtils.verifyToken as jest.Mock)(req.cookies?.authToken || "");
      return payload?.role || "user";
    });
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
      cookies: { authToken: "token" },
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

    // Pre-populate the target user in the mock database
    const mockDb = jest.requireMock("@/services/firebase").db;
    mockDb.__docMap["target@example.com"] = {
      email: "target@example.com",
      role: "user",
    };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "target@example.com" },
      cookies: { authToken: "token" },
      body: { role: "superuser" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Only superuser may change role" });
  });

  it("allows simultaneous role change to admin + enable approver on a 'user' role target", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

    const targetEmail = "newuser@example.com";
    const mockDb = jest.requireMock("@/services/firebase").db;
    mockDb.__docMap[targetEmail] = {
      email: targetEmail,
      role: "user",
    };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: targetEmail },
      cookies: { authToken: "token" },
      body: {
        role: "admin",
        isApprover: true,
        approverLocation: "Portland",
        approverRegion: "United States",
      },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.user.role).toBe("admin");
    expect(data.user.isApprover).toBe(true);
    expect(data.user.approverLocation).toBe("Portland");
    expect(data.user.approverRegion).toBe("United States");
  });

  it("rejects approver enable when role stays 'user' (no role change in request)", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

    const targetEmail = "regularuser@example.com";
    const mockDb = jest.requireMock("@/services/firebase").db;
    mockDb.__docMap[targetEmail] = {
      email: targetEmail,
      role: "user",
    };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: targetEmail },
      cookies: { authToken: "token" },
      body: {
        isApprover: true,
        approverLocation: "Portland",
      },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData().error).toMatch(/admin or superuser/);
  });

  it("rejects invalid role with 400", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

    // Pre-populate the target user in the mock database
    const mockDb = jest.requireMock("@/services/firebase").db;
    mockDb.__docMap["target@example.com"] = {
      email: "target@example.com",
      role: "user",
    };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      query: { userId: "target@example.com" },
      cookies: { authToken: "token" },
      body: { role: "owner" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Invalid role" });
  });
});
