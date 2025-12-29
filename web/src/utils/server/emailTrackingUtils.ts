/**
 * Email tracking utilities for all email campaigns
 * Adds UTM parameters and generates tracking URLs
 *
 * Supports multiple campaign types:
 * - onboarding: Drip sequence emails (day 0, 3, 7, 14)
 * - newsletters: Admin-sent newsletters
 * - reengagement: Re-engagement campaigns (future)
 * - specialDay: Special occasion emails (future)
 */

/**
 * Adds UTM parameters to a URL for email campaign tracking
 *
 * @param url - Base URL (can already have query params)
 * @param campaign - Campaign name (e.g., "onboarding-day0")
 * @param source - Source (default: "email")
 * @param medium - Medium (default: "email")
 * @param content - Optional content identifier (e.g., "question-1", "cta-button")
 * @returns URL with UTM parameters appended
 */
export function addUtmParams(
  url: string,
  campaign: string,
  source: string = "email",
  medium: string = "email",
  content?: string
): string {
  try {
    const urlObj = new URL(url);

    // Add UTM parameters
    urlObj.searchParams.set("utm_source", source);
    urlObj.searchParams.set("utm_medium", medium);
    urlObj.searchParams.set("utm_campaign", campaign);
    if (content) {
      urlObj.searchParams.set("utm_content", content);
    }

    return urlObj.toString();
  } catch (_error) {
    // If URL parsing fails (e.g., relative URL), append params manually
    const separator = url.includes("?") ? "&" : "?";
    const params = new URLSearchParams({
      utm_source: source,
      utm_medium: medium,
      utm_campaign: campaign,
      ...(content && { utm_content: content }),
    });
    return `${url}${separator}${params.toString()}`;
  }
}

/**
 * Campaign type for email tracking
 */
export type EmailCampaignType = "onboarding" | "newsletter" | "reengagement" | "specialDay";

/**
 * Link type for click tracking
 */
export type EmailLinkType = "question" | "cta" | "unsubscribe" | "link";

/**
 * Generates a click tracking URL that logs the click before redirecting
 *
 * @param targetUrl - The final destination URL
 * @param email - User email address
 * @param campaignType - Type of campaign ("onboarding", "newsletter", etc.)
 * @param campaignId - Campaign identifier (e.g., day number for onboarding, newsletterId for newsletters)
 * @param linkType - Type of link ("question", "cta", "unsubscribe", "link")
 * @param linkId - Optional identifier for the specific link (e.g., question text, button text)
 * @param baseUrl - Base URL for the tracking endpoint
 * @returns Tracking URL that redirects to targetUrl
 */
export function generateClickTrackingUrl(
  targetUrl: string,
  email: string,
  campaignType: EmailCampaignType,
  campaignId: string | number,
  linkType: EmailLinkType,
  linkId?: string,
  baseUrl?: string
): string {
  const trackingBase = baseUrl || process.env.NEXT_PUBLIC_BASE_URL || "";
  const trackingUrl = new URL("/api/email/click", trackingBase);

  // Encode the target URL
  trackingUrl.searchParams.set("url", encodeURIComponent(targetUrl));
  trackingUrl.searchParams.set("email", encodeURIComponent(email));
  trackingUrl.searchParams.set("campaign", campaignType);
  trackingUrl.searchParams.set("campaignId", campaignId.toString());
  trackingUrl.searchParams.set("type", linkType);
  if (linkId) {
    trackingUrl.searchParams.set("id", encodeURIComponent(linkId));
  }

  return trackingUrl.toString();
}

/**
 * Generates an email open tracking pixel URL
 *
 * @param email - User email address
 * @param campaignType - Type of campaign ("onboarding", "newsletter", etc.)
 * @param campaignId - Campaign identifier (e.g., day number for onboarding, newsletterId for newsletters)
 * @param baseUrl - Base URL for the tracking endpoint
 * @returns URL for 1x1 tracking pixel
 */
export function generateOpenTrackingUrl(
  email: string,
  campaignType: EmailCampaignType,
  campaignId: string | number,
  baseUrl?: string
): string {
  const trackingBase = baseUrl || process.env.NEXT_PUBLIC_BASE_URL || "";
  const trackingUrl = new URL("/api/email/open", trackingBase);

  // Generate a token containing campaign info (not sensitive, just to prevent enumeration)
  const token = Buffer.from(`${email}:${campaignType}:${campaignId}:${Date.now()}`).toString("base64");
  trackingUrl.searchParams.set("token", token);

  return trackingUrl.toString();
}
