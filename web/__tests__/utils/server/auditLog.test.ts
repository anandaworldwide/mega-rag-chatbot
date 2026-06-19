import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Mock Firebase - define all mocks inline to avoid hoisting issues
jest.mock("@/services/firebase", () => {
  const mockAdd = jest.fn();
  const mockCollection = jest.fn(() => ({ add: mockAdd }));

  return {
    db: {
      collection: mockCollection,
    },
  };
});

// Mock environment utils
jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn(),
}));

// Mock JWT utils
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn(),
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
      fromDate: jest.fn((date) => ({
        seconds: Math.floor(date.getTime() / 1000),
        nanoseconds: 0,
      })),
    },
  },
}));

import { writeAuditLog } from "@/utils/server/auditLog";
import { isDevelopment } from "@/utils/env";
import { verifyToken } from "@/utils/server/jwtUtils";
import { db } from "@/services/firebase";

describe("auditLog", () => {
  const mockIsDevelopment = isDevelopment as jest.Mock;
  const mockVerifyToken = verifyToken as jest.Mock;
  let mockDbCollection: jest.Mock;
  let mockDbAdd: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevelopment.mockReturnValue(false); // Default to production
    mockVerifyToken.mockImplementation(() => {
      throw new Error("No JWT token");
    }); // Default to no JWT

    // Get references to the mocked functions from the mocked module
    mockDbCollection = (db as any).collection;

    // Set up a fresh mock for add that we can track
    mockDbAdd = jest.fn();
    mockDbCollection.mockReturnValue({ add: mockDbAdd });
  });

  describe("writeAuditLog", () => {
    it("captures IP address from x-forwarded-for header", async () => {
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100, 10.0.0.1",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "test_action",
        target: "target@example.com",
        requester: { email: "admin@example.com", role: "admin" },
        details: { outcome: "success" },
        ip: "192.168.1.100", // Should take first IP from comma-separated list
        requestId: null,
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("captures IP address from socket.remoteAddress when x-forwarded-for is not present", async () => {
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      // Mock socket.remoteAddress
      (req as any).socket = { remoteAddress: "127.0.0.1" };

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "test_action",
        target: "target@example.com",
        requester: { email: "admin@example.com", role: "admin" },
        details: { outcome: "success" },
        ip: "127.0.0.1",
        requestId: null,
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("captures request ID from x-request-id header", async () => {
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-request-id": "req-123456",
          "x-forwarded-for": "192.168.1.100",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "test_action",
        target: "target@example.com",
        requester: { email: "admin@example.com", role: "admin" },
        details: { outcome: "success" },
        ip: "192.168.1.100",
        requestId: "req-123456",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("handles missing IP and request ID gracefully", async () => {
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "test_action",
        target: "target@example.com",
        requester: { email: "admin@example.com", role: "admin" },
        details: { outcome: "success" },
        ip: null,
        requestId: null,
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("trims whitespace from IP address", async () => {
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "  192.168.1.100  , 10.0.0.1",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: "192.168.1.100", // Should be trimmed
        })
      );
    });

    it("uses dev_ prefix in development environment", async () => {
      mockIsDevelopment.mockReturnValue(true);
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbCollection).toHaveBeenCalledWith("dev_admin_audit");
    });

    it("uses prod_ prefix in production environment", async () => {
      mockIsDevelopment.mockReturnValue(false);
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbCollection).toHaveBeenCalledWith("prod_admin_audit");
    });

    it("handles missing requester information gracefully", async () => {
      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
        body: {}, // No requester info
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "test_action",
        target: "target@example.com",
        requester: { email: null, role: null },
        details: { outcome: "success" },
        ip: "192.168.1.100",
        requestId: null,
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("handles Firestore errors gracefully (fails silently)", async () => {
      mockDbAdd.mockRejectedValue(new Error("Firestore connection failed"));
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      // Should not throw an error
      await expect(
        writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" })
      ).resolves.toBeUndefined();
    });

    it("extracts requester from JWT cookie when available", async () => {
      mockVerifyToken.mockReturnValue({
        email: "jwt-admin@example.com",
        role: "superuser",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockVerifyToken).toHaveBeenCalledWith("valid-jwt-token");
      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "test_action",
        target: "target@example.com",
        requester: { email: "jwt-admin@example.com", role: "superuser" },
        details: { outcome: "success" },
        ip: "192.168.1.100",
        requestId: null,
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("logs null requester when JWT verification fails", async () => {
      mockVerifyToken.mockImplementation(() => {
        throw new Error("Invalid token");
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
        cookies: {
          authToken: "invalid-jwt-token",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "test_action",
        target: "target@example.com",
        requester: { email: null, role: null },
        details: { outcome: "success" },
        ip: "192.168.1.100",
        requestId: null,
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("logs null requester when no JWT cookie is present", async () => {
      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      await writeAuditLog(req, "test_action", "target@example.com", { outcome: "success" });

      expect(mockVerifyToken).not.toHaveBeenCalled();
      expect(mockDbAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          requester: { email: null, role: null },
        })
      );
    });
  });
});
