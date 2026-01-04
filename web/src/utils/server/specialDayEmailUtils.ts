/**
 * Special day email utilities for rendering and sending holy day emails
 */

import * as fs from "fs";
import * as path from "path";
import { sendEmail } from "./emailUtils";
import { generateEmailContent } from "./emailTemplates";
import { loadSiteConfig } from "./loadSiteConfig";
import { User } from "@/types/user";
import { addUtmParams, generateClickTrackingUrl, generateOpenTrackingUrl } from "./emailTrackingUtils";
import { generateUnsubscribeToken } from "./emailTokenUtils";
import { selectRandomExampleQuestions } from "./onboardingEmailUtils";
import { generateCampaignId } from "@/config/specialDays";

export interface SpecialDayTemplate {
  specialDayId: string;
  subject: string;
  greeting: string;
  body: string;
  exampleQuestionPool: string[]; // Pool of ~20 questions to randomly select from
  exampleQuestionCount: number; // Number to select (default: 3)
  ctaUrl?: string;
  ctaText?: string;
}

// Cache for valid site IDs to avoid repeated file system reads
let validSiteIdsCache: Set<string> | null = null;
let validSiteIdsCacheTime: number = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

/**
 * Dynamically discovers site IDs that have special day templates by reading the directory
 * Uses caching to avoid repeated file system reads
 */
async function getValidSiteIds(): Promise<Set<string>> {
  const now = Date.now();
  if (validSiteIdsCache && now - validSiteIdsCacheTime < CACHE_TTL_MS) {
    return validSiteIdsCache;
  }

  const templatesDir = path.join(process.cwd(), "site-config", "specialday-templates");
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
    console.error("Error reading special day templates directory:", error);
  }

  validSiteIdsCache = siteIds;
  validSiteIdsCacheTime = now;
  return siteIds;
}

/**
 * Validates a site ID to prevent path traversal attacks
 * Checks against dynamically discovered sites that have special day templates
 */
async function isValidSiteId(siteId: string): Promise<boolean> {
  // First check: strict pattern match (alphanumeric + hyphen only)
  if (!/^[a-zA-Z0-9-]+$/.test(siteId)) {
    return false;
  }

  // Second check: must have special day templates directory
  const validSiteIds = await getValidSiteIds();
  return validSiteIds.has(siteId);
}

/**
 * Loads a special day email template for a specific special day and site
 * Uses async file operations to avoid blocking the event loop
 *
 * @param specialDay - Special day ID (e.g., "masters-birthday")
 * @param siteId - Site ID (e.g., "ananda")
 * @returns Template object or null if not found
 */
export async function loadSpecialDayTemplate(specialDay: string, siteId: string): Promise<SpecialDayTemplate | null> {
  try {
    // Validate siteId to prevent path traversal
    if (!(await isValidSiteId(siteId))) {
      console.error(`Invalid siteId: ${siteId}`);
      return null;
    }

    // Validate specialDay to prevent path traversal
    if (!/^[a-zA-Z0-9-]+$/.test(specialDay)) {
      console.error(`Invalid specialDay: ${specialDay}`);
      return null;
    }

    // Load site-specific template only using async file operations
    const templatePath = path.join(process.cwd(), "site-config", "specialday-templates", siteId, `${specialDay}.json`);

    const exists = await fs.promises
      .access(templatePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const templateContent = await fs.promises.readFile(templatePath, "utf-8");
      try {
        return JSON.parse(templateContent) as SpecialDayTemplate;
      } catch (parseError) {
        console.error(`Error parsing special day template JSON for ${specialDay}, site ${siteId}:`, parseError);
        return null;
      }
    }

    // No template found for this site
    return null;
  } catch (error) {
    console.error(`Error loading special day template for ${specialDay}, site ${siteId}:`, error);
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
 * Formats example questions as a bulleted list with clickable links
 *
 * @param questions - Array of question strings
 * @param baseUrl - Base URL for creating question links
 * @param email - User email address for tracking
 * @param campaignId - Campaign ID for tracking (e.g., "masters-birthday-2026")
 * @returns Formatted HTML and text versions
 */
function formatExampleQuestions(
  questions: string[],
  baseUrl: string,
  email: string,
  campaignId: string
): { html: string; text: string } {
  const html = questions
    .map((q, index) => {
      const encodedQuestion = encodeURIComponent(q);
      // Create target URL with UTM params
      const targetUrl = addUtmParams(
        `${baseUrl}?q=${encodedQuestion}&submit=true`,
        campaignId,
        "email",
        "email",
        `question-${index + 1}`
      );

      // Generate tracking URL that logs click before redirecting
      const trackingUrl = generateClickTrackingUrl(targetUrl, email, "specialDay", campaignId, "question", q, baseUrl);

      return `• <a href="${trackingUrl}" style="color: #3498db; text-decoration: none;">${q}</a>`;
    })
    .join("<br>");
  const text = questions.map((q) => `• ${q}`).join("\n");
  return { html, text };
}

/**
 * Renders a special day email template with user data
 *
 * @param template - Template object
 * @param user - User object with firstName, email, etc.
 * @param siteId - Site ID for configuration
 * @param baseUrl - Base URL for links
 * @param year - Year for campaign tracking
 * @returns Rendered email content
 */
export async function renderSpecialDayEmail(
  template: SpecialDayTemplate,
  user: User,
  siteId: string,
  baseUrl: string,
  year: number
): Promise<{ subject: string; html: string; text: string }> {
  const siteConfig = await loadSiteConfig(siteId);
  const siteName = siteConfig?.name || siteConfig?.shortname || "our service";
  const firstName = user.firstName || "there";

  // Get user email for tracking
  const userEmail = user.id || "";
  if (!userEmail) {
    throw new Error("User email not found");
  }

  // Generate campaign ID
  const campaignId = generateCampaignId(template.specialDayId, year);

  // Select example questions (randomize from pool)
  const selectedQuestions = selectRandomExampleQuestions(
    template.exampleQuestionPool,
    template.exampleQuestionCount || 3
  );

  // Format example questions with clickable links and tracking
  const exampleQuestionsFormatted = formatExampleQuestions(selectedQuestions, baseUrl, userEmail, campaignId);

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
  const unsubscribeToken = generateUnsubscribeToken(userEmail, "specialDay");
  const unsubscribeTargetUrl = `${baseUrl}/api/unsubscribe?token=${unsubscribeToken}`;
  const unsubscribeUrl = generateClickTrackingUrl(
    unsubscribeTargetUrl,
    userEmail,
    "specialDay",
    campaignId,
    "unsubscribe",
    "specialDay",
    baseUrl
  );

  // Generate CTA URL with tracking if present
  let finalCtaUrl: string | undefined = undefined;
  if (template.ctaUrl) {
    const renderedCtaUrl = renderTemplate(template.ctaUrl, variablesHtml);
    const ctaWithUtm = addUtmParams(renderedCtaUrl, campaignId, "email", "email", "cta-button");
    finalCtaUrl = generateClickTrackingUrl(
      ctaWithUtm,
      userEmail,
      "specialDay",
      campaignId,
      "cta",
      template.ctaText,
      baseUrl
    );
  }

  // Generate email open tracking pixel URL
  const openTrackingUrl = generateOpenTrackingUrl(userEmail, "specialDay", campaignId, baseUrl);

  // Use the existing email template system
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
 * Sends a special day email to a user
 *
 * @param user - User object
 * @param specialDay - Special day ID (e.g., "masters-birthday")
 * @param siteId - Site ID
 * @param baseUrl - Base URL for links
 * @param year - Year for campaign tracking
 * @returns True if email was sent successfully
 */
export async function sendSpecialDayEmail(
  user: User,
  specialDay: string,
  siteId: string,
  baseUrl: string,
  year: number
): Promise<boolean> {
  try {
    // Load template
    const template = await loadSpecialDayTemplate(specialDay, siteId);
    if (!template) {
      console.error(`No special day template found for ${specialDay}, site ${siteId}`);
      return false;
    }

    // Render email
    const emailContent = await renderSpecialDayEmail(template, user, siteId, baseUrl, year);

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
      console.log(`✅ Sent special day email (${specialDay}-${year}) to ${userEmail}`);
    } else {
      console.error(`❌ Failed to send special day email (${specialDay}-${year}) to ${userEmail}`);
    }

    return success;
  } catch (error) {
    console.error(`Error sending special day email to user ${user.id} for ${specialDay}:`, error);
    return false;
  }
}
