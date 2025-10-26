// Password promotion banner: Subtle, dismissible banner to promote password authentication after magic link login
// TODO (October 2026): Consider removing this banner entirely - by then all users will have seen the interstitial
import React, { useState, useEffect } from "react";
import Link from "next/link";

interface PasswordPromoBannerProps {
  onDismiss?: () => void;
}

export function PasswordPromoBanner({ onDismiss }: PasswordPromoBannerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);

  useEffect(() => {
    // Check if user should see the banner
    async function checkBannerVisibility() {
      try {
        const profileRes = await fetch("/api/profile");
        if (!profileRes.ok) {
          setIsVisible(false);
          return;
        }

        const profile = await profileRes.json();

        // Hide banner for accounts created after October 25, 2025
        // (these users see the interstitial choose-auth-method page)
        const cutoffDate = new Date("2025-10-25T00:00:00Z");
        const verifiedAt = profile.verifiedAt ? new Date(profile.verifiedAt) : null;
        const isNewAccount = verifiedAt && verifiedAt > cutoffDate;

        // Show banner if:
        // 1. User doesn't have a password set
        // 2. User hasn't dismissed the banner before
        // 3. Account was created before October 25, 2025 (older accounts didn't see interstitial)
        const shouldShow = !profile.hasPassword && !profile.dismissedPasswordPromo && !isNewAccount;
        setIsVisible(shouldShow);
      } catch (error) {
        console.error("Failed to check banner visibility:", error);
        setIsVisible(false);
      }
    }

    checkBannerVisibility();
  }, []);

  async function handleDismiss() {
    setIsDismissing(true);

    try {
      // Update profile to mark banner as dismissed
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissedPasswordPromo: true }),
      });

      if (res.ok) {
        setIsVisible(false);
        onDismiss?.();
      }
    } catch (error) {
      console.error("Failed to dismiss banner:", error);
    } finally {
      setIsDismissing(false);
    }
  }

  if (!isVisible) return null;

  return (
    <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-4 rounded-r shadow-sm" role="alert">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <svg
              className="h-5 w-5 text-blue-400 flex-shrink-0"
              fill="currentColor"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clipRule="evenodd"
              />
            </svg>
            <h3 className="text-sm font-medium text-blue-800">Password login is now available (optional)</h3>
          </div>
          <p className="text-sm text-blue-700 ml-7">
            You can add a password in your{" "}
            <Link href="/settings" className="font-medium underline hover:text-blue-900">
              settings
            </Link>{" "}
            if you prefer typing credentials. Or continue using magic links — both options work equally well.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={isDismissing}
          className="flex-shrink-0 rounded-md bg-blue-50 p-1.5 text-blue-500 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 focus:ring-offset-blue-50 disabled:opacity-50"
          aria-label="Dismiss banner"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
