// Activation page: consumes token/email from query, calls /api/verifyMagicLink, sets session cookie
import React, { useEffect, useState } from "react";
import { useRouter } from "next/router";
import type { GetServerSideProps } from "next";
import type { EmailCategory, EmailPreferences } from "@/types/user";
import type { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import AuthLayout from "@/components/AuthLayout";

interface VerifyPageProps {
  siteConfig: SiteConfig | null;
}

export default function VerifyPage({ siteConfig }: VerifyPageProps) {
  const router = useRouter();
  const { token, email } = router.query as { token?: string; email?: string };
  const [status, setStatus] = useState<
    "idle" | "activating" | "collecting" | "saving" | "success" | "error" | "already-activated"
  >("idle");
  const [message, setMessage] = useState<string>("");
  const [, setErrorCode] = useState<string>("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [enabledEmailTypes, setEnabledEmailTypes] = useState<EmailCategory[]>([]);
  const [emailPreferences, setEmailPreferences] = useState<EmailPreferences>({
    newsletters: true,
    onboarding: true,
    reengagement: true,
    specialDay: true,
    nps: true,
  });

  const emailCategoryConfig: Record<EmailCategory, { label: string; description: string }> = {
    newsletters: {
      label: "Newsletter updates",
      description: "Stay inspired with curated updates and the newest content worth your attention.",
    },
    onboarding: {
      label: "Getting started tips",
      description: "Get short guidance emails that help you quickly get more value from the chatbot.",
    },
    reengagement: {
      label: "Return reminders",
      description: "Receive a gentle nudge with fresh highlights whenever you have been away for a while.",
    },
    specialDay: {
      label: "Special occasions",
      description: "Get special-day messages with meaningful content tied to important Ananda dates and events.",
    },
    nps: {
      label: "Feedback surveys",
      description: "Share quick feedback once every six months so we can keep improving what you receive.",
    },
  };

  useEffect(() => {
    if (!token || !email || status !== "idle") return;
    setStatus("activating");
    (async () => {
      try {
        const res = await fetch("/api/verifyMagicLink", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token, email: decodeURIComponent(email) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (data?.errorCode === "ALREADY_ACTIVATED") {
            setStatus("already-activated");
            setErrorCode(data.errorCode);
            setMessage(data.error || "Account already activated");
          } else {
            throw new Error(data?.error || "Activation failed");
          }
        } else {
          if (data?.firstName) {
            setFirstName(data.firstName);
          }
          if (data?.lastName) {
            setLastName(data.lastName);
          }
          if (Array.isArray(data?.enabledEmailTypes)) {
            setEnabledEmailTypes(data.enabledEmailTypes as EmailCategory[]);
          }
          setStatus("collecting");
          setMessage("");
        }
      } catch (e: any) {
        setStatus("error");
        setMessage(e?.message || "Activation failed");
      }
    })();
  }, [token, email, status]);

  useEffect(() => {
    if (status !== "success") return;
    const t = setTimeout(() => {
      router.replace("/");
    }, 2000);
    return () => clearTimeout(t);
  }, [status, router]);

  // SECURITY: Do NOT auto-redirect for failed activation attempts
  // Only redirect after successful activation (status === "success")
  // Failed activations (like already-activated) should show error message only

  async function onSubmitName(e: React.FormEvent) {
    e.preventDefault();
    try {
      setStatus("saving");
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          emailPreferences: enabledEmailTypes.reduce((acc, category) => {
            acc[category] = emailPreferences[category] !== false;
            return acc;
          }, {} as Partial<EmailPreferences>),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to save profile");
      setStatus("success");
      setMessage("Your account has been activated.");
    } catch (e: any) {
      setStatus("error");
      setMessage(e?.message || "Failed to save profile");
    }
  }

  function handleEmailPreferenceChange(category: EmailCategory, value: boolean) {
    setEmailPreferences((prev) => ({
      ...prev,
      [category]: value,
    }));
  }

  function handleUncheckAll() {
    if (enabledEmailTypes.length === 0) return;
    setEmailPreferences((prev) => {
      const updated = { ...prev };
      enabledEmailTypes.forEach((category) => {
        updated[category] = false;
      });
      return updated;
    });
  }

  function handleCheckAll() {
    if (enabledEmailTypes.length === 0) return;
    setEmailPreferences((prev) => {
      const updated = { ...prev };
      enabledEmailTypes.forEach((category) => {
        updated[category] = true;
      });
      return updated;
    });
  }

  const verificationHeadline = siteConfig?.name
    ? `Account verification for ${siteConfig.name}.`
    : "Account verification";

  return (
    <AuthLayout siteConfig={siteConfig} title="Verify Account">
      <div className="p-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-6 lg:text-[32px] lg:leading-tight lg:text-left">
          {verificationHeadline}
        </h1>
        {status === "idle" || status === "activating" ? (
          <div className="text-sm text-gray-700">Verifying your link…</div>
        ) : null}
        {status === "collecting" ? (
          <form onSubmit={onSubmitName} className="space-y-4">
            <p className="text-sm text-gray-700">Welcome! Please tell us your name.</p>
            <div>
              <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-2">
                First name
              </label>
              <input
                id="firstName"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 outline-none"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="First name"
                required
              />
            </div>
            <div>
              <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-2">
                Last name
              </label>
              <input
                id="lastName"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 outline-none"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Last name"
                required
              />
            </div>
            {enabledEmailTypes.length > 0 ? (
              <section className="rounded-lg border border-gray-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">Email preferences</p>
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={handleUncheckAll}
                      className="text-gray-600 hover:text-gray-800 underline"
                    >
                      Uncheck all
                    </button>
                    <span className="text-gray-400">|</span>
                    <button
                      type="button"
                      onClick={handleCheckAll}
                      className="text-gray-600 hover:text-gray-800 underline"
                    >
                      Check all
                    </button>
                  </div>
                </div>
                <p className="mb-3 text-xs text-gray-600">
                  Pick the updates you want. You can change these anytime in Settings.
                </p>
                <div className="space-y-3">
                  {enabledEmailTypes.map((category) => {
                    const config = emailCategoryConfig[category];
                    return (
                      <div key={category} className="flex items-start gap-2">
                        <input
                          id={`activation-emailPreference-${category}`}
                          type="checkbox"
                          checked={emailPreferences[category] !== false}
                          onChange={(e) => handleEmailPreferenceChange(category, e.target.checked)}
                          className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <div className="flex-1">
                          <label
                            htmlFor={`activation-emailPreference-${category}`}
                            className="text-sm font-medium cursor-pointer"
                          >
                            {config.label}
                          </label>
                          <p className="text-xs text-gray-600 mt-0.5">{config.description}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
            <button
              type="submit"
              className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
            >
              Continue
            </button>
          </form>
        ) : null}
        {status === "saving" && <div className="text-sm text-gray-700">Saving your profile…</div>}
        {status === "success" ? (
          <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm mb-3">
            {message}
            <div className="mt-1">Redirecting…</div>
          </div>
        ) : null}
        {status === "already-activated" ? (
          <div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm mb-3">
            <div className="font-medium mb-2">Account Already Activated</div>
            <p className="mb-3">Your account has already been activated and is ready to use.</p>
            <div>
              <p className="mb-3">Please log in with your email address to access your account.</p>
              <button
                onClick={() => router.push("/login")}
                className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200"
              >
                Go to Login Page
              </button>
            </div>
          </div>
        ) : null}
        {status === "error" ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm mb-3">{message}</div>
        ) : null}
      </div>
    </AuthLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async () => {
  const siteConfig = await loadSiteConfig();
  return {
    props: {
      siteConfig,
    },
  };
};
