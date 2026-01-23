// Settings page: shows user email and a logout button
import React, { useEffect, useState, useMemo } from "react";
import Head from "next/head";
import Layout from "@/components/layout";
import type { GetServerSideProps } from "next";
import type { SiteConfig } from "@/types/siteConfig";

import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

import { EmailChangeModal } from "@/components/EmailChangeModal";
import { PasswordChangeModal } from "@/components/PasswordChangeModal";
import type { EmailPreferences, EmailCategory } from "@/types/user";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "@/config/modelOptions";
import { logEvent } from "@/utils/client/analytics";

export default function SettingsPage({ siteConfig }: { siteConfig: SiteConfig | null }) {
  const [email, setEmail] = useState<string | null>(null);
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [emailPreferences, setEmailPreferences] = useState<EmailPreferences>({
    newsletters: true,
    onboarding: true,
    reengagement: true,
    specialDay: true,
    nps: true,
  });
  const [enabledEmailTypes, setEnabledEmailTypes] = useState<EmailCategory[]>([]);

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [role, setRole] = useState<string>("user");
  const [savingProfile, setSavingProfile] = useState(false);

  // Chat preferences state
  const [preferredModel, setPreferredModel] = useState<string>(DEFAULT_MODEL);
  const [savingChatPrefs, setSavingChatPrefs] = useState(false);
  const [showModelInfo, setShowModelInfo] = useState(false);

  // Close model info modal on Escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && showModelInfo) {
        setShowModelInfo(false);
      }
    };

    if (showModelInfo) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showModelInfo]);

  // Email change state
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [isEmailChangeModalOpen, setIsEmailChangeModalOpen] = useState(false);

  // Password management state
  const [hasPassword, setHasPassword] = useState<boolean>(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);

  // Account activation date (for hiding onboarding after 30 days)
  const [verifiedAt, setVerifiedAt] = useState<Date | null>(null);

  // Filter out onboarding email preference after 30 days since activation
  const visibleEmailTypes = useMemo(() => {
    if (!verifiedAt) return enabledEmailTypes;

    const daysSinceActivation = Math.floor((Date.now() - verifiedAt.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceActivation > 30) {
      return enabledEmailTypes.filter((type) => type !== "onboarding");
    }
    return enabledEmailTypes;
  }, [enabledEmailTypes, verifiedAt]);

  useEffect(() => {
    (async () => {
      try {
        // Fetch a short-lived web token; if site does not require login, block access
        const tokenRes = await fetch("/api/web-token");
        const tokenData = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenData?.token) {
          setMessage("Settings are not available on this site");
          setLoading(false);
          return;
        }

        // Get user email from auth cookie by asking a lightweight endpoint that echoes decoded JWT
        // Reuse web-token’s signed token to call a small self endpoint (or decode on server). For now, read from /api/answers as a noop to validate session
        // Since we don’t have a dedicated profile endpoint yet, show placeholder email pulled from JWT is not available on client
        // Fallback: show "Signed in" without email
        try {
          const profileRes = await fetch("/api/profile");
          const profile = await profileRes.json().catch(() => ({}));
          if (profileRes.ok && profile?.email) {
            setEmail(profile.email);
            setRole(typeof profile?.role === "string" ? profile.role : "user");
            setFirstName(typeof profile?.firstName === "string" ? profile.firstName : "");
            setLastName(typeof profile?.lastName === "string" ? profile.lastName : "");
            if (profile?.emailPreferences && typeof profile.emailPreferences === "object") {
              setEmailPreferences({
                newsletters: profile.emailPreferences.newsletters !== false,
                onboarding: profile.emailPreferences.onboarding !== false,
                reengagement: profile.emailPreferences.reengagement !== false,
                specialDay: profile.emailPreferences.specialDay !== false,
                nps: profile.emailPreferences.nps !== false,
              });
            }
            if (Array.isArray(profile?.enabledEmailTypes)) {
              setEnabledEmailTypes(profile.enabledEmailTypes);
            }
            setPendingEmail(typeof profile?.pendingEmail === "string" ? profile.pendingEmail : null);
            setHasPassword(typeof profile?.hasPassword === "boolean" ? profile.hasPassword : false);
            // Load activation date for onboarding email visibility
            if (profile?.verifiedAt) {
              setVerifiedAt(new Date(profile.verifiedAt));
            }
            // Load chat preferences
            if (typeof profile?.preferredModel === "string") {
              setPreferredModel(profile.preferredModel);
              localStorage.setItem("selectedModel", profile.preferredModel);
            }
          } else {
            setEmail(null);
            setRole("user");
          }
        } catch {
          setEmail(null);
          setRole("user");
        }
      } catch (e: any) {
        setMessage(e?.message || "Failed to load settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleLogout(e: React.MouseEvent) {
    e.preventDefault();
    try {
      const res = await fetch("/api/logout", { method: "POST" });
      if (!res.ok) throw new Error("Logout failed");
      window.location.href = "/";
    } catch (e: any) {
      setMessage(e?.message || "Logout failed");
    }
  }

  async function handleSaveProfile(e?: React.FormEvent | React.MouseEvent) {
    if (e) {
      e.preventDefault();
    }
    try {
      setSavingProfile(true);
      const body: {
        firstName?: string;
        lastName?: string;
        emailPreferences?: EmailPreferences;
      } = {};

      // Only include fields that have been changed (for now, always send all)
      body.firstName = firstName.trim();
      body.lastName = lastName.trim();
      if (enabledEmailTypes.length > 0) {
        body.emailPreferences = emailPreferences;
      }

      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to save profile");
      setMessage("Profile updated");
    } catch (e: any) {
      setMessage(e?.message || "Failed to save profile");
    } finally {
      setSavingProfile(false);
    }
  }

  function handleEmailPreferenceChange(category: EmailCategory, value: boolean) {
    setEmailPreferences((prev) => ({
      ...prev,
      [category]: value,
    }));
  }

  async function handleSaveChatPreferences() {
    try {
      setSavingChatPrefs(true);
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredModel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to save chat preferences");

      // Also save to localStorage for immediate use
      localStorage.setItem("selectedModel", preferredModel);
      setMessage("Chat preferences saved");

      // Track AI model change in Google Analytics
      logEvent("settings_model_changed", "Settings", preferredModel);
    } catch (e: any) {
      setMessage(e?.message || "Failed to save chat preferences");
    } finally {
      setSavingChatPrefs(false);
    }
  }

  const emailCategoryConfig: Record<EmailCategory, { label: string; description: string }> = {
    newsletters: {
      label: "Newsletter updates",
      description: "Periodic newsletters with new content and updates",
    },
    onboarding: {
      label: "Getting started tips",
      description: "Helpful guidance emails in the first two weeks after you join",
    },
    reengagement: {
      label: "Return reminders",
      description: "Friendly reminder if you haven't visited in a while",
    },
    specialDay: {
      label: "Special occasions",
      description: "Emails for holidays and special events",
    },
    nps: {
      label: "Feedback surveys",
      description: "Occasional surveys to help us improve (once every six months)",
    },
  };

  function handleEmailChangeRequested(newEmail: string) {
    setPendingEmail(newEmail);
    setMessage("Verification email sent! Check your inbox.");
  }

  function handleEmailChangeCancelled() {
    setPendingEmail(null);
    setMessage("Email change cancelled");
  }

  function handlePasswordChanged(successMessage: string) {
    setHasPassword(true);
    setMessage(successMessage);
  }

  return (
    <>
      <Head>
        <title>Settings</title>
      </Head>
      <Layout siteConfig={siteConfig}>
        <main className="mx-auto max-w-3xl p-6 w-full">
          <h1 className="text-2xl font-semibold mb-4">Settings</h1>
          {message && <div className="mb-4 rounded border border-yellow-300 bg-yellow-50 p-3 text-sm">{message}</div>}

          {loading ? (
            <div>Loading…</div>
          ) : (
            <>
              <section className="mb-6">
                <h2 className="text-lg font-semibold mb-1">Account</h2>
                <div className="text-sm text-gray-700">
                  {email ? (
                    <div className="flex items-center gap-3">
                      <div>
                        <span>Email: {email}</span>
                        {pendingEmail && (
                          <div className="text-xs text-amber-600 mt-1">Pending change to: {pendingEmail}</div>
                        )}
                      </div>
                      <button
                        onClick={() => setIsEmailChangeModalOpen(true)}
                        className="text-xs text-blue-600 hover:text-blue-800 border border-blue-600 hover:border-blue-800 rounded px-2 py-1 transition-colors"
                        aria-label="Change email address"
                      >
                        Edit
                      </button>
                    </div>
                  ) : (
                    "Signed in"
                  )}
                </div>
                {(role === "admin" || role === "superuser") && (
                  <div className="mt-2 flex items-center gap-2">
                    {role === "admin" && (
                      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                        Admin
                      </span>
                    )}
                    {role === "superuser" && (
                      <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                        Superuser
                      </span>
                    )}
                  </div>
                )}
              </section>

              <section className="mb-6">
                <h2 className="text-lg font-semibold mb-1">Profile</h2>
                <form onSubmit={handleSaveProfile} className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="firstName" className="block text-sm font-medium mb-1">
                        First name
                      </label>
                      <input
                        id="firstName"
                        className="w-full rounded border px-3 py-2"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        placeholder="First name"
                      />
                    </div>
                    <div>
                      <label htmlFor="lastName" className="block text-sm font-medium mb-1">
                        Last name
                      </label>
                      <input
                        id="lastName"
                        className="w-full rounded border px-3 py-2"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        placeholder="Last name"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50 hover:bg-blue-700"
                  >
                    {savingProfile ? "Saving…" : "Save Profile"}
                  </button>
                </form>
              </section>

              <section className="mb-6">
                <h2 className="text-lg font-semibold mb-1">Security</h2>
                <div className="text-sm text-gray-700 mb-3">
                  {hasPassword ? (
                    <div className="flex items-center gap-2">
                      <span className="text-green-600">✓ Password is set</span>
                    </div>
                  ) : (
                    <div className="text-gray-600">No password set - using login link authentication</div>
                  )}
                </div>
                <button
                  onClick={() => setIsPasswordModalOpen(true)}
                  className="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700"
                >
                  {hasPassword ? "Change Password" : "Set Password"}
                </button>
              </section>

              {visibleEmailTypes.length > 0 && (
                <section className="mb-6">
                  <h2 className="text-lg font-semibold mb-1">Email Preferences</h2>
                  <div className="space-y-3">
                    {visibleEmailTypes.map((category) => {
                      const config = emailCategoryConfig[category];
                      return (
                        <div key={category} className="flex items-start gap-2">
                          <input
                            id={`emailPreference-${category}`}
                            type="checkbox"
                            checked={emailPreferences[category] !== false}
                            onChange={(e) => handleEmailPreferenceChange(category, e.target.checked)}
                            className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <div className="flex-1">
                            <label
                              htmlFor={`emailPreference-${category}`}
                              className="text-sm font-medium cursor-pointer"
                            >
                              {config.label}
                            </label>
                            <p className="text-xs text-gray-600 mt-0.5">{config.description}</p>
                          </div>
                        </div>
                      );
                    })}
                    <button
                      onClick={handleSaveProfile}
                      disabled={savingProfile}
                      className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50 hover:bg-blue-700 text-sm"
                    >
                      {savingProfile ? "Saving…" : "Save Email Preferences"}
                    </button>
                  </div>
                </section>
              )}

              <section className="mb-6">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-lg font-semibold">Chat Preferences</h2>
                  <button
                    type="button"
                    onClick={() => setShowModelInfo(true)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Model selection information"
                  >
                    <span className="material-icons text-lg">info_outline</span>
                  </button>
                </div>
                <p className="text-sm text-gray-600 mb-3">Choose your preferred AI model for chat responses.</p>
                <div className="space-y-2 mb-3">
                  {MODEL_OPTIONS.map((option) => (
                    <label key={option.value} className="flex items-center cursor-pointer">
                      <input
                        type="radio"
                        name="preferredModel"
                        value={option.value}
                        checked={preferredModel === option.value}
                        onChange={(e) => setPreferredModel(e.target.value)}
                        className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                      />
                      <span className="text-sm text-gray-700">{option.label}</span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={handleSaveChatPreferences}
                  disabled={savingChatPrefs}
                  className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50 hover:bg-blue-700 text-sm"
                >
                  {savingChatPrefs ? "Saving…" : "Save Chat Preferences"}
                </button>
              </section>

              <button onClick={handleLogout} className="rounded bg-gray-800 px-3 py-1 text-white disabled:opacity-50">
                Logout
              </button>
            </>
          )}
        </main>

        <EmailChangeModal
          isOpen={isEmailChangeModalOpen}
          onClose={() => setIsEmailChangeModalOpen(false)}
          currentEmail={email || ""}
          pendingEmail={pendingEmail}
          onEmailChangeRequested={handleEmailChangeRequested}
          onEmailChangeCancelled={handleEmailChangeCancelled}
        />

        <PasswordChangeModal
          isOpen={isPasswordModalOpen}
          onClose={() => setIsPasswordModalOpen(false)}
          hasPassword={hasPassword}
          onPasswordChanged={handlePasswordChanged}
        />

        {/* AI Model Info Modal */}
        {showModelInfo && (
          <>
            <div
              className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100]"
              onClick={() => setShowModelInfo(false)}
              aria-hidden="true"
            />
            <div className="fixed z-[101] top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white p-6 rounded-xl shadow-lg max-w-md w-full mx-4">
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-lg font-semibold">AI Model Selection</h3>
                <button
                  onClick={() => setShowModelInfo(false)}
                  className="text-gray-500 hover:text-gray-700"
                  aria-label="Close"
                >
                  <span className="material-icons">close</span>
                </button>
              </div>

              <div className="space-y-4">
                <p className="text-sm text-gray-600">
                  Different AI models have different strengths. You can choose which model generates responses to your
                  questions.
                </p>

                <div>
                  <h4 className="font-medium mb-2 text-sm">Why try different models?</h4>
                  <ul className="text-sm text-gray-600 space-y-1 list-disc list-inside">
                    <li>Some models are faster, others are more thorough</li>
                    <li>Different models may interpret questions differently</li>
                    <li>Some models excel at creative responses, others at factual accuracy</li>
                    <li>You can experiment to find which model works best for your needs</li>
                  </ul>
                </div>
              </div>
            </div>
          </>
        )}
      </Layout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async () => {
  try {
    const siteConfig = await loadSiteConfig();
    if (!siteConfig?.requireLogin) {
      return { notFound: true };
    }
    return { props: { siteConfig } } as any;
  } catch (error) {
    console.error("Failed to load site config for settings page:", error);
    return { notFound: true };
  }
};
