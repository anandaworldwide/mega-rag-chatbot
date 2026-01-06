/**
 * Email preference utilities for checking user subscription status
 * Supports multi-category email preferences with legacy fallback
 */

import { User, EmailCategory, EmailPreferences } from "@/types/user";

/**
 * Checks if a user is subscribed to a specific email category
 *
 * @param user - User document data
 * @param category - Email category to check
 * @returns true if user is subscribed, false otherwise
 */
export function isSubscribedToCategory(user: User, category: EmailCategory): boolean {
  // Check new emailPreferences first
  if (user.emailPreferences?.[category] !== undefined) {
    return user.emailPreferences[category];
  }

  // Legacy fallback for newsletters
  if (category === "newsletters") {
    return user.newsletterSubscribed !== false; // Default to true if not explicitly false
  }

  // Default: subscribed (new users get all categories ON by default)
  return true;
}

/**
 * Gets default email preferences for new users
 *
 * @returns Default EmailPreferences object with all categories enabled
 */
export function getDefaultEmailPreferences(): EmailPreferences {
  return {
    newsletters: true,
    onboarding: true,
    reengagement: true,
    specialDay: true,
    nps: true,
  };
}

/**
 * Migrates legacy newsletterSubscribed to emailPreferences.newsletters
 * Call this when reading user data to ensure compatibility
 *
 * @param user - User document data
 * @returns User with migrated emailPreferences if needed
 */
export function migrateEmailPreferences(user: User): User {
  // If emailPreferences already exists, no migration needed
  if (user.emailPreferences) {
    return user;
  }

  // Migrate newsletterSubscribed to emailPreferences.newsletters
  const migratedPreferences: EmailPreferences = {
    newsletters: user.newsletterSubscribed !== false, // Default to true if not explicitly false
    onboarding: true, // New users get onboarding enabled by default
    reengagement: true, // New users get re-engagement enabled by default
    specialDay: true, // New users get special day emails enabled by default
    nps: true, // New users get NPS survey emails enabled by default
  };

  return {
    ...user,
    emailPreferences: migratedPreferences,
  };
}
