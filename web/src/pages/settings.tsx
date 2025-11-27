// Settings page: shows user email and a logout button
import React, { useEffect, useState } from "react";
import Head from "next/head";
import Layout from "@/components/layout";
import type { GetServerSideProps } from "next";
import type { SiteConfig } from "@/types/siteConfig";

import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

import { EmailChangeModal } from "@/components/EmailChangeModal";
import { PasswordChangeModal } from "@/components/PasswordChangeModal";

export default function SettingsPage({ siteConfig }: { siteConfig: SiteConfig | null }) {
  const [email, setEmail] = useState<string | null>(null);
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [newsletterSubscribed, setNewsletterSubscribed] = useState<boolean>(true);

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [role, setRole] = useState<string>("user");
  const [savingProfile, setSavingProfile] = useState(false);

  // Email change state
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [isEmailChangeModalOpen, setIsEmailChangeModalOpen] = useState(false);

  // Password management state
  const [hasPassword, setHasPassword] = useState<boolean>(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);

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
            setNewsletterSubscribed(
              typeof profile?.newsletterSubscribed === "boolean" ? profile.newsletterSubscribed : true
            );
            setPendingEmail(typeof profile?.pendingEmail === "string" ? profile.pendingEmail : null);
            setHasPassword(typeof profile?.hasPassword === "boolean" ? profile.hasPassword : false);
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

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    try {
      setSavingProfile(true);
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          newsletterSubscribed: newsletterSubscribed,
        }),
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
                  <div className="flex items-center gap-2">
                    <input
                      id="newsletterSubscribed"
                      type="checkbox"
                      checked={newsletterSubscribed}
                      onChange={(e) => setNewsletterSubscribed(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <label htmlFor="newsletterSubscribed" className="text-sm font-medium">
                      Subscribe to periodic newsletter updates
                    </label>
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
