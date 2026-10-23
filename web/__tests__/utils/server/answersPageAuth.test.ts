/**
 * Tests for answers page authorization utilities
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import {
  isAnswersPageAllowed,
  shouldShowAnswersPageLink,
  getAnswersPageErrorMessage,
  canReadAnswerVisitorFields,
} from "@/utils/server/answersPageAuth";
import { SiteConfig } from "@/types/siteConfig";

// Mock dependencies
jest.mock("@/utils/server/authz", () => ({
  getRequesterRole: jest.fn(),
}));

jest.mock("@/utils/server/sudoCookieUtils", () => ({
  getSudoCookie: jest.fn(),
}));

jest.mock("@/utils/server/answersViewerAuth", () => ({
  hasValidAnswersViewerCookie: jest.fn(),
}));

const mockGetRequesterRole = jest.requireMock("@/utils/server/authz").getRequesterRole;
const mockGetSudoCookie = jest.requireMock("@/utils/server/sudoCookieUtils").getSudoCookie;
const mockHasValidAnswersViewerCookie = jest.requireMock(
  "@/utils/server/answersViewerAuth"
).hasValidAnswersViewerCookie;

describe("answersPageAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: "",
      message: "No sudo cookie",
    });
    mockGetRequesterRole.mockReturnValue("user");
    mockHasValidAnswersViewerCookie.mockReturnValue(false);
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

    it("should deny anonymous callers on no-login sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: false,
      } as SiteConfig;

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(false);
    });

    it("should allow a viewer cookie on login-required sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;
      mockHasValidAnswersViewerCookie.mockReturnValue(true);

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(true);
    });

    it("should allow a viewer cookie on no-login sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: false,
      } as SiteConfig;
      mockHasValidAnswersViewerCookie.mockReturnValue(true);

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(true);
    });

    it("should allow a sudo caller on no-login sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: false,
      } as SiteConfig;
      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "valid-sudo-cookie",
        message: "",
      });

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(true);
    });

    it("should deny anonymous callers on login-required sites", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      const siteConfig: SiteConfig = {
        requireLogin: true,
      } as SiteConfig;

      mockGetRequesterRole.mockReturnValue("user");

      const result = await isAnswersPageAllowed(req, res, siteConfig);

      expect(result).toBe(false);
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

  describe("canReadAnswerVisitorFields", () => {
    it("returns true for a sudo caller", () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "valid-sudo-cookie",
        message: "",
      });
      mockGetRequesterRole.mockReturnValue("user");

      expect(canReadAnswerVisitorFields(req, res)).toBe(true);
    });

    it("returns true for an admin caller", () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "",
        message: "No sudo cookie",
      });
      mockGetRequesterRole.mockReturnValue("admin");

      expect(canReadAnswerVisitorFields(req, res)).toBe(true);
    });

    it("returns true for a superuser caller", () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "",
        message: "No sudo cookie",
      });
      mockGetRequesterRole.mockReturnValue("superuser");

      expect(canReadAnswerVisitorFields(req, res)).toBe(true);
    });

    it("returns false for an anonymous caller", () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>();
      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "",
        message: "No sudo cookie",
      });
      mockGetRequesterRole.mockReturnValue("user");

      expect(canReadAnswerVisitorFields(req, res)).toBe(false);
    });
  });
});
