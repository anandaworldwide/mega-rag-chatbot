/** @jest-environment node */

import type { NextApiRequest, NextApiResponse } from "next";
import { isAdminPageAllowed, isSuperuserPageAllowed } from "@/utils/server/adminPageGate";

jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn(),
}));

jest.mock("@/utils/server/sudoCookieUtils", () => ({
  getSudoCookie: jest.fn(),
}));

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "users"),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
}));

import { verifyToken } from "@/utils/server/jwtUtils";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { db } from "@/services/firebase";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";

const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockGetSudoCookie = getSudoCookie as jest.MockedFunction<typeof getSudoCookie>;
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;

describe("adminPageGate", () => {
  const req = { cookies: {} } as NextApiRequest;
  const res = {} as NextApiResponse;

  beforeEach(() => {
    jest.clearAllMocks();
    req.cookies = {};
  });

  describe("isAdminPageAllowed", () => {
    it("returns false when login required and no auth cookie", async () => {
      const allowed = await isAdminPageAllowed(req, res, { requireLogin: true } as any);
      expect(allowed).toBe(false);
    });

    it("returns true when JWT role is admin", async () => {
      req.cookies = { authToken: "valid-token" };
      mockVerifyToken.mockReturnValue({ role: "admin", email: "admin@example.com" } as any);

      const allowed = await isAdminPageAllowed(req, res, { requireLogin: true } as any);
      expect(allowed).toBe(true);
    });

    it("returns true when JWT role is superuser", async () => {
      req.cookies = { authToken: "valid-token" };
      mockVerifyToken.mockReturnValue({ role: "superuser", email: "su@example.com" } as any);

      const allowed = await isAdminPageAllowed(req, res, { requireLogin: true } as any);
      expect(allowed).toBe(true);
    });

    it("falls back to Firestore role when JWT role is user", async () => {
      req.cookies = { authToken: "valid-token" };
      mockVerifyToken.mockReturnValue({ role: "user", email: "admin@example.com" } as any);

      const mockDoc = jest.fn();
      const mockCollection = jest.fn(() => ({ doc: mockDoc }));
      (db as any).collection = mockCollection;
      mockDoc.mockReturnValue("user-doc-ref");
      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({ role: "admin" }),
      } as any);

      const allowed = await isAdminPageAllowed(req, res, { requireLogin: true } as any);
      expect(allowed).toBe(true);
      expect(mockFirestoreGet).toHaveBeenCalled();
    });

    it("returns false when token verification fails", async () => {
      req.cookies = { authToken: "bad-token" };
      mockVerifyToken.mockImplementation(() => {
        throw new Error("invalid token");
      });

      const allowed = await isAdminPageAllowed(req, res, { requireLogin: true } as any);
      expect(allowed).toBe(false);
    });

    it("uses sudo cookie on no-login sites", async () => {
      mockGetSudoCookie.mockReturnValue({ sudoCookieValue: true });

      const allowed = await isAdminPageAllowed(req, res, { requireLogin: false } as any);
      expect(allowed).toBe(true);
      expect(mockGetSudoCookie).toHaveBeenCalledWith(req, res);
    });

    it("returns false when sudo cookie missing on no-login sites", async () => {
      mockGetSudoCookie.mockReturnValue({ sudoCookieValue: false });

      const allowed = await isAdminPageAllowed(req, res, { requireLogin: false } as any);
      expect(allowed).toBe(false);
    });
  });

  describe("isSuperuserPageAllowed", () => {
    it("returns true when JWT role is superuser", async () => {
      req.cookies = { authToken: "valid-token" };
      mockVerifyToken.mockReturnValue({ role: "superuser", email: "su@example.com" } as any);

      const allowed = await isSuperuserPageAllowed(req, res, { requireLogin: true } as any);
      expect(allowed).toBe(true);
    });

    it("returns false when JWT role is admin but not superuser", async () => {
      req.cookies = { authToken: "valid-token" };
      mockVerifyToken.mockReturnValue({ role: "admin", email: "admin@example.com" } as any);

      const mockDoc = jest.fn();
      (db as any).collection = jest.fn(() => ({ doc: mockDoc }));
      mockDoc.mockReturnValue("user-doc-ref");
      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({ role: "admin" }),
      } as any);

      const allowed = await isSuperuserPageAllowed(req, res, { requireLogin: true } as any);
      expect(allowed).toBe(false);
    });

    it("uses sudo cookie on no-login sites", async () => {
      mockGetSudoCookie.mockReturnValue({ sudoCookieValue: true });

      const allowed = await isSuperuserPageAllowed(req, res, { requireLogin: false } as any);
      expect(allowed).toBe(true);
    });
  });
});
