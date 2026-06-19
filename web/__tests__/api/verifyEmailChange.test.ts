import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/verifyEmailChange";
import { db } from "@/services/firebase";
import { writeAuditLog } from "@/utils/server/auditLog";
import { sendEmailChangeConfirmationEmails } from "@/utils/server/userEmailChangeUtils";
import bcrypt from "bcryptjs";

const setCookieMock = jest.fn();
jest.mock("cookies", () =>
  jest.fn().mockImplementation(() => ({
    set: setCookieMock,
    get: jest.fn(),
  }))
);

// Mock dependencies
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      fromDate: jest.fn().mockReturnValue({ toMillis: () => Date.now() + 24 * 60 * 60 * 1000 }),
      now: jest.fn().mockReturnValue({ toMillis: () => Date.now() }),
    },
    FieldValue: {
      delete: jest.fn().mockReturnValue("__DELETE__"),
    },
  },
}));
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
    batch: jest.fn(),
  },
}));
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));
jest.mock("@/utils/server/auditLog");
jest.mock("@/utils/server/userEmailChangeUtils");
jest.mock("bcryptjs");

const mockDb = db as any;
const mockWriteAuditLog = writeAuditLog as jest.MockedFunction<typeof writeAuditLog>;
const mockSendEmailChangeConfirmationEmails = sendEmailChangeConfirmationEmails as jest.MockedFunction<
  typeof sendEmailChangeConfirmationEmails
>;
const mockBcryptCompare = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;

describe("/api/verifyEmailChange", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setCookieMock.mockClear();
    process.env.SECURE_TOKEN = "test-jwt-secret";
    process.env.SITE_ID = "test";

    // Default mocks
    mockWriteAuditLog.mockResolvedValue();
    mockSendEmailChangeConfirmationEmails.mockResolvedValue();
    (mockBcryptCompare as any).mockResolvedValue(true);

    // Mock batch operations
    const mockBatch = {
      set: jest.fn(),
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    mockDb.batch.mockReturnValue(mockBatch);
  });

  it("should reject non-POST requests", async () => {
    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toEqual({ error: "Method not allowed" });
  });

  it("should reject requests without token or email", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {},
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Missing token or email" });
  });

  it("should reject when no pending email change found", async () => {
    mockDb.collection.mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
        }),
      }),
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token: "valid-token", email: "new@example.com" },
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "No pending email change found" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "email_change_verified", "new@example.com", {
      outcome: "failed_no_pending_change",
    });
  });

  it("should reject when no token hash exists", async () => {
    const mockUserDoc = {
      id: "user@example.com", // Email is stored as document ID
      data: () => ({
        pendingEmail: "new@example.com",
        // Missing emailChangeTokenHash
      }),
    };

    mockDb.collection.mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ empty: false, docs: [mockUserDoc] }),
        }),
      }),
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token: "valid-token", email: "new@example.com" },
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid verification request" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "email_change_verified", "new@example.com", {
      currentEmail: "user@example.com",
      outcome: "failed_no_token",
    });
  });

  it("should reject invalid tokens", async () => {
    (mockBcryptCompare as any).mockResolvedValue(false);

    const mockUserDoc = {
      id: "user@example.com", // Email is stored as document ID
      data: () => ({
        pendingEmail: "new@example.com",
        emailChangeTokenHash: "hashed-token",
        emailChangeExpiresAt: { toMillis: () => Date.now() + 60000 },
      }),
    };

    mockDb.collection.mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ empty: false, docs: [mockUserDoc] }),
        }),
      }),
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token: "invalid-token", email: "new@example.com" },
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Invalid verification token" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "email_change_verified", "new@example.com", {
      currentEmail: "user@example.com",
      outcome: "failed_invalid_token",
    });
  });

  it("should reject expired tokens", async () => {
    const mockUserDoc = {
      id: "user@example.com", // Email is stored as document ID
      data: () => ({
        pendingEmail: "new@example.com",
        emailChangeTokenHash: "hashed-token",
        emailChangeExpiresAt: { toMillis: () => Date.now() - 60000 }, // Expired
      }),
    };

    mockDb.collection.mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ empty: false, docs: [mockUserDoc] }),
        }),
      }),
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token: "valid-token", email: "new@example.com" },
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Verification link has expired" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "email_change_verified", "new@example.com", {
      currentEmail: "user@example.com",
      outcome: "failed_token_expired",
    });
  });

  it("should successfully verify and update email", async () => {
    const mockUserDoc = {
      id: "user@example.com", // Email is stored as document ID
      ref: { id: "user-doc-ref" },
      data: () => ({
        pendingEmail: "new@example.com",
        emailChangeTokenHash: "hashed-token",
        emailChangeExpiresAt: { toMillis: () => Date.now() + 60000 },
        role: "user",
      }),
    };

    mockDb.collection.mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ empty: false, docs: [mockUserDoc] }),
        }),
      }),
      doc: jest.fn().mockReturnValue({ id: "new-doc-ref" }),
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token: "valid-token", email: "new@example.com" },
      headers: { "x-forwarded-proto": "https" },
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());
    expect(responseData.success).toBe(true);
    expect(responseData.newEmail).toBe("new@example.com");
    expect(responseData.message).toBe("Email address updated successfully");

    expect(setCookieMock).toHaveBeenCalledWith(
      "authToken",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        path: "/",
      })
    );
    expect(setCookieMock).toHaveBeenCalledWith(
      "hasSession",
      "1",
      expect.objectContaining({
        httpOnly: false,
        path: "/",
      })
    );

    expect(mockSendEmailChangeConfirmationEmails).toHaveBeenCalledWith("user@example.com", "new@example.com");

    expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "email_change_verified", "new@example.com", {
      previousEmail: "user@example.com",
      outcome: "success",
    });
  });

  it("should handle database errors gracefully", async () => {
    mockDb.collection.mockImplementation(() => {
      throw new Error("Database connection failed");
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token: "valid-token", email: "new@example.com" },
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getData())).toEqual({ error: "Failed to verify email change" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "email_change_verified", "new@example.com", {
      outcome: "failed_server_error",
      error: "Database connection failed",
    });
  });

  it("should handle missing expiry timestamp gracefully", async () => {
    const mockUserDoc = {
      data: () => ({
        email: "user@example.com",
        pendingEmail: "new@example.com",
        emailChangeTokenHash: "hashed-token",
        // Missing emailChangeExpiresAt
      }),
    };

    mockDb.collection.mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ empty: false, docs: [mockUserDoc] }),
        }),
      }),
    });

    const { req, res } = createMocks({
      method: "POST",
      body: { token: "valid-token", email: "new@example.com" },
    });

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Verification link has expired" });
  });
});
