/**
 * Onboarding email utilities for rendering and sending drip sequence emails
 */

import * as path from "path";
import { sendEmail } from "./emailUtils";
import { generateEmailContent, addTrackingPixel } from "./emailTemplates";
import { loadSiteConfig } from "./loadSiteConfig";
import { User } from "@/types/user";
import { addUtmParams, generateClickTrackingUrl, generateOpenTrackingUrl } from "./emailTrackingUtils";
import { generateUnsubscribeToken } from "./emailTokenUtils";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "./firestoreUtils";
import { updateLastContentEmailSent } from "./contentEmailTracker";
import { renderTemplate } from "./templateUtils";
import { validateUserEmail } from "./emailValidation";
import { isValidSiteId, loadTemplateFile, TemplateDirectoryConfig } from "./emailTemplateLoader";

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

// Template directory configuration for onboarding emails
const ONBOARDING_TEMPLATE_CONFIG: TemplateDirectoryConfig = {
  directoryName: "onboarding-templates",
  isSubdirectoryBased: true,
  fileExtension: ".json",
};

/**
 * Loads an onboarding email template for a specific day and site
 * Uses async file operations to avoid blocking the event loop
 *
 * @param day - Day number (0, 3, 7, or 14)
 * @param siteId - Site ID (e.g., "ananda")
 * @returns Template object or null if not found
 */
export async function loadOnboardingTemplate(day: number, siteId: string): Promise<OnboardingTemplate | null> {
  // Validate siteId to prevent path traversal
  if (!(await isValidSiteId(siteId, ONBOARDING_TEMPLATE_CONFIG))) {
    console.error(`Invalid siteId: ${siteId}`);
    return null;
  }

  // Validate day parameter
  if (!Number.isInteger(day) || day < 0) {
    console.error(`Invalid day parameter: ${day}`);
    return null;
  }

  const templatePath = path.join(process.cwd(), "site-config", "onboarding-templates", siteId, `day${day}.json`);
  const expectedDir = path.join(process.cwd(), "site-config", "onboarding-templates", siteId);

  return loadTemplateFile<OnboardingTemplate>(templatePath, expectedDir, `${siteId}/day${day}`);
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
  // Subject is plain text, escape HTML
  const subject = renderTemplate(template.subject, variablesText, true);
  // Body HTML may contain HTML from exampleQuestions, so don't escape
  const bodyHtml = renderTemplate(template.body, variablesHtml, false);
  // Body text is plain text, escape HTML
  const bodyText = renderTemplate(template.body, variablesText, true);

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
    emailCategory: "onboarding",
  });

  // Add tracking pixel to HTML using centralized utility
  const htmlWithTracking = addTrackingPixel(emailContentHtml.html, openTrackingUrl);

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
    emailCategory: "onboarding",
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
 * @param user - User object with email stored in id field
 * @param day - Day number (0, 3, 7, or 14)
 * @param siteId - Site ID
 * @param baseUrl - Base URL for links
 * @returns True if email was sent successfully, false otherwise
 * @throws Never throws - all errors are caught and logged, returns false
 */
export async function sendOnboardingEmail(user: User, day: number, siteId: string, baseUrl: string): Promise<boolean> {
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
    const template = await loadOnboardingTemplate(day, siteId);
    if (!template) {
      console.error(`No template found for day ${day}, site ${siteId}`);
      return false;
    }

    // Render email
    const emailContent = await renderOnboardingEmail(template, user, siteId, baseUrl);

    // Send email
    const success = await sendEmail({
      to: userEmail,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (success) {
      // Update content email tracking (awaited to ensure completion before function returns)
      if (db) {
        const usersCol = getUsersCollectionName();
        const userRef = db.collection(usersCol).doc(userEmail);
        await updateLastContentEmailSent(userRef);
      }
    } else {
      console.error(`❌ Failed to send onboarding email (day ${day}) to ${userEmail}`);
    }

    return success;
  } catch (error) {
    console.error(`Error sending onboarding email to user ${user.id}:`, error);
    return false;
  }
}
