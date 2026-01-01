/**
 * Onboarding email utilities for rendering and sending drip sequence emails
 */

import * as fs from "fs";
import * as path from "path";
import { sendEmail } from "./emailUtils";
import { generateEmailContent } from "./emailTemplates";
import { loadSiteConfig } from "./loadSiteConfig";
import { User } from "@/types/user";
import { addUtmParams, generateClickTrackingUrl, generateOpenTrackingUrl } from "./emailTrackingUtils";
import { generateUnsubscribeToken } from "./emailTokenUtils";

export interface OnboardingTemplate {
  day: number;
  subject: string;
  greeting: string;
  body: string;
  exampleQuestions: string[]; // Can be full pool or selected questions
  exampleQuestionPool?: string[]; // Optional: larger pool to randomly select from
  exampleQuestionCount?: number; // Optional: how many to select (default: 4)
  ctaUrl?: string;
  ctaText?: string;
}

// Cache for valid site IDs to avoid repeated file system reads
let validSiteIdsCache: Set<string> | null = null;
let validSiteIdsCacheTime: number = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

/**
 * Dynamically discovers site IDs that have onboarding templates by reading the directory
 * Uses caching to avoid repeated file system reads
 */
async function getValidSiteIds(): Promise<Set<string>> {
  const now = Date.now();
  if (validSiteIdsCache && now - validSiteIdsCacheTime < CACHE_TTL_MS) {
    return validSiteIdsCache;
  }

  const templatesDir = path.join(process.cwd(), "site-config", "onboarding-templates");
  const siteIds = new Set<string>();

  try {
    // Use async file operations
    const exists = await fs.promises
      .access(templatesDir)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const entries = await fs.promises.readdir(templatesDir, { withFileTypes: true });
      for (const entry of entries) {
        // Only include directories with safe names (alphanumeric + hyphen)
        if (entry.isDirectory() && /^[a-zA-Z0-9-]+$/.test(entry.name)) {
          siteIds.add(entry.name);
        }
      }
    }
  } catch (error) {
    console.error("Error reading onboarding templates directory:", error);
  }

  validSiteIdsCache = siteIds;
  validSiteIdsCacheTime = now;
  return siteIds;
}

/**
 * Validates a site ID to prevent path traversal attacks
 * Checks against dynamically discovered sites that have onboarding templates
 */
async function isValidSiteId(siteId: string): Promise<boolean> {
  // First check: strict pattern match (alphanumeric + hyphen only)
  if (!/^[a-zA-Z0-9-]+$/.test(siteId)) {
    return false;
  }

  // Second check: must have onboarding templates directory
  const validSiteIds = await getValidSiteIds();
  return validSiteIds.has(siteId);
}

/**
 * Loads an onboarding email template for a specific day and site
 * Uses async file operations to avoid blocking the event loop
 *
 * @param day - Day number (0, 3, 7, or 14)
 * @param siteId - Site ID (e.g., "ananda")
 * @returns Template object or null if not found
 */
export async function loadOnboardingTemplate(day: number, siteId: string): Promise<OnboardingTemplate | null> {
  try {
    // Validate siteId to prevent path traversal
    if (!(await isValidSiteId(siteId))) {
      console.error(`Invalid siteId: ${siteId}`);
      return null;
    }

    // Load site-specific template only using async file operations
    const templatePath = path.join(process.cwd(), "site-config", "onboarding-templates", siteId, `day${day}.json`);

    const exists = await fs.promises
      .access(templatePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const templateContent = await fs.promises.readFile(templatePath, "utf-8");
      try {
        return JSON.parse(templateContent) as OnboardingTemplate;
      } catch (parseError) {
        console.error(`Error parsing onboarding template JSON for day ${day}, site ${siteId}:`, parseError);
        return null;
      }
    }

    // No template found for this site
    return null;
  } catch (error) {
    console.error(`Error loading onboarding template for day ${day}, site ${siteId}:`, error);
    return null;
  }
}

/**
 * Renders template variables in a string
 *
 * @param template - Template string with {{variable}} placeholders
 * @param variables - Object with variable values
 * @returns Rendered string
 */
function renderTemplate(template: string, variables: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    rendered = rendered.replace(placeholder, value);
  }
  return rendered;
}

/**
 * Randomly selects a subset of example questions from a larger pool
 *
 * @param allQuestions - Full array of available questions
 * @param count - Number of questions to select (default: 4)
 * @returns Array of randomly selected questions
 */
export function selectRandomExampleQuestions(allQuestions: string[], count: number = 4): string[] {
  // Create a copy to avoid mutating the original array
  const shuffled = [...allQuestions];

  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Return the first 'count' questions
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Formats example questions as a bulleted list with clickable links
 *
 * @param questions - Array of question strings
 * @param baseUrl - Base URL for creating question links
 * @param email - User email address for tracking
 * @param day - Onboarding day number for campaign tracking
 * @returns Formatted HTML and text versions
 */
function formatExampleQuestions(
  questions: string[],
  baseUrl: string,
  email: string,
  day: number
): { html: string; text: string } {
  const campaign = `onboarding-day${day}`;

  const html = questions
    .map((q, index) => {
      const encodedQuestion = encodeURIComponent(q);
      // Create target URL with UTM params
      const targetUrl = addUtmParams(
        `${baseUrl}?q=${encodedQuestion}&submit=true`,
        campaign,
        "email",
        "email",
        `question-${index + 1}`
      );

      // Generate tracking URL that logs click before redirecting
      const trackingUrl = generateClickTrackingUrl(targetUrl, email, "onboarding", day, "question", q, baseUrl);

      return `• <a href="${trackingUrl}" style="color: #3498db; text-decoration: none;">${q}</a>`;
    })
    .join("<br>");
  const text = questions.map((q) => `• ${q}`).join("\n");
  return { html, text };
}

// generateUnsubscribeToken is now imported from emailTokenUtils.ts

/**
 * Renders an onboarding email template with user data
 *
 * @param template - Template object
 * @param user - User object with firstName, email, etc.
 * @param siteId - Site ID for configuration
 * @param baseUrl - Base URL for links
 * @returns Rendered email content
 */
export async function renderOnboardingEmail(
  template: OnboardingTemplate,
  user: User,
  siteId: string,
  baseUrl: string
): Promise<{ subject: string; html: string; text: string }> {
  const siteConfig = await loadSiteConfig(siteId);
  const siteName = siteConfig?.name || siteConfig?.shortname || "our service";
  const firstName = user.firstName || "there";

  // Get user email for tracking
  const userEmail = user.id || "";
  if (!userEmail) {
    throw new Error("User email not found");
  }

  // Select example questions (randomize from pool if available, otherwise use static list)
  const selectedQuestions = template.exampleQuestionPool
    ? selectRandomExampleQuestions(template.exampleQuestionPool, template.exampleQuestionCount)
    : template.exampleQuestions;

  // Format example questions with clickable links and tracking
  const exampleQuestionsFormatted = formatExampleQuestions(selectedQuestions, baseUrl, userEmail, template.day);

  // Prepare template variables - use HTML version for body, text version for text email
  const variablesHtml: Record<string, string> = {
    siteName,
    firstName,
    baseUrl,
    exampleQuestions: exampleQuestionsFormatted.html,
  };
  const variablesText: Record<string, string> = {
    siteName,
    firstName,
    baseUrl,
    exampleQuestions: exampleQuestionsFormatted.text,
  };

  // Render subject and body (HTML and text versions)
  const subject = renderTemplate(template.subject, variablesText);
  const bodyHtml = renderTemplate(template.body, variablesHtml);
  const bodyText = renderTemplate(template.body, variablesText);

  // Generate unsubscribe URL with tracking
  const unsubscribeToken = generateUnsubscribeToken(userEmail, "onboarding");
  const unsubscribeTargetUrl = `${baseUrl}/api/unsubscribe?token=${unsubscribeToken}`;
  const unsubscribeUrl = generateClickTrackingUrl(
    unsubscribeTargetUrl,
    userEmail,
    "onboarding",
    template.day,
    "unsubscribe",
    "onboarding",
    baseUrl
  );

  // Generate CTA URL with tracking if present
  let finalCtaUrl: string | undefined = undefined;
  if (template.ctaUrl) {
    const renderedCtaUrl = renderTemplate(template.ctaUrl, variablesHtml);
    const ctaWithUtm = addUtmParams(renderedCtaUrl, `onboarding-day${template.day}`, "email", "email", "cta-button");
    finalCtaUrl = generateClickTrackingUrl(
      ctaWithUtm,
      userEmail,
      "onboarding",
      template.day,
      "cta",
      template.ctaText,
      baseUrl
    );
  }

  // Generate email open tracking pixel URL
  const openTrackingUrl = generateOpenTrackingUrl(userEmail, "onboarding", template.day, baseUrl);

  // Use the existing email template system
  // For HTML version, use bodyHtml; for text version, we'll need to replace the HTML links
  const emailContentHtml = generateEmailContent({
    siteId,
    baseUrl,
    greeting: renderTemplate(template.greeting, variablesHtml),
    message: bodyHtml,
    actionUrl: finalCtaUrl,
    actionText: template.ctaText,
    unsubscribeUrl,
  });

  // Add tracking pixel to HTML (insert before closing </body> tag)
  const htmlWithTracking = emailContentHtml.html.replace(
    "</body>",
    `<img src="${openTrackingUrl}" width="1" height="1" style="display:none;" alt="" />\n</body>`
  );

  // Generate text version separately with plain text body
  // For text version, use the original CTA URL (no tracking needed for plain text)
  const textCtaUrl = template.ctaUrl ? renderTemplate(template.ctaUrl, variablesText) : undefined;
  const emailContentText = generateEmailContent({
    siteId,
    baseUrl,
    greeting: renderTemplate(template.greeting, variablesText),
    message: bodyText,
    actionUrl: textCtaUrl,
    actionText: template.ctaText,
    unsubscribeUrl: unsubscribeTargetUrl, // Use original URL for text version
  });

  return {
    subject,
    html: htmlWithTracking,
    text: emailContentText.text,
  };
}

/**
 * Sends an onboarding email to a user
 *
 * @param user - User object
 * @param day - Day number (1, 3, 7, or 14)
 * @param siteId - Site ID
 * @param baseUrl - Base URL for links
 * @returns True if email was sent successfully
 */
export async function sendOnboardingEmail(user: User, day: number, siteId: string, baseUrl: string): Promise<boolean> {
  try {
    // Load template
    const template = await loadOnboardingTemplate(day, siteId);
    if (!template) {
      console.error(`No template found for day ${day}, site ${siteId}`);
      return false;
    }

    // Render email
    const emailContent = await renderOnboardingEmail(template, user, siteId, baseUrl);

    // Get user email (it's the document ID stored in user.id)
    const userEmail = user.id;
    if (!userEmail || typeof userEmail !== "string") {
      console.error("User email not found or invalid");
      return false;
    }

    // Send email
    const success = await sendEmail({
      to: userEmail,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (success) {
      console.log(`✅ Sent onboarding email (day ${day}) to ${userEmail}`);
    } else {
      console.error(`❌ Failed to send onboarding email (day ${day}) to ${userEmail}`);
    }

    return success;
  } catch (error) {
    console.error(`Error sending onboarding email to user ${user.id}:`, error);
    return false;
  }
}
