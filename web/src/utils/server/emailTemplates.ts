// HTML email template utilities with login image and site branding support
import { loadSiteConfigSync } from "./loadSiteConfig";
import { escapeHtml } from "./templateUtils";

/**
 * Gets the subscription reason text for an email category
 * @param category - The email category
 * @param siteName - The site name to include in the message
 * @returns The subscription reason text
 */
function getSubscriptionReasonText(category: EmailCategory | undefined, siteName: string): string {
  switch (category) {
    case "onboarding":
      return `You're receiving this because you're subscribed to ${siteName} getting started tips.`;
    case "specialDay":
      return `You're receiving this because you're subscribed to ${siteName} special occasion notifications.`;
    case "reengagement":
      return `You're receiving this because you're subscribed to ${siteName} activity reminders.`;
    case "nps":
      return `You're receiving this because you're subscribed to occasional ${siteName} feedback requests.`;
    case "newsletters":
      return `You're receiving this because you're subscribed to ${siteName} newsletter updates.`;
    default:
      return `You're receiving this because you're subscribed to ${siteName} updates.`;
  }
}

// Email category types for subscription reason text
export type EmailCategory = "onboarding" | "specialDay" | "reengagement" | "nps" | "newsletters";

interface EmailTemplateOptions {
  greeting?: string;
  message: string;
  signature?: string;
  loginImageUrl?: string | null;
  baseUrl?: string;
  siteId?: string;
  actionUrl?: string; // The main URL for the action (e.g., login, activation)
  actionText?: string; // The text for the action link (e.g., "Click here to sign in")
  unsubscribeUrl?: string; // Optional unsubscribe link URL
  emailCategory?: EmailCategory; // Category for subscription reason text
}

/**
 * Generates both HTML and plain text versions of an email
 * Follows the format: <emailGreeting> <message> <loginImage>
 */
export function generateEmailContent(options: EmailTemplateOptions): {
  html: string;
  text: string;
} {
  const siteConfig = loadSiteConfigSync(options.siteId);
  const baseUrl = options.baseUrl || process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_BASE_URL environment variable is required for email generation");
  }

  // Get site-specific values
  const emailGreeting = options.greeting || siteConfig?.emailGreeting || "Hi there,";
  const siteName = siteConfig?.name || siteConfig?.shortname || "your account";
  const shortName = siteConfig?.shortname || siteName;

  // Determine login image URL
  let loginImageUrl = "";
  if (siteConfig?.loginImage && options.loginImageUrl !== null) {
    // If loginImage is configured and not explicitly disabled
    // Use absolute URL for email clients - images are served from public root
    loginImageUrl = `${baseUrl}/${siteConfig.loginImage}`;
  }

  // Format message content for HTML and text versions
  function formatMessageContent(
    message: string,
    actionUrl?: string,
    actionText?: string
  ): { html: string; text: string; hasButton: boolean } {
    if (actionUrl && actionText) {
      // Remove the action text from message if it exists (we'll add it as a button)
      let htmlMessage = message.replace(new RegExp(actionText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");

      // Create the left-justified blue button (matching admin approval email style)
      const buttonHtml = `<div style="text-align: left; margin: 4px 0 2px 0;"><a href="${actionUrl}" style="display: inline-block; padding: 12px 24px; background-color: #3498db; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">${actionText}</a></div>`;

      // Look for parenthetical URL patterns (both "visit" and "click" variations)
      // Also handle URL-encoded versions and different URL formats
      const escapedUrl = actionUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const encodedUrl = encodeURIComponent(actionUrl).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Try multiple patterns to find where the URL appears in the message
      const urlPatterns = [
        new RegExp(`\\(Or visit ${escapedUrl}\\)`, "gi"),
        new RegExp(`\\(Or click ${escapedUrl}\\)`, "gi"),
        new RegExp(`\\(Or visit ${encodedUrl}\\)`, "gi"),
        new RegExp(`\\(Or click ${encodedUrl}\\)`, "gi"),
        // Also try to find any parenthetical URL pattern
        /\(Or (?:visit|click) [^)]+\)/gi,
      ];

      let buttonInserted = false;

      // Try to replace parenthetical URL pattern with just the button
      for (const pattern of urlPatterns) {
        if (pattern.test(htmlMessage)) {
          htmlMessage = htmlMessage.replace(pattern, buttonHtml);
          buttonInserted = true;
          break;
        }
      }

      // If no parenthetical URL found, insert button after the main message content
      // Look for common patterns like "Click here..." or expiry messages
      if (!buttonInserted) {
        const lines = htmlMessage.split("\n");
        // Find where to insert - look for lines with "Click here" or before expiry messages
        let insertIndex = lines.length;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].toLowerCase();
          // Insert after "Click here" type lines or before expiry messages
          if (line.includes("click here") || line.includes("expires") || line.includes("link expires")) {
            insertIndex = i + 1;
            break;
          }
        }

        // If we didn't find a good spot, insert before the last non-empty line (usually expiry info)
        if (insertIndex === lines.length) {
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].trim().length > 0) {
              insertIndex = i + 1;
              break;
            }
          }
        }

        // Insert button only (no fallback URL text needed)
        lines.splice(insertIndex, 0, buttonHtml);
        htmlMessage = lines.join("\n");
      }

      // For text version, keep it as is (already formatted with raw URL)
      return {
        html: htmlMessage,
        text: message,
        hasButton: true,
      };
    }

    return {
      html: message,
      text: message,
      hasButton: false,
    };
  }

  const messageContent = formatMessageContent(options.message, options.actionUrl, options.actionText);

  // Generate plain text version
  const settingsUrl = `${baseUrl}/settings`;
  const subscriptionReason = getSubscriptionReasonText(options.emailCategory, shortName);
  const unsubscribeText = options.unsubscribeUrl
    ? `\n\n${subscriptionReason}\nOne-click unsubscribe: ${options.unsubscribeUrl}\n(or manage all email preferences: ${settingsUrl})`
    : "";
  const textContent = [
    emailGreeting,
    "",
    messageContent.text,
    "",
    loginImageUrl ? `View online: ${baseUrl}` : "",
    unsubscribeText,
  ]
    .filter((line) => line !== "")
    .join("\n");

  // Generate HTML version
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${siteName}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f8f9fa;
    }
    .email-container {
      background-color: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }
    .greeting {
      font-size: 16px;
      margin-bottom: 12px;
      color: #2c3e50;
    }
    .message {
      font-size: 16px;
      margin-bottom: 16px;
      white-space: pre-line;
    }
    .action-button {
      display: inline-block;
      padding: 12px 24px;
      margin: 20px 0;
      background-color: #3498db;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 16px;
      text-align: center;
    }
    .action-button:hover {
      background-color: #2980b9;
    }
            ${
              loginImageUrl
                ? `
        .login-image {
          text-align: center;
          margin-top: 20px;
        }
        .login-image img {
          max-width: 200px;
          height: auto;
          border-radius: 8px;
        }`
                : ""
            }

    a {
      color: #3498db;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="greeting">${emailGreeting}</div>
    
    <div class="message">${messageContent.html}</div>

    ${
      loginImageUrl
        ? `
    <div class="login-image">
      <img src="${loginImageUrl}" alt="${shortName}" />
    </div>
    `
        : ""
    }
    ${
      options.unsubscribeUrl
        ? `
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center;">
      <p style="margin: 0 0 8px 0;">${subscriptionReason}</p>
      <a href="${options.unsubscribeUrl}" style="color: #999; text-decoration: underline;">One-click unsubscribe</a>
      <span style="color: #999;"> (or <a href="${settingsUrl}" style="color: #999; text-decoration: underline;">manage all email preferences</a>)</span>
    </div>
    `
        : ""
    }
  </div>
</body>
</html>`.trim();

  return {
    html: htmlContent,
    text: textContent,
  };
}

/**
 * Adds an email open tracking pixel to HTML email content
 * Safely injects a 1x1 tracking image before the closing </body> tag
 *
 * @param htmlContent - The HTML email content
 * @param trackingUrl - The tracking pixel URL (will be HTML-escaped)
 * @returns HTML content with tracking pixel injected
 */
export function addTrackingPixel(htmlContent: string, trackingUrl: string): string {
  // Escape the tracking URL to prevent XSS
  const escapedUrl = escapeHtml(trackingUrl);
  const trackingPixel = `<img src="${escapedUrl}" width="1" height="1" style="display:none;" alt="" />\n`;

  // Check if </body> tag exists before replacing to prevent malformed HTML
  if (htmlContent.includes("</body>")) {
    return htmlContent.replace("</body>", `${trackingPixel}</body>`);
  }

  // If no </body> tag, append tracking pixel at the end
  return `${htmlContent}\n${trackingPixel}`;
}

/**
 * Helper function to create email parameters for SES with both HTML and text versions
 */
export function createEmailParams(
  fromEmail: string,
  toEmail: string,
  subject: string,
  templateOptions: EmailTemplateOptions
) {
  const { html, text } = generateEmailContent(templateOptions);

  return {
    Source: fromEmail,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Html: { Data: html },
        Text: { Data: text },
      },
    },
  };
}
