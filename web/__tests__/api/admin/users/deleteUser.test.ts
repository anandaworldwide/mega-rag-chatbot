import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

const MOCK_UUID_V4 = "00000000-0000-4000-8000-000000000000";

// Mock writeAuditLog to capture audit entries
jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn(),
}));

// Mock Firestore
const mockDelete = jest.fn();
const mockGet = jest.fn();
const mockDoc = jest.fn(() => ({
  get: mockGet,
  delete: mockDelete,
}));

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: mockDoc,
    })),
  },
}));

// Mock firestoreUtils
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

// Mock JWT verification
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn(),
  getTokenFromRequest: jest.fn(),
  withJwtAuth: (handler: any) => handler,
}));

// Mock authz functions - behavior configured in individual tests via verifyToken mock
jest.mock("@/utils/server/authz", () => ({
  requireAdminRoleFromFirestore: jest.fn(),
  getRequesterRoleFromFirestore: jest.fn(),
}));

// Mock API middleware
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: (handler: any) => handler,
}));

// Mock rate limiter
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(() => Promise.resolve(true)),
}));

import handler from "@/pages/api/admin/users/[userId]";
import { requireAdminRoleFromFirestore, getRequesterRoleFromFirestore } from "@/utils/server/authz";

const mockRequireAdmin = requireAdminRoleFromFirestore as jest.Mock;
const mockGetRole = getRequesterRoleFromFirestore as jest.Mock;

describe("/api/admin/users/[userId] DELETE user", () => {
  let writeAuditLogSpy: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Get the mock function after module is imported
    const auditLog = await import("@/utils/server/auditLog");
    writeAuditLogSpy = auditLog.writeAuditLog as jest.Mock;
    writeAuditLogSpy.mockClear();

    // Set up authz mocks to check JWT role by default
    mockRequireAdmin.mockImplementation(async (req: any) => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      const payload = (jwtUtils.verifyToken as jest.Mock)(req.cookies?.auth || "");
      const role = payload?.role || "user";
      if (role !== "admin" && role !== "superuser") {
        throw new Error("Unauthorized: Admin privileges required");
      }
    });

    mockGetRole.mockImplementation(async (req: any) => {
      const jwtUtils = await import("@/utils/server/jwtUtils");
      const payload = (jwtUtils.verifyToken as jest.Mock)(req.cookies?.auth || "");
      return payload?.role || "user";
    });
  });

  it("returns 403 for non-admin/superuser", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.getTokenFromRequest as jest.Mock).mockReturnValue("token");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "user@example.com", role: "user" });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Unauthorized: Admin privileges required" });
  });

  it("returns 404 when user not found", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.getTokenFromRequest as jest.Mock).mockReturnValue("token");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

    mockGet.mockResolvedValue({
      exists: false,
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
      query: { userId: "nonexistent@example.com" },
      cookies: { auth: "token" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res._getJSONData()).toEqual({ error: "User not found" });
  });

  it("prevents self-deletion", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.getTokenFromRequest as jest.Mock).mockReturnValue("token");
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        email: "admin@example.com",
        role: "admin",
        firstName: "Admin",
        lastName: "User",
      }),
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
      query: { userId: "admin@example.com" },
      cookies: { auth: "token" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Cannot delete your own account" });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("successfully deletes user as admin", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.getTokenFromRequest as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

    const targetUserData = {
      email: "target@example.com",
      role: "user",
      firstName: "Target",
      lastName: "User",
      uuid: MOCK_UUID_V4,
      inviteStatus: "accepted",
    };

    // Mock Firestore doc() to track which document is being accessed
    // Then mock get() to return appropriate data based on the doc ID
    let currentDocId = "";
    (mockDoc as any).mockImplementation((docId: string) => {
      currentDocId = docId;
      return {
        get: mockGet,
        delete: mockDelete,
      };
    });

    // Mock get() to return data based on which document was requested
    mockGet.mockImplementation(() => {
      // If asking for admin's document (for role verification)
      if (currentDocId === "admin@example.com") {
        return Promise.resolve({
          exists: true,
          data: () => ({ email: "admin@example.com", role: "admin" }),
        });
      }

      // If asking for target user's document
      if (currentDocId === "target@example.com") {
        return Promise.resolve({ exists: true, data: () => targetUserData });
      }

      // Default: document doesn't exist
      return Promise.resolve({ exists: false, data: () => ({}) });
    });
    mockDelete.mockResolvedValue(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      success: true,
      message: "User deleted successfully",
    });

    // Verify user was deleted from Firestore
    expect(mockDelete).toHaveBeenCalledTimes(1);

    // Verify audit log was written
    expect(writeAuditLogSpy).toHaveBeenCalledWith(req, "admin_delete_user", "target@example.com", {
      deletedUser: {
        email: "target@example.com",
        role: "user",
        inviteStatus: "accepted",
        firstName: "Target",
        lastName: "User",
        uuid: MOCK_UUID_V4,
        createdAt: null,
        lastLoginAt: null,
      },
      requesterRole: "admin",
      outcome: "success",
    });
  });

  it("successfully deletes user as superuser", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.getTokenFromRequest as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "super@example.com", role: "superuser" });

    const targetUserData = {
      email: "target@example.com",
      role: "admin",
      firstName: "Target",
      lastName: "Admin",
    };

    let call = 0;
    mockGet.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        // resolveRequesterRole fetch for super@example.com - return superuser role from Firestore
        return Promise.resolve({
          exists: true,
          data: () => ({ email: "super@example.com", role: "superuser" }),
        });
      }
      // user document fetch
      return Promise.resolve({ exists: true, data: () => targetUserData });
    });
    mockDelete.mockResolvedValue(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      success: true,
      message: "User deleted successfully",
    });

    // Verify audit log shows superuser role
    expect(writeAuditLogSpy).toHaveBeenCalledWith(
      req,
      "admin_delete_user",
      "target@example.com",
      expect.objectContaining({
        requesterRole: "superuser",
        outcome: "success",
      })
    );
  });

  it("handles Firestore deletion errors gracefully", async () => {
    const jwtUtils = await import("@/utils/server/jwtUtils");
    (jwtUtils.getTokenFromRequest as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

    let call = 0;
    mockGet.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        // resolveRequesterRole fetch - return admin role from Firestore
        return Promise.resolve({
          exists: true,
          data: () => ({ email: "admin@example.com", role: "admin" }),
        });
      }
      return Promise.resolve({ exists: true, data: () => ({ email: "target@example.com", role: "user" }) });
    });
    mockDelete.mockRejectedValue(new Error("Firestore error"));

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
      query: { userId: "target@example.com" },
      cookies: { auth: "token" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(500);
    // Error message is sanitized, so we just check it exists
    expect(res._getJSONData()).toHaveProperty("error");
    expect(typeof res._getJSONData().error).toBe("string");
  });

  it("returns 405 for unsupported methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PUT",
      query: { userId: "test@example.com" },
    });

    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res._getJSONData()).toEqual({ error: "Method not allowed" });
  });
});
