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

// Mock site config
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(() => ({ name: "Test Site", shortname: "test", siteId: "test" })),
  loadSiteConfig: jest.fn().mockResolvedValue({ name: "Test Site", shortname: "test", siteId: "test" }),
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

describe("/api/admin/users/[userId] approver settings authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the document map
    const mockDb = jest.requireMock("@/services/firebase").db;
    Object.keys(mockDb.__docMap).forEach((key) => {
      delete mockDb.__docMap[key];
    });
  });

  describe("Admin cannot set approver fields", () => {
    it("rejects admin attempting to set isApprover (403)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

      // Create an admin user first
      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { isApprover: true },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({ error: "Only superuser may update approver settings" });
    });

    it("rejects admin attempting to set approverLocation (403)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverLocation: "Nevada City, CA" },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({ error: "Only superuser may update approver settings" });
    });

    it("rejects admin attempting to set approverRegion (403)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverRegion: "United States" },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({ error: "Only superuser may update approver settings" });
    });

    it("rejects admin attempting to set all approver fields at once (403)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: {
          isApprover: true,
          approverLocation: "Nevada City, CA",
          approverRegion: "United States",
        },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({ error: "Only superuser may update approver settings" });
    });
  });

  describe("Superuser can set approver fields", () => {
    it("allows superuser to set isApprover on admin user", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { isApprover: true },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.isApprover).toBe(true);
    });

    it("allows superuser to set approverLocation on admin user", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverLocation: "Nevada City, CA" },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverLocation).toBe("Nevada City, CA");
    });

    it("allows superuser to set approverRegion on admin user", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverRegion: "United States" },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverRegion).toBe("United States");
    });

    it("allows superuser to set all approver fields at once on admin user", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: {
          isApprover: true,
          approverLocation: "Nevada City, CA",
          approverRegion: "United States",
        },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.isApprover).toBe(true);
      expect(data.user.approverLocation).toBe("Nevada City, CA");
      expect(data.user.approverRegion).toBe("United States");
    });

    it("allows superuser to set approver fields on superuser role", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "superuser",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: {
          isApprover: true,
          approverLocation: "Nevada City, CA",
          approverRegion: "United States",
        },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.isApprover).toBe(true);
      expect(data.user.approverLocation).toBe("Nevada City, CA");
      expect(data.user.approverRegion).toBe("United States");
    });
  });

  describe("Approver fields can only be set on admin/superuser roles", () => {
    it("rejects setting approver fields on regular user role (400)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "user",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { isApprover: true },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Approver settings can only be set on admin or superuser roles",
      });
    });

    it("rejects setting approverLocation on regular user role (400)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "user",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverLocation: "Nevada City, CA" },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Approver settings can only be set on admin or superuser roles",
      });
    });

    it("rejects setting approverRegion on regular user role (400)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "user",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverRegion: "United States" },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Approver settings can only be set on admin or superuser roles",
      });
    });
  });

  describe("Validation of approver fields", () => {
    it("rejects invalid isApprover type (400)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { isApprover: "true" }, // String instead of boolean
      });

      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({ error: "Invalid isApprover value" });
    });

    it("rejects approverLocation exceeding max length (400)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const longLocation = "a".repeat(201); // 201 characters, exceeds max of 200

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverLocation: longLocation },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Invalid approver location (max 200 characters)",
      });
    });

    it("rejects approverRegion exceeding max length (400)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const longRegion = "a".repeat(201); // 201 characters, exceeds max of 200

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverRegion: longRegion },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Invalid approver region (max 200 characters)",
      });
    });

    it("allows approverLocation at max length (200 characters)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const maxLengthLocation = "a".repeat(200); // Exactly 200 characters

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverLocation: maxLengthLocation },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverLocation).toBe(maxLengthLocation);
    });

    it("allows approverRegion at max length (200 characters)", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const maxLengthRegion = "a".repeat(200); // Exactly 200 characters

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverRegion: maxLengthRegion },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverRegion).toBe(maxLengthRegion);
    });

    it("trims whitespace from approverLocation", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverLocation: "  Nevada City, CA  " },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverLocation).toBe("Nevada City, CA");
    });

    it("trims whitespace from approverRegion", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverRegion: "  United States  " },
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverRegion).toBe("United States");
    });

    it("converts empty approverLocation to null", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverLocation: "   " }, // Only whitespace
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverLocation).toBeNull();
    });

    it("converts empty approverRegion to null", async () => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

      const mockDb = jest.requireMock("@/services/firebase").db;
      mockDb.__docMap["target@example.com"] = {
        role: "admin",
        email: "target@example.com",
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        query: { userId: "target@example.com" },
        cookies: { authToken: "token" },
        body: { approverRegion: "   " }, // Only whitespace
      });

      await handler(req, res);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.user.approverRegion).toBeNull();
    });
  });
});
