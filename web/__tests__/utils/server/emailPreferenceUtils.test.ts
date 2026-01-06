/** @jest-environment node */
/**
 * Test suite for email preference utilities
 *
 * Tests cover:
 * 1. isSubscribedToCategory - checking subscription status with legacy fallback
 * 2. getDefaultEmailPreferences - default preferences for new users
 * 3. migrateEmailPreferences - migrating legacy newsletterSubscribed to new format
 */

import {
  isSubscribedToCategory,
  getDefaultEmailPreferences,
  migrateEmailPreferences,
} from "@/utils/server/emailPreferenceUtils";
import { User } from "@/types/user";

describe("emailPreferenceUtils", () => {
  describe("isSubscribedToCategory", () => {
    it("should return true when user has emailPreferences.newsletters set to true", () => {
      const user: User = {
        id: "test@example.com",
        emailPreferences: {
          newsletters: true,
          onboarding: false,
          reengagement: true,
          specialDay: true,
        },
      };

      expect(isSubscribedToCategory(user, "newsletters")).toBe(true);
    });

    it("should return false when user has emailPreferences.newsletters set to false", () => {
      const user: User = {
        id: "test@example.com",
        emailPreferences: {
          newsletters: false,
          onboarding: true,
          reengagement: true,
          specialDay: true,
        },
      };

      expect(isSubscribedToCategory(user, "newsletters")).toBe(false);
    });

    it("should return true when user has emailPreferences.onboarding set to true", () => {
      const user: User = {
        id: "test@example.com",
        emailPreferences: {
          newsletters: false,
          onboarding: true,
          reengagement: true,
          specialDay: true,
        },
      };

      expect(isSubscribedToCategory(user, "onboarding")).toBe(true);
    });

    it("should return false when user has emailPreferences.onboarding set to false", () => {
      const user: User = {
        id: "test@example.com",
        emailPreferences: {
          newsletters: true,
          onboarding: false,
          reengagement: true,
          specialDay: true,
        },
      };

      expect(isSubscribedToCategory(user, "onboarding")).toBe(false);
    });

    it("should fall back to newsletterSubscribed for newsletters category when emailPreferences not set", () => {
      const user: User = {
        id: "test@example.com",
        newsletterSubscribed: true,
      };

      expect(isSubscribedToCategory(user, "newsletters")).toBe(true);
    });

    it("should return false for newsletters when newsletterSubscribed is false", () => {
      const user: User = {
        id: "test@example.com",
        newsletterSubscribed: false,
      };

      expect(isSubscribedToCategory(user, "newsletters")).toBe(false);
    });

    it("should default to true for newsletters when newsletterSubscribed is undefined", () => {
      const user: User = {
        id: "test@example.com",
      };

      expect(isSubscribedToCategory(user, "newsletters")).toBe(true);
    });

    it("should default to true for onboarding when emailPreferences not set", () => {
      const user: User = {
        id: "test@example.com",
      };

      expect(isSubscribedToCategory(user, "onboarding")).toBe(true);
    });

    it("should prioritize emailPreferences over newsletterSubscribed for newsletters", () => {
      const user: User = {
        id: "test@example.com",
        newsletterSubscribed: true,
        emailPreferences: {
          newsletters: false,
          onboarding: true,
          reengagement: true,
          specialDay: true,
        },
      };

      expect(isSubscribedToCategory(user, "newsletters")).toBe(false);
    });
  });

  describe("getDefaultEmailPreferences", () => {
    it("should return preferences with all categories enabled", () => {
      const preferences = getDefaultEmailPreferences();

      expect(preferences).toEqual({
        newsletters: true,
        onboarding: true,
        reengagement: true,
        specialDay: true,
        nps: true,
      });
    });
  });

  describe("migrateEmailPreferences", () => {
    it("should return user unchanged if emailPreferences already exists", () => {
      const user: User = {
        id: "test@example.com",
        emailPreferences: {
          newsletters: true,
          onboarding: false,
          reengagement: true,
          specialDay: true,
        },
      };

      const migrated = migrateEmailPreferences(user);

      expect(migrated).toBe(user);
      // When emailPreferences already exists, it should remain unchanged (no migration)
      expect(migrated.emailPreferences).toEqual({
        newsletters: true,
        onboarding: false,
        reengagement: true,
        specialDay: true,
        // Note: nps is not added if emailPreferences already exists
      });
    });

    it("should migrate newsletterSubscribed true to emailPreferences.newsletters true", () => {
      const user: User = {
        id: "test@example.com",
        newsletterSubscribed: true,
      };

      const migrated = migrateEmailPreferences(user);

      expect(migrated.emailPreferences).toEqual({
        newsletters: true,
        onboarding: true,
        reengagement: true,
        specialDay: true,
        nps: true,
      });
    });

    it("should migrate newsletterSubscribed false to emailPreferences.newsletters false", () => {
      const user: User = {
        id: "test@example.com",
        newsletterSubscribed: false,
      };

      const migrated = migrateEmailPreferences(user);

      expect(migrated.emailPreferences).toEqual({
        newsletters: false,
        onboarding: true,
        reengagement: true,
        specialDay: true,
        nps: true,
      });
    });

    it("should default newsletters to true when newsletterSubscribed is undefined", () => {
      const user: User = {
        id: "test@example.com",
      };

      const migrated = migrateEmailPreferences(user);

      expect(migrated.emailPreferences).toEqual({
        newsletters: true,
        onboarding: true,
        reengagement: true,
        specialDay: true,
        nps: true,
      });
    });

    it("should preserve all other user fields", () => {
      const user: User = {
        id: "test@example.com",
        firstName: "John",
        lastName: "Doe",
        role: "user",
        newsletterSubscribed: true,
      };

      const migrated = migrateEmailPreferences(user);

      expect(migrated.firstName).toBe("John");
      expect(migrated.lastName).toBe("Doe");
      expect(migrated.role).toBe("user");
      expect(migrated.emailPreferences).toBeDefined();
    });
  });
});
