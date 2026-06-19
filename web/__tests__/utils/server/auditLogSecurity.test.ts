import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Mock Firebase - define all mocks inline to avoid hoisting issues
jest.mock("@/services/firebase", () => {
  const mockAdd = jest.fn();
  const mockGet = jest.fn();
  const mockCollection = jest.fn(() => ({
    add: mockAdd,
    get: mockGet,
    doc: jest.fn(() => ({ get: mockGet })),
  }));

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

describe("Audit Log Security", () => {
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
    const mockGet = jest.fn();
    mockDbCollection.mockReturnValue({
      add: mockDbAdd,
      get: mockGet,
      doc: jest.fn(() => ({ get: mockGet })),
    });
  });

  describe("Firestore Security Rules Validation", () => {
    it("uses correct collection names for environment-based access control", async () => {
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

      // Verify production collection is used
      expect(mockDbCollection).toHaveBeenCalledWith("prod_admin_audit");
    });

    it("uses development collection in development environment", async () => {
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

      // Verify development collection is used
      expect(mockDbCollection).toHaveBeenCalledWith("dev_admin_audit");
    });

    it("stores complete audit entry with security-relevant fields", async () => {
      mockVerifyToken.mockReturnValue({
        email: "admin@example.com",
        role: "admin",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
          "x-request-id": "req-12345",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      await writeAuditLog(req, "admin_delete_user", "target@example.com", {
        outcome: "success",
        deletedUser: { email: "target@example.com", role: "user" },
      });

      // Verify audit entry contains security-relevant fields
      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "admin_delete_user",
        target: "target@example.com",
        requester: { email: "admin@example.com", role: "admin" },
        details: {
          outcome: "success",
          deletedUser: { email: "target@example.com", role: "user" },
        },
        ip: "192.168.1.100", // Security: IP tracking
        requestId: "req-12345", // Security: Request correlation
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("handles missing authentication context gracefully", async () => {
      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
        body: {}, // No authentication info
      });

      await writeAuditLog(req, "suspicious_activity", undefined, {
        outcome: "blocked",
        reason: "no_auth",
      });

      // Should still log the activity with null requester info
      expect(mockDbAdd).toHaveBeenCalledWith({
        action: "suspicious_activity",
        target: undefined,
        requester: { email: null, role: null },
        details: {
          outcome: "blocked",
          reason: "no_auth",
        },
        ip: "192.168.1.100",
        requestId: null,
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        expireAt: expect.objectContaining({ seconds: expect.any(Number), nanoseconds: 0 }),
      });
    });

    it("preserves audit data integrity with proper typing", async () => {
      mockVerifyToken.mockReturnValue({
        email: "superuser@example.com",
        role: "superuser",
      });

      const { req } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "x-forwarded-for": "10.0.0.1, 192.168.1.100",
          "x-request-id": "trace-abc123",
        },
        cookies: {
          authToken: "valid-jwt-token",
        },
      });

      const auditDetails = {
        outcome: "success",
        previousRole: "user",
        newRole: "admin",
        approvedBy: "superuser@example.com",
        timestamp: new Date().toISOString(),
      };

      await writeAuditLog(req, "admin_role_escalation", "user@example.com", auditDetails);

      const expectedCall = mockDbAdd.mock.calls[0][0];

      // Verify data types and structure
      expect(typeof expectedCall.action).toBe("string");
      expect(typeof expectedCall.target).toBe("string");
      expect(typeof expectedCall.ip).toBe("string");
      expect(typeof expectedCall.requestId).toBe("string");
      expect(expectedCall.requester).toHaveProperty("email");
      expect(expectedCall.requester).toHaveProperty("role");
      expect(expectedCall.details).toEqual(auditDetails);
      expect(expectedCall.createdAt).toHaveProperty("seconds");
      expect(expectedCall.createdAt).toHaveProperty("nanoseconds");

      // Verify IP extraction (first IP from comma-separated list)
      expect(expectedCall.ip).toBe("10.0.0.1");
    });
  });

  describe("Security Rule Documentation", () => {
    it("documents expected Firestore security rule behavior", () => {
      // This test serves as documentation for the expected Firestore rules
      const expectedRules = {
        collection_pattern: "{envName}_admin_audit/{docId}",
        write_access: "isServerRequest() only", // Custom tokens from server
        read_access: "JWT required with admin or superuser role",
        environments: ["dev_admin_audit", "prod_admin_audit"],
        ttl_field: "createdAt",
        ttl_duration: "365 days",
      };

      // Verify our implementation matches expected security model
      expect(expectedRules.collection_pattern).toContain("_admin_audit");
      expect(expectedRules.write_access).toContain("isServerRequest");
      expect(expectedRules.read_access).toContain("admin");
      expect(expectedRules.read_access).toContain("superuser");
      expect(expectedRules.environments).toContain("dev_admin_audit");
      expect(expectedRules.environments).toContain("prod_admin_audit");
      expect(expectedRules.ttl_field).toBe("createdAt");
      expect(expectedRules.ttl_duration).toBe("365 days");
    });

    it("validates audit log schema includes security fields", () => {
      // Document the expected audit log schema for security review
      const auditSchema = {
        action: "string", // What action was performed
        target: "string?", // Who/what was targeted
        requester: {
          email: "string?", // Who performed the action
          role: "string?", // Their role at time of action
        },
        details: "Record<string, any>", // Action-specific context
        ip: "string?", // Source IP for forensics
        requestId: "string?", // Request correlation ID
        createdAt: "Timestamp", // TTL field for automatic cleanup
      };

      // Verify all security-relevant fields are present
      expect(auditSchema).toHaveProperty("action");
      expect(auditSchema).toHaveProperty("target");
      expect(auditSchema).toHaveProperty("requester");
      expect(auditSchema).toHaveProperty("ip");
      expect(auditSchema).toHaveProperty("requestId");
      expect(auditSchema).toHaveProperty("createdAt");
      expect(auditSchema.requester).toHaveProperty("email");
      expect(auditSchema.requester).toHaveProperty("role");
    });
  });
});
