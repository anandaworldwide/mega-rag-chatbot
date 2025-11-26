import crypto from "crypto";
import bcrypt from "bcryptjs";
import Cookies from "cookies";
import { NextApiRequest, NextApiResponse } from "next";
import { isDevelopment } from "@/utils/env";
import validator from "validator";
import { getClientIp } from "./ipUtils";
import { loadSiteConfigSync } from "./loadSiteConfig";

if (!process.env.SECRET_KEY) {
  throw new Error(
    "SECRET_KEY environment variable is required. Application cannot start without proper encryption key."
  );
}

const secretKey = crypto.createHash("sha256").update(process.env.SECRET_KEY).digest();

/**
 * Encrypts text using AES-256-GCM (authenticated encryption)
 * Format: iv:encrypted:tag (all hex encoded)
 * @param text - Plaintext to encrypt
 * @returns Encrypted string in format "iv:encrypted:tag"
 */
function encrypt(text: string): string {
  // GCM requires 12-byte IV (nonce) instead of 16-byte for CBC
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey, iv);

  let encrypted = cipher.update(text, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  // Get authentication tag (16 bytes by default)
  const tag = cipher.getAuthTag();

  // Format: iv:encrypted:tag (all hex encoded)
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

/**
 * Decrypts text using AES-256-GCM (authenticated encryption)
 * Format: iv:encrypted:tag (all hex encoded)
 * @param text - Encrypted string in format "iv:encrypted:tag"
 * @returns Decrypted plaintext
 * @throws Error if decryption fails or authentication tag is invalid
 */
function decrypt(text: string): string {
  try {
    const textParts = text.split(":");

    // Reject old CBC format (2 parts) - only accept new GCM format (3 parts)
    if (textParts.length !== 3) {
      throw new Error("Invalid token format: Expected GCM format (iv:encrypted:tag)");
    }

    const iv = Buffer.from(textParts[0]!, "hex");
    const encryptedText = Buffer.from(textParts[1]!, "hex");
    const tag = Buffer.from(textParts[2]!, "hex");

    // Validate IV length (GCM requires 12 bytes)
    if (iv.length !== 12) {
      throw new Error("Invalid IV length: Expected 12 bytes for GCM");
    }

    // Validate tag length (GCM default is 16 bytes)
    if (tag.length !== 16) {
      throw new Error("Invalid authentication tag length: Expected 16 bytes");
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString("utf8");
  } catch (error) {
    console.error("Decryption error:", error);
    throw new Error("Decryption failed: Invalid or tampered cookie");
  }
}

async function setSudoCookie(req: NextApiRequest, res: NextApiResponse, password: string) {
  const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
  const cookies = new Cookies(req, res, { secure: isSecure });
  const sudoCookieName = "blessed";
  const userIp = getClientIp(req);
  const storedHashedPassword = process.env.SUDO_PASSWORD;

  if (!password || !storedHashedPassword) {
    throw new Error("Bad request");
  }

  // Validate password
  if (!validator.isLength(password, { min: 8, max: 100 })) {
    throw new Error("Invalid password");
  }

  const match = await bcrypt.compare(password, storedHashedPassword);

  if (match) {
    const token = crypto.randomBytes(64).toString("hex");
    const encryptedToken = encrypt(`${token}:${userIp}`);
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // Set expiry to 1 year from now
    cookies.set(sudoCookieName, encryptedToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "strict",
      expires: expiryDate,
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year in milliseconds
    });
    return { message: "You have been blessed" };
  } else {
    throw new Error("Incorrect password");
  }
}

function getSudoCookie(req: NextApiRequest, res?: NextApiResponse) {
  // Log telemetry when sudo checks are used on login-required sites
  // Note: This function is still called from server-side code that may not have checked requireLogin
  // So we log but don't fail - the calling code should handle the check
  try {
    const siteConfig = loadSiteConfigSync();
    if (siteConfig?.requireLogin) {
      console.warn(`[TELEMETRY] Sudo check on login-required site: ${req.url} - should use role-based auth instead`);
      // Return false for login-required sites - sudo cookie should not be used
      return { sudoCookieValue: false, message: "Sudo cookie not available on login-required sites" };
    }
  } catch (error) {
    // Don't fail the function if site config loading fails
    console.error("Failed to load site config for telemetry:", error);
  }

  const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();

  // For server-side rendering (SSR) context where we don't have access to Response object
  if (!res) {
    const cookies = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("blessed="));

    const encryptedToken = cookies?.split("=")[1];
    return validateSudoCookie(encryptedToken, getClientIp(req));
  }

  // For API context, use Cookies library
  const cookies = new Cookies(req, res, { secure: isSecure });
  const encryptedToken = cookies.get("blessed");
  return validateSudoCookie(encryptedToken, getClientIp(req));
}

// Helper function to validate the sudo cookie
function validateSudoCookie(encryptedToken: string | undefined, userIp: string): SudoStatus {
  if (!encryptedToken) {
    return { sudoCookieValue: false, message: "" };
  }

  try {
    // Reject old CBC format (2 parts) - only accept new GCM format (3 parts)
    const textParts = encryptedToken.split(":");
    if (textParts.length !== 3) {
      console.error("Invalid token format: Old CBC format detected, cookie invalidated");
      return { sudoCookieValue: false, message: "Invalid token format: Please re-authenticate" };
    }

    // Decrypt with GCM (includes authentication tag verification)
    const decryptedToken = decrypt(encryptedToken);
    const tokenIndex = decryptedToken.indexOf(":");
    const ip = decryptedToken.slice(tokenIndex + 1);

    if (ip === userIp) {
      return { sudoCookieValue: true };
    }

    console.warn(`GetSudoCookie: IP mismatch: Cookie IP "${ip}" does not match User IP "${userIp}"`);
    return {
      sudoCookieValue: false,
      message: "IP mismatch: Extracted IP does not match User IP",
      ipMismatch: true,
    };
  } catch (error) {
    // GCM decryption will throw if authentication tag is invalid (tampering detected)
    console.error("Token validation error:", error);
    const errorMessage = error instanceof Error ? error.message : "Token validation error";
    return { sudoCookieValue: false, message: errorMessage };
  }
}

interface SudoStatus {
  sudoCookieValue: boolean;
  message?: string;
  ipMismatch?: boolean;
}

function deleteSudoCookie(req: NextApiRequest, res: NextApiResponse) {
  const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
  const cookies = new Cookies(req, res, { secure: isSecure });
  const sudoCookieName = "blessed";
  cookies.set(sudoCookieName, "", { expires: new Date(0) });
  return { message: "You are not blessed" };
}

export { setSudoCookie, getSudoCookie, deleteSudoCookie, getClientIp };
