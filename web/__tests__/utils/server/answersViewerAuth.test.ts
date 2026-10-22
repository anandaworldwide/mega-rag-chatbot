/**
 * Unit tests for the answers viewer password cookie.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";

const mockCookieGet = jest.fn();
const mockCookieSet = jest.fn();
jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => ({
    get: mockCookieGet,
    set: mockCookieSet,
  }));
});

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

import {
  ANSWERS_VIEWER_COOKIE_MAX_AGE_MS,
  ANSWERS_VIEWER_COOKIE_NAME,
  createAnswersViewerCookieValue,
  getAnswersViewerCookieSetOptions,
  hasValidAnswersViewerCookie,
  isAnswersViewerPasswordConfigured,
  isValidAnswersViewerCookieValue,
  passwordsMatchConstantTime,
  setAnswersViewerCookie,
} from "@/utils/server/answersViewerAuth";

const VIEWER_PASSWORD = "viewer-test-password-ok";

describe("answersViewerAuth", () => {
  const originalPassword = process.env.ANSWERS_VIEWER_PASSWORD;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANSWERS_VIEWER_PASSWORD = VIEWER_PASSWORD;
    mockCookieGet.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (originalPassword === undefined) {
      delete process.env.ANSWERS_VIEWER_PASSWORD;
    } else {
      process.env.ANSWERS_VIEWER_PASSWORD = originalPassword;
    }
  });

  it("treats a missing or blank env value as disabled", () => {
    delete process.env.ANSWERS_VIEWER_PASSWORD;
    expect(isAnswersViewerPasswordConfigured()).toBe(false);

    process.env.ANSWERS_VIEWER_PASSWORD = "   ";
    expect(isAnswersViewerPasswordConfigured()).toBe(false);
  });

  it("accepts a matching password with a constant-time compare", () => {
    expect(passwordsMatchConstantTime(VIEWER_PASSWORD)).toBe(true);
    expect(passwordsMatchConstantTime("wrong-password")).toBe(false);
  });

  it("invalidates an old cookie after the env password changes", () => {
    const cookieValue = createAnswersViewerCookieValue();
    expect(isValidAnswersViewerCookieValue(cookieValue)).toBe(true);

    process.env.ANSWERS_VIEWER_PASSWORD = "replacement-viewer-password";
    expect(isValidAnswersViewerCookieValue(cookieValue)).toBe(false);
  });

  it("rejects an expired cookie", () => {
    const cookieValue = createAnswersViewerCookieValue(Date.now() - ANSWERS_VIEWER_COOKIE_MAX_AGE_MS - 1000);
    expect(isValidAnswersViewerCookieValue(cookieValue)).toBe(false);
  });

  it("sets httpOnly, Secure, SameSite, and expiry on the cookie", () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: {
        "x-forwarded-proto": "https",
      },
    });

    setAnswersViewerCookie(req, res);

    expect(mockCookieSet).toHaveBeenCalledWith(
      ANSWERS_VIEWER_COOKIE_NAME,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        expires: expect.any(Date),
        maxAge: ANSWERS_VIEWER_COOKIE_MAX_AGE_MS,
      })
    );
  });

  it("exposes cookie options with httpOnly, Secure, SameSite, and expiry", () => {
    const options = getAnswersViewerCookieSetOptions(true);
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe("strict");
    expect(options.expires).toBeInstanceOf(Date);
    expect(options.maxAge).toBe(ANSWERS_VIEWER_COOKIE_MAX_AGE_MS);
  });

  it("reads a valid cookie from the request header when res is missing", () => {
    const cookieValue = createAnswersViewerCookieValue();
    const { req } = createMocks<NextApiRequest, NextApiResponse>({
      headers: {
        cookie: `${ANSWERS_VIEWER_COOKIE_NAME}=${cookieValue}`,
      },
    });

    expect(hasValidAnswersViewerCookie(req)).toBe(true);
  });
});
