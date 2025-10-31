// HTML email template utilities with login image and site branding support
import { loadSiteConfigSync } from "./loadSiteConfig";

interface EmailTemplateOptions {
  greeting?: string;
  message: string;
  signature?: string;
  loginImageUrl?: string | null;
  baseUrl?: string;
  siteId?: string;
  actionUrl?: string; // The main URL for the action (e.g., login, activation)
  actionText?: string; // The text for the action link (e.g., "Click here to sign in")
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
  ): { html: string; text: string } {
    if (actionUrl && actionText) {
      // Replace the action text with a proper link in HTML
      let htmlMessage = message.replace(
        actionText,
        `<a href="${actionUrl}" style="color: #3498db; text-decoration: none; font-weight: bold;">${actionText}</a>`
      );

      // Make the parenthetical URL smaller in HTML version
      const urlPattern = new RegExp(`\\(Or click ${actionUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "g");
      htmlMessage = htmlMessage.replace(
        urlPattern,
        `<span style="font-size: 12px; color: #666;">(Or click ${actionUrl})</span>`
      );

      // For text version, keep it as is (already formatted with raw URL)
      return {
        html: htmlMessage,
        text: message,
      };
    }

    return {
      html: message,
      text: message,
    };
  }

  const messageContent = formatMessageContent(options.message, options.actionUrl, options.actionText);

  // Generate plain text version
  const textContent = [emailGreeting, "", messageContent.text, "", loginImageUrl ? `View online: ${baseUrl}` : ""]
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
      margin-bottom: 20px;
      color: #2c3e50;
    }
    .message {
      font-size: 16px;
      margin-bottom: 30px;
      white-space: pre-line;
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
  </div>
</body>
</html>`.trim();

  return {
    html: htmlContent,
    text: textContent,
  };
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
