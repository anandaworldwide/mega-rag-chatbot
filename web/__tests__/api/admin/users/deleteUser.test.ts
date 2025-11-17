import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import { MOCK_UUID_V4 } from "uuid";

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

// Mock API middleware
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: (handler: any) => handler,
}));

import handler from "@/pages/api/admin/users/[userId]";

describe("/api/admin/users/[userId] DELETE user", () => {
  let writeAuditLogSpy: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Get the mock function after module is imported
    const auditLog = await import("@/utils/server/auditLog");
    writeAuditLogSpy = auditLog.writeAuditLog as jest.Mock;
    writeAuditLogSpy.mockClear();
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
    expect(res._getJSONData()).toEqual({ error: "Forbidden" });
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
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

    const targetUserData = {
      email: "target@example.com",
      role: "user",
      firstName: "Target",
      lastName: "User",
      uuid: MOCK_UUID_V4,
      inviteStatus: "accepted",
    };

    let call = 0;
    mockGet.mockImplementation(() => {
      call += 1;
      // First get() is for resolveRequesterRole → return no document (snap.exists = false)
      if (call === 1) {
        return Promise.resolve({ exists: false });
      }
      // Second get() is for the target user document
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
        // resolveRequesterRole fetch for super@example.com
        return Promise.resolve({ exists: false });
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
    (jwtUtils.verifyToken as jest.Mock).mockReturnValue({ email: "admin@example.com", role: "admin" });

    let call = 0;
    mockGet.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve({ exists: false }); // resolveRequesterRole
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
    expect(res._getJSONData()).toEqual({ error: "Firestore error" });
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
