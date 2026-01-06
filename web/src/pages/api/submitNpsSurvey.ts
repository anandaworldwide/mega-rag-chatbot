// This file handles API requests for submitting NPS survey responses.
// It validates the input, checks for recent submissions, and saves the data to a Google Sheet.

import type { NextApiRequest, NextApiResponse } from "next";
import { google } from "googleapis";
import crypto from "crypto";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withPagesCors } from "@/utils/server/pagesCorsUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { sanitizeTextInput } from "@/utils/server/inputSanitization";
import { createErrorResponse, ERROR_CODES } from "@/utils/server/apiErrorResponse";

/**
 * Checks if a UUID has submitted a survey in the last month
 * Returns the most recent submission timestamp if found, null otherwise
 */
async function checkRecentSubmission(uuid: string): Promise<string | null> {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || !process.env.NPS_SURVEY_GOOGLE_SHEET_ID) {
    return null;
  }

  try {
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const oneMonthAgoTimestamp = oneMonthAgo.toISOString();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.NPS_SURVEY_GOOGLE_SHEET_ID,
      range: "Responses!A:B",
    });

    const rows = response.data.values;
    if (rows) {
      // Find the most recent submission for this UUID within the last month
      const recentSubmissions = rows
        .filter((row) => row.length >= 2 && row[1] === uuid && row[0] > oneMonthAgoTimestamp)
        .map((row) => row[0])
        .sort()
        .reverse();

      return recentSubmissions.length > 0 ? recentSubmissions[0] : null;
    }

    return null;
  } catch (error) {
    console.error("Error checking recent submission:", error);
    return null;
  }
}

// Handler function for checking survey eligibility (GET) or submitting (POST)
async function handleRequest(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // Handle GET request for eligibility check (no rate limiting needed)
  if (req.method === "GET") {
    const uuid = req.query.uuid as string;

    if (!uuid || typeof uuid !== "string" || uuid.length !== 36) {
      res.status(400).json(createErrorResponse("Invalid UUID", ERROR_CODES.VALIDATION_ERROR));
      return;
    }

    const recentSubmission = await checkRecentSubmission(uuid);
    const canSubmit = recentSubmission === null;

    res.status(200).json({
      canSubmit,
      lastSubmissionDate: recentSubmission || null,
      message: canSubmit ? "You can submit a survey" : "You have already submitted a survey recently",
    });
    return;
  }

  // Handle POST request for submission (with rate limiting)
  if (req.method !== "POST") {
    res.status(405).json(createErrorResponse("Method Not Allowed", ERROR_CODES.VALIDATION_ERROR));
    return;
  }

  // Apply rate limiting only to POST requests
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // 10 requests per 5 minutes
    name: "nps-survey-api",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  const { uuid, score, feedback, additionalComments, timestamp } = req.body;

  // Basic validation
  if (!uuid || typeof uuid !== "string" || uuid.length !== 36) {
    res.status(400).json(createErrorResponse("Invalid UUID", ERROR_CODES.VALIDATION_ERROR));
    return;
  }

  // Validate score type and range (prevent type coercion bypass)
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10) {
    res
      .status(400)
      .json(createErrorResponse("Score must be an integer between 0 and 10", ERROR_CODES.VALIDATION_ERROR));
    return;
  }

  if (feedback && (typeof feedback !== "string" || feedback.length > 1000)) {
    res.status(400).json(createErrorResponse("Feedback must be 1000 characters or less", ERROR_CODES.VALIDATION_ERROR));
    return;
  }

  if (additionalComments && (typeof additionalComments !== "string" || additionalComments.length > 1000)) {
    res
      .status(400)
      .json(createErrorResponse("Additional comments must be 1000 characters or less", ERROR_CODES.VALIDATION_ERROR));
    return;
  }

  // Sanitize input before writing to Google Sheets to prevent injection
  let sanitizedFeedback = "";
  let sanitizedAdditionalComments = "";
  try {
    if (feedback) {
      sanitizedFeedback = sanitizeTextInput(feedback, {
        maxLength: 1000,
        allowNewlines: true,
        allowSpecialChars: true, // Allow quotes, apostrophes for user feedback
      });
    }
    if (additionalComments) {
      sanitizedAdditionalComments = sanitizeTextInput(additionalComments, {
        maxLength: 1000,
        allowNewlines: true,
        allowSpecialChars: true, // Allow quotes, apostrophes for user feedback
      });
    }
  } catch (sanitizeError: any) {
    res
      .status(400)
      .json(
        createErrorResponse(
          `Invalid input: ${sanitizeError.message || "Input contains invalid characters"}`,
          ERROR_CODES.VALIDATION_ERROR
        )
      );
    return;
  }

  if (!timestamp || isNaN(Date.parse(timestamp))) {
    res.status(400).json(createErrorResponse("Invalid timestamp", ERROR_CODES.VALIDATION_ERROR));
    return;
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("Missing Google credentials");
    res.status(500).json(createErrorResponse("Missing Google credentials", ERROR_CODES.CONFIGURATION_ERROR));
    return;
  }

  if (!process.env.NPS_SURVEY_GOOGLE_SHEET_ID) {
    console.error("Missing Google Sheet ID");
    res.status(500).json(createErrorResponse("Missing Google Sheet ID", ERROR_CODES.CONFIGURATION_ERROR));
    return;
  }

  try {
    // Parse credentials with error handling
    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    } catch (parseError) {
      console.error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS:", parseError);
      res.status(500).json(createErrorResponse("Invalid Google credentials format", ERROR_CODES.CONFIGURATION_ERROR));
      return;
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // Check if UUID has submitted in the last month
    const recentSubmission = await checkRecentSubmission(uuid);

    if (recentSubmission) {
      res
        .status(429)
        .json(createErrorResponse("You can only submit one survey per month", ERROR_CODES.RATE_LIMIT_EXCEEDED));
      return;
    }

    // Generate idempotency key to prevent duplicate submissions
    // Use UUID + timestamp (rounded to minute) + score as idempotency key
    const timestampMinute = new Date(timestamp).toISOString().substring(0, 16); // Round to minute
    const idempotencyKey = `${uuid}:${timestampMinute}:${score}`;
    const idempotencyHash = crypto.createHash("sha256").update(idempotencyKey).digest("hex").substring(0, 16);

    // Check for duplicate submission using idempotency key
    // Check all rows for matching UUID and timestamp within same minute
    const allRows = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.NPS_SURVEY_GOOGLE_SHEET_ID,
      range: "Responses!A:B", // Check timestamp and UUID columns
    });

    const existingRows = allRows.data.values || [];
    const duplicateCheck = existingRows.find((row) => {
      if (row.length < 2) return false;
      const rowTimestamp = row[0];
      const rowUuid = row[1];
      // Skip invalid timestamps (e.g., header row "Timestamp")
      const parsedDate = new Date(rowTimestamp);
      if (isNaN(parsedDate.getTime())) return false;
      const rowTimestampMinute = parsedDate.toISOString().substring(0, 16);
      return rowUuid === uuid && rowTimestampMinute === timestampMinute;
    });

    if (duplicateCheck) {
      res.status(409).json(createErrorResponse("Duplicate submission detected", ERROR_CODES.VALIDATION_ERROR));
      return;
    }

    // If no recent submission, proceed with adding the new entry
    // Use sanitized values to prevent injection attacks
    // Add idempotency hash as 6th column for future duplicate detection
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.NPS_SURVEY_GOOGLE_SHEET_ID,
      range: "Responses",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[timestamp, uuid, score, sanitizedFeedback, sanitizedAdditionalComments, idempotencyHash]],
      },
    });

    res.status(200).json({ message: "Survey submitted successfully" });
  } catch (error: any) {
    console.error("Error submitting NPS survey:", error);
    res
      .status(500)
      .json(
        createErrorResponse(`Error submitting survey: ${error.message || "Unknown error"}`, ERROR_CODES.INTERNAL_ERROR)
      );
  }
}

// Export wrapped with CORS, then Auth, then Middleware
export default withApiMiddleware(withPagesCors(withJwtAuth(handleRequest)));
