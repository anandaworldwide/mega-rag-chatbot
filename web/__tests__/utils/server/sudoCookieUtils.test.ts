/** @jest-environment node */

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(true),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("@/utils/server/ipUtils", () => ({
  getClientIp: jest.fn().mockReturnValue("127.0.0.1"),
}));

jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
}));

const mockCookieGet = jest.fn();
const mockCookieSet = jest.fn();
jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => ({
    get: mockCookieGet,
    set: mockCookieSet,
  }));
});

import bcrypt from "bcryptjs";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getSudoCookie, setSudoCookie, deleteSudoCookie } from "@/utils/server/sudoCookieUtils";

const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

function buildValidGcmCookie(ip: string): string {
  const secretKey = crypto.createHash("sha256").update(process.env.SECRET_KEY!).digest();
  const token = "a".repeat(64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey, iv);
  let encrypted = cipher.update(`${token}:${ip}`, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

describe("sudoCookieUtils", () => {
  const req = {
    headers: {},
    url: "/api/test",
  } as NextApiRequest;
  const res = {} as NextApiResponse;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfigSync.mockReturnValue({ requireLogin: false } as any);
  });

  describe("getSudoCookie", () => {
    it("returns false on login-required sites", () => {
      mockLoadSiteConfigSync.mockReturnValue({ requireLogin: true } as any);

      const result = getSudoCookie(req, res);
      expect(result.sudoCookieValue).toBe(false);
      expect(result.message).toContain("login-required");
    });

    it("returns false when no cookie present", () => {
      mockCookieGet.mockReturnValue(undefined);

      const result = getSudoCookie(req, res);
      expect(result.sudoCookieValue).toBe(false);
    });

    it("returns true when cookie IP matches client IP", () => {
      const encrypted = buildValidGcmCookie("127.0.0.1");
      mockCookieGet.mockReturnValue(encrypted);

      const result = getSudoCookie(req, res);
      expect(result.sudoCookieValue).toBe(true);
    });

    it("returns false for old CBC format cookie", () => {
      mockCookieGet.mockReturnValue("deadbeef:deadbeef");

      const result = getSudoCookie(req, res);
      expect(result.sudoCookieValue).toBe(false);
      expect(result.message).toContain("Invalid token format");
    });

    it("reads cookie from request headers when res is undefined", () => {
      const encrypted = buildValidGcmCookie("127.0.0.1");
      req.headers.cookie = `blessed=${encrypted}`;

      const result = getSudoCookie(req);
      expect(result.sudoCookieValue).toBe(true);
    });
  });

  describe("setSudoCookie", () => {
    it("sets cookie when password matches", async () => {
      process.env.SUDO_PASSWORD = "hashed-password";
      jest.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

      const result = await setSudoCookie(req, res, "correct-password");
      expect(result.message).toBe("You have been blessed");
      expect(mockCookieSet).toHaveBeenCalledWith(
        "blessed",
        expect.any(String),
        expect.objectContaining({ httpOnly: true })
      );
    });

    it("throws when password is incorrect", async () => {
      process.env.SUDO_PASSWORD = "hashed-password";
      jest.mocked(bcrypt.compare).mockResolvedValueOnce(false as never);

      await expect(setSudoCookie(req, res, "wrong-password")).rejects.toThrow("Incorrect password");
    });

    it("throws when password is missing", async () => {
      delete process.env.SUDO_PASSWORD;
      await expect(setSudoCookie(req, res, "any-password")).rejects.toThrow("Bad request");
    });
  });

  describe("deleteSudoCookie", () => {
    it("clears the blessed cookie", () => {
      const result = deleteSudoCookie(req, res);
      expect(result.message).toBe("You are not blessed");
      expect(mockCookieSet).toHaveBeenCalledWith("blessed", "", expect.objectContaining({ expires: expect.any(Date) }));
    });
  });
});
