/**
 * Tests for answers page authorization utilities
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import {
  isAnswersPageAllowed,
  shouldShowAnswersPageLink,
  getAnswersPageErrorMessage,
} from "@/utils/server/answersPageAuth";
import { SiteConfig } from "@/types/siteConfig";

// Mock dependencies
jest.mock("@/utils/server/authz", () => ({
  getRequesterRole: jest.fn(),
}));

jest.mock("@/utils/server/sudoCookieUtils", () => ({
  getSudoCookie: jest.fn(),
}));

const mockGetRequesterRole = jest.requireMock("@/utils/server/authz").getRequesterRole;
const mockGetSudoCookie = jest.requireMock("@/utils/server/sudoCookieUtils").getSudoCookie;

describe("answersPageAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("isAnswersPageAllowed", () => {
    it("should return false when siteConfig is null", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();

      const result = await isAnswersPageAllowed(req, res, null);

      expect(result).toBe(false);
    });

    it("should allow superusers on login-required sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;

      mockGetRequesterRole.mockReturnValue("superuser");

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(true);
      expect(mockGetRequesterRole).toHaveBeenCalledWith(req);
    });

    it("should deny regular users on login-required sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;

      mockGetRequesterRole.mockReturnValue("user");

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(false);
    });

    it("should allow admins on login-required sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;

      mockGetRequesterRole.mockReturnValue("admin");

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(true);
      expect(mockGetRequesterRole).toHaveBeenCalledWith(req);
    });

    it("should allow anyone on no-login sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: false,
      } as SiteConfig;

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(true);
    });
  });

  describe("shouldShowAnswersPageLink", () => {
    it("should return false when siteConfig is null", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();

      const result = await shouldShowAnswersPageLink(req, res, null);

      expect(result).toBe(false);
    });

    it("should show link for superusers on login-required sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;

      mockGetRequesterRole.mockReturnValue("superuser");

      const result = await shouldShowAnswersPageLink(req, res, siteConfig);

      expect(result).toBe(true);
      expect(mockGetRequesterRole).toHaveBeenCalledWith(req);
    });

    it("should hide link for regular users on login-required sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;

      mockGetRequesterRole.mockReturnValue("user");

      const result = await shouldShowAnswersPageLink(req, res, siteConfig);

      expect(result).toBe(false);
    });

    it("should show link for sudo users on no-login sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: false,
      } as SiteConfig;

      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "valid-sudo-cookie",
        message: "",
      });

      const result = await shouldShowAnswersPageLink(req, res, siteConfig);

      expect(result).toBe(true);
      expect(mockGetSudoCookie).toHaveBeenCalledWith(req, res);
    });

    it("should hide link for non-sudo users on no-login sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: false,
      } as SiteConfig;

      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "",
        message: "No sudo cookie",
      });

      const result = await shouldShowAnswersPageLink(req, res, siteConfig);

      expect(result).toBe(false);
    });
  });

  describe("getAnswersPageErrorMessage", () => {
    it("should return generic error when siteConfig is null", () => {
      const result = getAnswersPageErrorMessage(null);

      expect(result).toBe("Access Restricted");
    });

    it("should return admin error for login-required sites", () => {
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;

      const result = getAnswersPageErrorMessage(siteConfig);

      expect(result).toBe("Access Restricted - Admin Only");
    });

    it("should return admin error for no-login sites", () => {
      const siteConfig: SiteConfig = {
        requireLogin: false,
      } as SiteConfig;

      const result = getAnswersPageErrorMessage(siteConfig);

      expect(result).toBe("Access Restricted - Admin Only");
    });
  });
});
