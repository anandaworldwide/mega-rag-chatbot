/**
 * Special day email utilities for rendering and sending holy day emails
 */

import * as path from "path";
import { sendEmail } from "./emailUtils";
import { generateEmailContent, addTrackingPixel } from "./emailTemplates";
import { loadSiteConfig } from "./loadSiteConfig";
import { User } from "@/types/user";
import { addUtmParams, generateClickTrackingUrl, generateOpenTrackingUrl } from "./emailTrackingUtils";
import { generateUnsubscribeToken } from "./emailTokenUtils";
import { selectRandomExampleQuestions } from "./onboardingEmailUtils";
import { generateCampaignId } from "@/config/specialDays";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "./firestoreUtils";
import { updateLastContentEmailSent } from "./contentEmailTracker";
import { renderTemplate } from "./templateUtils";
import { validateUserEmail } from "./emailValidation";
import { isValidSiteId, loadTemplateFile, TemplateDirectoryConfig } from "./emailTemplateLoader";

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

// Template directory configuration for special day emails
const SPECIAL_DAY_TEMPLATE_CONFIG: TemplateDirectoryConfig = {
  directoryName: "specialday-templates",
  isSubdirectoryBased: true,
  fileExtension: ".json",
};

/**
 * Loads a special day email template for a specific special day and site
 * Uses async file operations to avoid blocking the event loop
 *
 * @param specialDay - Special day ID (e.g., "masters-birthday")
 * @param siteId - Site ID (e.g., "ananda")
 * @returns Template object or null if not found
 */
export async function loadSpecialDayTemplate(specialDay: string, siteId: string): Promise<SpecialDayTemplate | null> {
  // Validate siteId to prevent path traversal
  if (!(await isValidSiteId(siteId, SPECIAL_DAY_TEMPLATE_CONFIG))) {
    console.error(`Invalid siteId: ${siteId}`);
    return null;
  }

  // Validate specialDay to prevent path traversal
  if (!/^[a-zA-Z0-9-]+$/.test(specialDay)) {
    console.error(`Invalid specialDay: ${specialDay}`);
    return null;
  }

  const templatePath = path.join(process.cwd(), "site-config", "specialday-templates", siteId, `${specialDay}.json`);
  const expectedDir = path.join(process.cwd(), "site-config", "specialday-templates", siteId);

  return loadTemplateFile<SpecialDayTemplate>(templatePath, expectedDir, `${siteId}/${specialDay}`);
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
  // Subject is plain text, escape HTML
  const subject = renderTemplate(template.subject, variablesText, true);
  // Body HTML may contain HTML from exampleQuestions, so don't escape
  const bodyHtml = renderTemplate(template.body, variablesHtml, false);
  // Body text is plain text, escape HTML
  const bodyText = renderTemplate(template.body, variablesText, true);

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
    emailCategory: "specialDay",
  });

  // Add tracking pixel to HTML using centralized utility
  const htmlWithTracking = addTrackingPixel(emailContentHtml.html, openTrackingUrl);

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
    emailCategory: "specialDay",
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
 * @param user - User object with email stored in id field
 * @param specialDay - Special day ID (e.g., "masters-birthday")
 * @param siteId - Site ID
 * @param baseUrl - Base URL for links
 * @param year - Year for campaign tracking
 * @returns True if email was sent successfully, false otherwise
 * @throws Never throws - all errors are caught and logged, returns false
 */
export async function sendSpecialDayEmail(
  user: User,
  specialDay: string,
  siteId: string,
  baseUrl: string,
  year: number
): Promise<boolean> {
  try {
    // Validate user email before proceeding
    const emailValidation = validateUserEmail(user);
    if (!emailValidation.isValid) {
      console.error(`User email validation failed: ${emailValidation.error}`);
      return false;
    }
    const userEmail = emailValidation.email!;

    // Validate baseUrl
    if (!baseUrl || typeof baseUrl !== "string") {
      console.error("Invalid baseUrl provided");
      return false;
    }

    // Load template
    const template = await loadSpecialDayTemplate(specialDay, siteId);
    if (!template) {
      console.error(`No special day template found for ${specialDay}, site ${siteId}`);
      return false;
    }

    // Render email
    const emailContent = await renderSpecialDayEmail(template, user, siteId, baseUrl, year);

    // Send email
    const success = await sendEmail({
      to: userEmail,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (success) {
      console.log(`✅ Sent special day email (${specialDay}-${year}) to ${userEmail}`);
      // Update content email tracking (awaited to ensure completion before function returns)
      if (db) {
        const usersCol = getUsersCollectionName();
        const userRef = db.collection(usersCol).doc(userEmail);
        await updateLastContentEmailSent(userRef);
      }
    } else {
      console.error(`❌ Failed to send special day email (${specialDay}-${year}) to ${userEmail}`);
    }

    return success;
  } catch (error) {
    console.error(`Error sending special day email to user ${user.id} for ${specialDay}:`, error);
    return false;
  }
}
