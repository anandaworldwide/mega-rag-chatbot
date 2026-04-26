/**
 * User type definitions for the Ananda Library Chatbot
 */

export type EmailCategory = "newsletters" | "onboarding" | "reengagement" | "specialDay" | "nps";

export interface EmailPreferences {
  newsletters: boolean; // Admin-sent newsletters
  onboarding: boolean; // Onboarding drip emails
  reengagement: boolean; // Re-engagement emails (21-60 day inactivity)
  specialDay: boolean; // Special occasion emails (holidays, events, etc.)
  nps?: boolean; // NPS survey emails (defaults to true if not set)
}

export interface User {
  // Note: email is now stored as the document ID, not as a field
  uuid?: string | null;
  role?: string;
  firstName?: string | null;
  lastName?: string | null;
  verifiedAt?: string | null;
  lastLoginAt?: string | null;
  entitlements?: Record<string, any>;
  pendingEmail?: string | null;
  emailChangeExpiresAt?: any;
  inviteStatus?: string | null;
  // DEPRECATED - migrate to emailPreferences.newsletters
  newsletterSubscribed?: boolean;
  // NEW - Multi-category email preferences
  emailPreferences?: EmailPreferences;
  // Onboarding tracking
  onboardingEmailsSent?: number[]; // Array of day numbers (e.g., [1, 3, 7, 14])
  onboardingStartedAt?: any; // firebase.firestore.Timestamp
  onboardingCompleted?: boolean;
  // Re-engagement tracking
  reengagementEmailsSent?: string[]; // Array of campaign IDs sent
  lastReengagementSentAt?: any; // firebase.firestore.Timestamp
  pendingReengagementKeys?: string[]; // Idempotency keys for in-progress sends
  // Special day tracking
  specialDayEmailsSent?: string[]; // Array of campaign IDs (e.g., "masters-birthday-2026")
  lastSpecialDaySentAt?: any; // firebase.firestore.Timestamp
  pendingSpecialDayKeys?: string[]; // Idempotency keys for in-progress sends
  lastActivityAt?: any; // firebase.firestore.Timestamp - last chat or search activity
  createdAt?: any; // firebase.firestore.Timestamp - account creation time
  // NPS survey tracking
  lastNpsSurveySentAt?: any; // firebase.firestore.Timestamp - last NPS survey email sent
  pendingNpsSurveyKeys?: string[]; // Idempotency keys for in-progress NPS survey sends
  npsSendAttempts?: number; // Count of failed send attempts for retry logic
  lastNpsSendFailedAt?: any; // firebase.firestore.Timestamp - last failed NPS send attempt
  // Content email tracking (cross-email type)
  lastContentEmailSentAt?: any; // firebase.firestore.Timestamp - last content email sent (newsletters, surveys, onboarding, reengagement, special days)
  // Onboarding idempotency
  pendingOnboardingKeys?: string[]; // Idempotency keys for in-progress onboarding sends
  // Password authentication fields
  hasPassword?: boolean; // Computed field for client - whether user has password set
  passwordSetAt?: string | null; // When password was first set
  dismissedPasswordPromo?: boolean; // Whether user dismissed the password promotion banner
  // Access-control fields
  accessLevel?: number | null; // Effective access level, computed for API responses
  accessLevelLabel?: string | null; // Human-readable label for effective access level
  accessLevelSource?: "superuser" | "salesforce" | "manual" | "default" | null;
  manualAccessLevel?: number | null;
  salesforceAccessLevel?: number | null;
  lastSalesforceSyncAt?: any;
  salesforceId?: string | null;
  salesforceMatchStatus?: "matched" | "not_found" | "error" | "not_checked" | null;
  salesforceLastLookupError?: string | null;
  // Admin-specific fields (when needed)
  id?: string; // For admin user detail pages (this will be the email/doc ID)
  conversationCount?: number; // For admin user detail pages
}

/**
 * Password validation response
 */
export interface PasswordValidation {
  valid: boolean;
  message?: string;
  requirements?: {
    minLength: boolean;
    hasUppercase: boolean;
    hasLowercase: boolean;
    hasNumber: boolean;
  };
}
