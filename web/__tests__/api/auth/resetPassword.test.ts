/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import bcrypt from "bcryptjs";
import handler from "@/pages/api/auth/resetPassword";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { validatePasswordStrength, hashPassword } from "@/utils/server/passwordUtils";
import { writeAuditLog } from "@/utils/server/auditLog";

jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/passwordUtils");
jest.mock("@/utils/server/auditLog");
jest.mock("bcryptjs", () => ({ compare: jest.fn() }));
jest.mock("@/utils/server/corsMiddleware", () => ({
  setCorsHeaders: jest.fn(),
  createErrorCorsHeaders: jest.fn(() => ({})),
}));
jest.mock("@/services/firebase", () => ({ db: { collection: jest.fn() } }));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(() => ({}), {
    Timestamp: { now: jest.fn(() => "NOW") },
    FieldValue: { delete: jest.fn(() => "DELETE") },
  }),
}));

const mockLoadSiteConfig = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockValidate = validatePasswordStrength as jest.MockedFunction<typeof validatePasswordStrength>;
const mockHash = hashPassword as jest.MockedFunction<typeof hashPassword>;
const mockAudit = writeAuditLog as jest.MockedFunction<typeof writeAuditLog>;
const mockCompare = bcrypt.compare as unknown as jest.Mock;
const { db } = jest.requireMock("@/services/firebase");

function post(body: Record<string, unknown>) {
  return createMocks<NextApiRequest, NextApiResponse>({ method: "POST", body });
}

const validUserData = {
  inviteStatus: "accepted",
  passwordResetExpiresAt: { toMillis: () => Date.now() + 60_000 },
  passwordResetTokenHash: "token-hash",
};

describe("/api/auth/resetPassword", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfig.mockReturnValue({ requireLogin: true, allowedFrontEndDomains: [] } as any);
    mockRateLimiter.mockResolvedValue(true);
    mockValidate.mockReturnValue({ valid: true } as any);
    mockHash.mockResolvedValue("new-hash");
    mockAudit.mockResolvedValue(undefined as any);
    mockFirestoreSet.mockResolvedValue(undefined as any);
    mockCompare.mockResolvedValue(true);
    mockFirestoreGet.mockResolvedValue({ exists: true, data: () => validUserData } as any);
    db.collection = jest.fn(() => ({ doc: jest.fn(() => ({})) }));
  });

  it("rejects non-POST methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 403 when login is not required", async () => {
    mockLoadSiteConfig.mockReturnValue({ requireLogin: false } as any);
    const { req, res } = post({ token: "t", email: "a@b.com", password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("validates required fields", async () => {
    const { req, res } = post({ email: "a@b.com", password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a weak password", async () => {
    mockValidate.mockReturnValue({ valid: false, message: "weak", requirements: [] } as any);
    const { req, res } = post({ token: "t", email: "a@b.com", password: "weak" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when user is not found", async () => {
    mockFirestoreGet.mockResolvedValue({ exists: false } as any);
    const { req, res } = post({ token: "t", email: "a@b.com", password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), "user_password_reset_failed", "a@b.com", expect.any(Object));
  });

  it("returns 400 when the reset token is expired", async () => {
    mockFirestoreGet.mockResolvedValue({
      exists: true,
      data: () => ({ ...validUserData, passwordResetExpiresAt: { toMillis: () => Date.now() - 1000 } }),
    } as any);
    const { req, res } = post({ token: "t", email: "a@b.com", password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when the token does not match", async () => {
    mockCompare.mockResolvedValue(false);
    const { req, res } = post({ token: "wrong", email: "a@b.com", password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("resets the password successfully", async () => {
    const { req, res } = post({ token: "t", email: "A@B.com", password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockFirestoreSet).toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      "user_password_reset_success",
      "a@b.com",
      expect.objectContaining({ outcome: "success" })
    );
  });
});
