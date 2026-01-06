/**
 * NPS Survey email utilities for rendering and sending survey invitation emails
 */

import * as path from "path";
import { sendEmail } from "./emailUtils";
import { generateEmailContent, addTrackingPixel } from "./emailTemplates";
import { loadSiteConfig } from "./loadSiteConfig";
import { User } from "@/types/user";
import { generateUnsubscribeToken } from "./emailTokenUtils";
import { generateNpsSurveyToken } from "./npsSurveyTokenUtils";
import { generateClickTrackingUrl, generateOpenTrackingUrl } from "./emailTrackingUtils";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "./firestoreUtils";
import { updateLastContentEmailSent } from "./contentEmailTracker";
import { renderTemplate } from "./templateUtils";
import { EMAIL_CAMPAIGN_TRACKING } from "@/config/emailCampaigns";
import { validateUserEmail } from "./emailValidation";
import { isValidSiteId, loadTemplateFile, TemplateDirectoryConfig } from "./emailTemplateLoader";

export interface NpsSurveyTemplate {
  subject: string;
  greeting: string;
  body: string;
  ctaText?: string;
}

// Template directory configuration for NPS surveys
const NPS_TEMPLATE_CONFIG: TemplateDirectoryConfig = {
  directoryName: "nps-templates",
  isSubdirectoryBased: false,
  fileExtension: ".json",
};

/**
 * Loads an NPS survey email template for a specific site
 *
 * @param siteId - Site ID (e.g., "ananda")
 * @returns Template object or null if not found
 */
export async function loadNpsSurveyTemplate(siteId: string): Promise<NpsSurveyTemplate | null> {
  if (!(await isValidSiteId(siteId, NPS_TEMPLATE_CONFIG))) {
    console.error(`Invalid siteId: ${siteId}`);
    return null;
  }

  const templatePath = path.join(process.cwd(), "site-config", "nps-templates", `${siteId}.json`);
  const expectedDir = path.join(process.cwd(), "site-config", "nps-templates");

  return loadTemplateFile<NpsSurveyTemplate>(templatePath, expectedDir, siteId);
}

/**
 * Formats NPS score boxes (0-10) as clickable buttons
 * All boxes styled identically (neutral) to avoid response bias
 *
 * @param baseUrl - Base URL for survey links
 * @param email - User email address for token generation
 * @returns HTML and text versions of score boxes
 */
function formatScoreBoxes(baseUrl: string, email: string): { html: string; text: string } {
  const scores = Array.from({ length: 11 }, (_, i) => i);
  const scoreCells: string[] = [];

  scores.forEach((score) => {
    // Generate token for this score
    const token = generateNpsSurveyToken(email, score);
    const surveyUrl = `${baseUrl}/survey?score=${score}&token=${token}`;

    // Generate tracking URL
    const trackingUrl = generateClickTrackingUrl(
      surveyUrl,
      email,
      "nps",
      EMAIL_CAMPAIGN_TRACKING.SURVEY_INVITE_CAMPAIGN_ID,
      "score",
      score.toString(),
      baseUrl
    );

    // Table cell with button - using table layout for email client compatibility
    scoreCells.push(
      `<td style="padding: 0 2px;">
        <a href="${trackingUrl}" style="display: block; width: 40px; height: 40px; line-height: 40px; text-align: center; background-color: #f0f0f0; color: #333; text-decoration: none; border: 1px solid #ddd; border-radius: 4px; font-weight: 500; font-size: 16px;">${score}</a>
      </td>`
    );
  });

  // Table-based layout for reliable email client rendering
  const html = `
    <table cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 20px 0;">
      <tr>
        ${scoreCells.join("")}
      </tr>
      <tr>
        <td colspan="5" style="padding-top: 8px; font-size: 12px; color: #666; text-align: left; vertical-align: top;">0 - Not likely</td>
        <td style="padding-top: 8px;"></td>
        <td colspan="5" style="padding-top: 8px; font-size: 12px; color: #666; text-align: right; vertical-align: top;">10 - Very likely</td>
      </tr>
    </table>
  `;

  const text = `Please select a score from 0-10:\n${scores.join(" ")}\n\n0 - Not likely\n10 - Very likely\n\nVisit: ${baseUrl}/survey`;

  return { html, text };
}

/**
 * Renders an NPS survey email template with user data
 *
 * @param template - NPS survey template object
 * @param user - User object with email stored in id field
 * @param siteId - Site ID for configuration
 * @param baseUrl - Base URL for email links
 * @returns Rendered email content with subject, HTML, and text
 * @throws Error if user email is not found
 */
export async function renderNpsSurveyEmail(
  template: NpsSurveyTemplate,
  user: User,
  siteId: string,
  baseUrl: string
): Promise<{ subject: string; html: string; text: string }> {
  const siteConfig = await loadSiteConfig(siteId);
  const shortname = siteConfig?.shortname || "our service";
  const name = siteConfig?.name || shortname;
  const firstName = user.firstName || "there";
  const otherVisitorsReference = siteConfig?.other_visitors_reference || "others";

  // Get user email for tracking (validated in calling function)
  const userEmail = user.id || "";
  if (!userEmail) {
    throw new Error("User email not found");
  }

  // Format score boxes
  const scoreBoxes = formatScoreBoxes(baseUrl, userEmail);

  // Prepare template variables
  const variables: Record<string, string> = {
    shortname,
    name,
    firstName,
    other_visitors_reference: otherVisitorsReference,
  };

  // Render subject and body
  // Subject and greeting are plain text, escape HTML
  const subject = renderTemplate(template.subject, variables, true);
  const greeting = renderTemplate(template.greeting, variables, true);
  // Body may contain HTML from scoreBoxes, so don't escape
  const bodyText = renderTemplate(template.body, variables, false);

  // Build HTML body with score boxes
  const bodyHtml = `${bodyText}${scoreBoxes.html}`;

  // Generate unsubscribe URL
  const unsubscribeToken = generateUnsubscribeToken(userEmail, "nps");
  const unsubscribeTargetUrl = `${baseUrl}/api/unsubscribe?token=${unsubscribeToken}`;
  const unsubscribeUrl = generateClickTrackingUrl(
    unsubscribeTargetUrl,
    userEmail,
    "nps",
    EMAIL_CAMPAIGN_TRACKING.SURVEY_INVITE_CAMPAIGN_ID,
    "unsubscribe",
    "nps",
    baseUrl
  );

  // Generate email open tracking pixel URL
  const openTrackingUrl = generateOpenTrackingUrl(
    userEmail,
    "nps",
    EMAIL_CAMPAIGN_TRACKING.SURVEY_INVITE_CAMPAIGN_ID,
    baseUrl
  );

  // Use the existing email template system
  const emailContentHtml = generateEmailContent({
    siteId,
    baseUrl,
    greeting: greeting,
    message: bodyHtml,
    unsubscribeUrl,
  });

  // Add tracking pixel to HTML using centralized utility
  const htmlWithTracking = addTrackingPixel(emailContentHtml.html, openTrackingUrl);

  // Generate text version
  const bodyTextPlain = `${bodyText}\n\n${scoreBoxes.text}`;
  const emailContentText = generateEmailContent({
    siteId,
    baseUrl,
    greeting: greeting,
    message: bodyTextPlain,
    unsubscribeUrl: unsubscribeTargetUrl,
  });

  return {
    subject,
    html: htmlWithTracking,
    text: emailContentText.text,
  };
}

/**
 * Sends an NPS survey email to a user
 *
 * @param user - User object with email stored in id field
 * @param siteId - Site ID for template selection
 * @param baseUrl - Base URL for email links
 * @returns True if email was sent successfully, false otherwise
 * @throws Never throws - all errors are caught and logged, returns false
 */
export async function sendNpsSurveyEmail(user: User, siteId: string, baseUrl: string): Promise<boolean> {
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
    const template = await loadNpsSurveyTemplate(siteId);
    if (!template) {
      console.error(`No NPS survey template found for site ${siteId}`);
      return false;
    }

    // Render email
    const emailContent = await renderNpsSurveyEmail(template, user, siteId, baseUrl);

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
      console.error(`❌ Failed to send NPS survey email to ${userEmail}`);
    }

    return success;
  } catch (error) {
    console.error(`Error sending NPS survey email to user ${user.id}:`, error);
    return false;
  }
}
