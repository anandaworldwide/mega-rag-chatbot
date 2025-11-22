// This file handles API requests for the contact form.
// It validates inputs, rate limits submissions, and sends emails via AWS SES.

import { NextApiRequest, NextApiResponse } from "next";
import { withJwtOnlyAuth } from "@/utils/server/apiMiddleware";
import { runMiddleware } from "@/utils/server/corsMiddleware";
import Cors from "cors";
import validator from "validator";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { sanitizeEmail, sanitizeTextInput } from "@/utils/server/inputSanitization";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Configure CORS for contact form
const contactCors = Cors({
  methods: ["POST", "OPTIONS"],
  origin: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000", // Only allow our frontend domain
  credentials: true, // Required for Authorization header
  allowedHeaders: ["Authorization", "Content-Type"], // Explicitly allow Authorization header
});

/**
 * Contact form API endpoint that requires JWT authentication for frontend-to-backend security.
 * Unlike most endpoints, this does NOT require the siteAuth cookie (user login).
 *
 * Authentication Flow:
 * 1. JWT token is REQUIRED - This ensures only our frontend can submit contact forms
 * 2. siteAuth cookie is NOT required - This allows non-logged-in users to contact us
 * 3. CORS is configured to only allow requests from our frontend domain
 */
const handleRequest = async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
  // Apply CORS middleware first
  await runMiddleware(req, res, contactCors);

  // Handle preflight OPTIONS request for CORS
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 3, // 3 requests per 15 minutes
    name: "contact_form",
  });

  if (!isAllowed) {
    return; // Rate limiter already sent the response
  }

  try {
    const { name, email, message } = req.body;

    // Input validation with comprehensive security checks
    if (typeof name !== "string" || !validator.isLength(name, { min: 1, max: 100 })) {
      return res.status(400).json({ message: "Invalid name" });
    }
    if (typeof email !== "string") {
      return res.status(400).json({ message: "Invalid email" });
    }
    if (typeof message !== "string" || !validator.isLength(message, { min: 1, max: 1000 })) {
      return res.status(400).json({ message: "Invalid message length" });
    }

    // Sanitize email with comprehensive validation (UTF-8, length, header injection prevention)
    let sanitizedEmail: string;
    try {
      sanitizedEmail = sanitizeEmail(email, 254);
    } catch (error: any) {
      return res.status(400).json({ message: `Invalid email: ${error.message || "Email validation failed"}` });
    }

    // Sanitize name and message with XSS/injection prevention
    let sanitizedName: string;
    let sanitizedMessage: string;
    try {
      sanitizedName = sanitizeTextInput(name, { maxLength: 100, allowNewlines: false, allowSpecialChars: false });
      sanitizedMessage = sanitizeTextInput(message, { maxLength: 1000, allowNewlines: true, allowSpecialChars: false });
    } catch (error: any) {
      return res.status(400).json({ message: `Invalid input: ${error.message || "Input validation failed"}` });
    }

    const sourceEmail = process.env.CONTACT_EMAIL;
    if (!sourceEmail) {
      return res.status(500).json({ message: "CONTACT_EMAIL environment variable is not set" });
    }

    const siteConfig = loadSiteConfigSync();
    if (!siteConfig) {
      return res.status(500).json({ message: "Failed to load site configuration" });
    }

    // Check if this is feedback mode from query parameters
    const isFeedbackMode = req.query?.mode === "feedback";
    const subjectPrefix = isFeedbackMode ? "Feedback" : "Contact Form Msg";

    const params = {
      Source: sourceEmail,
      Destination: {
        ToAddresses: [sourceEmail],
        CcAddresses: [sanitizedEmail],
      },
      Message: {
        Subject: {
          Data: `${siteConfig.shortname} ${subjectPrefix} from ${sanitizedName}`,
        },
        Body: {
          Text: {
            Data: `Type: ${isFeedbackMode ? "Feedback" : "Contact"}\nFrom: ${sanitizedName} <${sanitizedEmail}>\n\nMessage:\n\n${sanitizedMessage}`,
          },
        },
      },
    };

    await ses.send(new SendEmailCommand(params));
    res.status(200).json({ message: "Message sent successfully" });
  } catch (error) {
    console.error("Error processing contact form:", error);
    res.status(500).json({ error: "Failed to process contact form" });
  }
};

// Apply JWT-only authentication middleware
export default withJwtOnlyAuth(handleRequest);
