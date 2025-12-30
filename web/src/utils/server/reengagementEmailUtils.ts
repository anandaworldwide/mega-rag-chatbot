/**
 * Re-engagement email utilities for rendering and sending "We Miss You" emails
 */

import * as fs from "fs";
import * as path from "path";
import jwt from "jsonwebtoken";
import { sendEmail } from "./emailUtils";
import { generateEmailContent } from "./emailTemplates";
import { loadSiteConfig } from "./loadSiteConfig";
import { User } from "@/types/user";
import { addUtmParams, generateClickTrackingUrl, generateOpenTrackingUrl } from "./emailTrackingUtils";

export interface ReengagementTemplate {
  campaignId: string;
  subject: string;
  greeting: string;
  leadIn: string;
  prompts: Record<string, string[]>;
  ctaCategories: string[];
  secondaryCta: {
    label: string;
    url: string;
  };
}

/**
 * Dynamically discovers site IDs that have re-engagement templates by reading the directory
 */
function getValidSiteIds(): Set<string> {
  const templatesDir = path.join(process.cwd(), "site-config", "reengagement-templates");
  const siteIds = new Set<string>();

  try {
    if (fs.existsSync(templatesDir)) {
      const entries = fs.readdirSync(templatesDir, { withFileTypes: true });
      for (const entry of entries) {
        // Only include JSON files with safe names (alphanumeric + hyphen)
        if (entry.isFile() && entry.name.endsWith(".json") && /^[a-zA-Z0-9-]+\.json$/.test(entry.name)) {
          const siteId = entry.name.replace(".json", "");
          siteIds.add(siteId);
        }
      }
    }
  } catch (error) {
    console.error("Error reading re-engagement templates directory:", error);
  }

  return siteIds;
}

/**
 * Validates a site ID to prevent path traversal attacks
 * Checks against dynamically discovered sites that have re-engagement templates
 */
function isValidSiteId(siteId: string): boolean {
  // First check: strict pattern match (alphanumeric + hyphen only)
  if (!/^[a-zA-Z0-9-]+$/.test(siteId)) {
    return false;
  }

  // Second check: must have re-engagement template file
  const validSiteIds = getValidSiteIds();
  return validSiteIds.has(siteId);
}

/**
 * Loads a re-engagement email template for a specific site
 *
 * @param siteId - Site ID (e.g., "ananda")
 * @returns Template object or null if not found
 */
export async function loadReengagementTemplate(siteId: string): Promise<ReengagementTemplate | null> {
  try {
    // Validate siteId to prevent path traversal
    if (!isValidSiteId(siteId)) {
      console.error(`Invalid siteId: ${siteId}`);
      return null;
    }

    // Load site-specific template only
    const templatePath = path.join(process.cwd(), "site-config", "reengagement-templates", `${siteId}.json`);

    if (fs.existsSync(templatePath)) {
      const templateContent = fs.readFileSync(templatePath, "utf-8");
      return JSON.parse(templateContent) as ReengagementTemplate;
    }

    // No template found for this site
    return null;
  } catch (error) {
    console.error(`Error loading re-engagement template for site ${siteId}:`, error);
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
 * Randomly selects one prompt from an array
 *
 * @param prompts - Array of prompt strings
 * @returns Randomly selected prompt or empty string if array is empty
 */
export function selectRandomPrompt(prompts: string[]): string {
  if (prompts.length === 0) {
    return "";
  }
  const randomIndex = Math.floor(Math.random() * prompts.length);
  return prompts[randomIndex];
}

/**
 * Generates an unsubscribe token for a specific email category
 *
 * @param email - User email address
 * @param category - Email category ("reengagement", "newsletters", etc.)
 * @returns JWT token string
 */
export function generateUnsubscribeToken(email: string, category: string): string {
  const jwtSecret = process.env.SECURE_TOKEN;
  if (!jwtSecret) {
    throw new Error("SECURE_TOKEN not configured");
  }

  return jwt.sign(
    {
      email: email.toLowerCase(),
      purpose: "email_unsubscribe",
      category: category,
    },
    jwtSecret,
    {
      algorithm: "HS256", // Use HS256 for unsubscribe tokens (no issuer/audience)
      expiresIn: "1y", // Long expiry for unsubscribe links
    }
  );
}

/**
 * Formats CTA buttons as a bullet list with bold blue question links
 *
 * @param buttons - Array of button configs with labels and prompt categories
 * @param template - Template with prompt pools
 * @param baseUrl - Base URL for creating question links
 * @param email - User email address for tracking
 * @param campaignId - Campaign ID for tracking
 * @returns Formatted HTML and text versions
 */
function formatCtaButtons(
  categories: string[],
  template: ReengagementTemplate,
  baseUrl: string,
  email: string,
  campaignId: string
): { html: string; text: string } {
  const questionHtml: string[] = [];
  const questionText: string[] = [];

  for (const category of categories) {
    // Select random prompt from the category
    const promptPool = template.prompts[category] || [];
    const selectedPrompt = selectRandomPrompt(promptPool);

    if (selectedPrompt) {
      const encodedPrompt = encodeURIComponent(selectedPrompt);
      // Create target URL with UTM params
      // Use category name for UTM tracking (e.g., "meditation-support")
      const utmCategory = category.replace(/([A-Z])/g, "-$1").toLowerCase();
      const targetUrl = addUtmParams(
        `${baseUrl}?q=${encodedPrompt}&submit=true`,
        `reengagement-${campaignId}`,
        "email",
        "email",
        utmCategory
      );

      // Generate tracking URL that logs click before redirecting
      const trackingUrl = generateClickTrackingUrl(
        targetUrl,
        email,
        "reengagement",
        campaignId,
        "question",
        selectedPrompt,
        baseUrl
      );

      // Create bullet list item with bold blue question link
      questionHtml.push(
        `<li style="margin: 2px 0; padding: 0; line-height: 1.5;"><span style="color: #333; margin-right: 6px;">•</span><a href="${trackingUrl}" style="color: #3498db; font-weight: 600; text-decoration: none; font-size: 15px;">${selectedPrompt}</a></li>`
      );
      questionText.push(`• ${selectedPrompt}: ${baseUrl}?q=${encodedPrompt}&submit=true`);
    }
  }

  return {
    html: `<ul style="margin: 8px 0 0 0; padding-left: 20px; list-style: none;">${questionHtml.join("")}</ul>`,
    text: questionText.join("\n"),
  };
}

/**
 * Renders a re-engagement email template with user data
 *
 * @param template - Template object
 * @param user - User object with firstName, email, etc.
 * @param siteId - Site ID for configuration
 * @param baseUrl - Base URL for links
 * @returns Rendered email content
 */
export async function renderReengagementEmail(
  template: ReengagementTemplate,
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

  // Prepare template variables
  const variables: Record<string, string> = {
    siteName,
    firstName,
    baseUrl,
  };

  // Render greeting and subject
  const greeting = renderTemplate(template.greeting, variables);
  const subject = renderTemplate(template.subject, variables);

  // Format CTA categories with random prompts
  const ctaButtonsFormatted = formatCtaButtons(
    template.ctaCategories,
    template,
    baseUrl,
    userEmail,
    template.campaignId
  );

  // Format secondary CTA
  const secondaryCtaUrl = renderTemplate(template.secondaryCta.url, variables);
  const secondaryCtaWithUtm = addUtmParams(
    secondaryCtaUrl,
    `reengagement-${template.campaignId}`,
    "email",
    "email",
    "return-home"
  );
  const secondaryCtaTrackingUrl = generateClickTrackingUrl(
    secondaryCtaWithUtm,
    userEmail,
    "reengagement",
    template.campaignId,
    "cta",
    template.secondaryCta.label,
    baseUrl
  );

  // Generate unsubscribe URL with tracking
  const unsubscribeToken = generateUnsubscribeToken(userEmail, "reengagement");
  const unsubscribeTargetUrl = `${baseUrl}/api/unsubscribe?token=${unsubscribeToken}`;
  const unsubscribeUrl = generateClickTrackingUrl(
    unsubscribeTargetUrl,
    userEmail,
    "reengagement",
    template.campaignId,
    "unsubscribe",
    "reengagement",
    baseUrl
  );

  // Generate email open tracking pixel URL
  const openTrackingUrl = generateOpenTrackingUrl(userEmail, "reengagement", template.campaignId, baseUrl);

  // Build email body HTML (don't include greeting here - generateEmailContent adds it)
  // Note: white-space: pre-line is used by the email template, so newlines become vertical space
  const buttonHtml = `<div style="text-align: left; margin-top: 12px;"><a href="${secondaryCtaTrackingUrl}" style="display: inline-block; padding: 12px 24px; background-color: #95a5a6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">${template.secondaryCta.label}</a></div>`;
  const bodyHtml = `${template.leadIn}
${ctaButtonsFormatted.html}${buttonHtml}`.trim();

  // Build email body text (don't include greeting here - generateEmailContent adds it)
  const bodyText = `
${template.leadIn}

${ctaButtonsFormatted.text}

${template.secondaryCta.label}: ${secondaryCtaUrl}
`.trim();

  // Use the existing email template system
  // generateEmailContent will add the greeting, so we don't include it in bodyHtml
  const emailContentHtml = generateEmailContent({
    siteId,
    baseUrl,
    greeting: greeting,
    message: bodyHtml,
    unsubscribeUrl,
  });

  // Add tracking pixel to HTML (insert before closing </body> tag)
  const htmlWithTracking = emailContentHtml.html.replace(
    "</body>",
    `<img src="${openTrackingUrl}" width="1" height="1" style="display:none;" alt="" />\n</body>`
  );

  // Generate text version separately
  const emailContentText = generateEmailContent({
    siteId,
    baseUrl,
    greeting: greeting,
    message: bodyText,
    unsubscribeUrl: unsubscribeTargetUrl, // Use original URL for text version
  });

  return {
    subject,
    html: htmlWithTracking,
    text: emailContentText.text,
  };
}

/**
 * Sends a re-engagement email to a user
 *
 * @param user - User object
 * @param siteId - Site ID
 * @param baseUrl - Base URL for links
 * @returns True if email was sent successfully
 */
export async function sendReengagementEmail(user: User, siteId: string, baseUrl: string): Promise<boolean> {
  try {
    // Load template
    const template = await loadReengagementTemplate(siteId);
    if (!template) {
      console.error(`No re-engagement template found for site ${siteId}`);
      return false;
    }

    // Render email
    const emailContent = await renderReengagementEmail(template, user, siteId, baseUrl);

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
      console.log(`✅ Sent re-engagement email to ${userEmail}`);
    } else {
      console.error(`❌ Failed to send re-engagement email to ${userEmail}`);
    }

    return success;
  } catch (error) {
    console.error(`Error sending re-engagement email to user ${user.id}:`, error);
    return false;
  }
}
