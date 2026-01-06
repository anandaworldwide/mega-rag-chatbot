/**
 * NPS Survey token utilities for generating and verifying secure tokens
 * Used for email survey links to pre-select the score clicked
 */

import jwt from "jsonwebtoken";
import { validateEmail, EmailValidationLevel } from "./emailValidation";

/**
 * Generates a signed NPS survey token for email links
 * Includes email and score for pre-selection
 *
 * @param email - User email address
 * @param score - NPS score (0-10) that was clicked
 * @returns JWT token string
 * @throws Error if SECURE_TOKEN is not configured or email is invalid
 */
export function generateNpsSurveyToken(email: string, score: number): string {
  const jwtSecret = process.env.SECURE_TOKEN;
  if (!jwtSecret) {
    throw new Error("SECURE_TOKEN not configured");
  }

  // Validate email format using centralized validation
  const emailValidation = validateEmail(email, EmailValidationLevel.STRICT);
  if (!emailValidation.isValid) {
    throw new Error(emailValidation.error || "Invalid email format");
  }
  const normalizedEmail = emailValidation.email!;

  if (score < 0 || score > 10 || !Number.isInteger(score)) {
    throw new Error("Score must be an integer between 0 and 10");
  }

  return jwt.sign(
    {
      email: normalizedEmail,
      purpose: "nps_survey",
      score: score,
    },
    jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: "90d", // 90 day expiry for survey links
    }
  );
}

/**
 * Result of verifying an NPS survey token
 */
export interface NpsSurveyTokenPayload {
  email: string;
  score: number;
  isValid: boolean;
}

/**
 * Verifies and decodes an NPS survey token
 *
 * @param token - JWT token string
 * @returns Decoded payload with validity flag, or null if invalid
 */
export function verifyNpsSurveyToken(token: string): NpsSurveyTokenPayload | null {
  try {
    const jwtSecret = process.env.SECURE_TOKEN;
    if (!jwtSecret) {
      return null;
    }

    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;

    // Validate payload structure
    if (
      decoded.purpose !== "nps_survey" ||
      typeof decoded.email !== "string" ||
      typeof decoded.score !== "number" ||
      decoded.score < 0 ||
      decoded.score > 10 ||
      !Number.isInteger(decoded.score)
    ) {
      return null;
    }

    // Re-validate email format even though it was validated during token creation
    const emailValidation = validateEmail(decoded.email, EmailValidationLevel.BASIC);
    if (!emailValidation.isValid) {
      return null;
    }

    return {
      email: emailValidation.email!,
      score: decoded.score,
      isValid: true,
    };
  } catch (_error) {
    // Token expired, invalid signature, or malformed
    return null;
  }
}
