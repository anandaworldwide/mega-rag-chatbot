import crypto from "crypto";
import Cookies from "cookies";
import { NextApiRequest, NextApiResponse } from "next";
import { isDevelopment } from "@/utils/env";

export const ANSWERS_VIEWER_COOKIE_NAME = "answersViewer";
export const ANSWERS_VIEWER_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getViewerPassword(): string | null {
  const password = process.env.ANSWERS_VIEWER_PASSWORD;
  if (typeof password !== "string") {
    return null;
  }

  const trimmed = password.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isAnswersViewerPasswordConfigured(): boolean {
  return getViewerPassword() !== null;
}

function getSigningKey(password: string): Buffer {
  const secret = process.env.SECRET_KEY;
  if (!secret) {
    throw new Error("SECRET_KEY environment variable is required.");
  }

  return crypto.createHmac("sha256", secret).update(password).digest();
}

function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signPayload(payload: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function readCookieFromHeader(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!raw) {
    return undefined;
  }

  const value = raw.slice(name.length + 1);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createAnswersViewerCookieValue(nowMs = Date.now()): string {
  const password = getViewerPassword();
  if (!password) {
    throw new Error("Viewer password is not configured");
  }

  const payload = Buffer.from(
    JSON.stringify({ exp: nowMs + ANSWERS_VIEWER_COOKIE_MAX_AGE_MS }),
    "utf8"
  ).toString("base64url");
  const signature = signPayload(payload, getSigningKey(password));
  return `${payload}.${signature}`;
}

export function isValidAnswersViewerCookieValue(cookieValue: string | undefined): boolean {
  if (!cookieValue) {
    return false;
  }

  const password = getViewerPassword();
  if (!password) {
    return false;
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [payload, signature] = parts;
  if (!payload || !signature) {
    return false;
  }

  const expectedSignature = signPayload(payload, getSigningKey(password));
  if (!timingSafeEqualStrings(signature, expectedSignature)) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

export function hasValidAnswersViewerCookie(req: NextApiRequest, res?: NextApiResponse): boolean {
  if (!isAnswersViewerPasswordConfigured()) {
    return false;
  }

  if (!res) {
    return isValidAnswersViewerCookieValue(
      readCookieFromHeader(req.headers.cookie, ANSWERS_VIEWER_COOKIE_NAME)
    );
  }

  const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
  const cookies = new Cookies(req, res, { secure: isSecure });
  return isValidAnswersViewerCookieValue(cookies.get(ANSWERS_VIEWER_COOKIE_NAME));
}

export function passwordsMatchConstantTime(provided: string): boolean {
  const configured = getViewerPassword();
  if (!configured) {
    return false;
  }

  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const configuredHash = crypto.createHash("sha256").update(configured).digest();
  return crypto.timingSafeEqual(providedHash, configuredHash);
}

export function getAnswersViewerCookieSetOptions(isSecure: boolean): {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  expires: Date;
  maxAge: number;
  path: string;
} {
  const expiryDate = new Date(Date.now() + ANSWERS_VIEWER_COOKIE_MAX_AGE_MS);
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "strict",
    expires: expiryDate,
    maxAge: ANSWERS_VIEWER_COOKIE_MAX_AGE_MS,
    path: "/",
  };
}

export function setAnswersViewerCookie(req: NextApiRequest, res: NextApiResponse): void {
  const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
  const cookies = new Cookies(req, res, { secure: isSecure });
  cookies.set(
    ANSWERS_VIEWER_COOKIE_NAME,
    createAnswersViewerCookieValue(),
    getAnswersViewerCookieSetOptions(isSecure)
  );
}
