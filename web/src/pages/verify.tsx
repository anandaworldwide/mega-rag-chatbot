// Activation page: consumes token/email from query, calls /api/verifyMagicLink, sets session cookie
import React, { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import type { EmailCategory, EmailPreferences } from "@/types/user";

export default function VerifyPage() {
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
          // Handle specific error cases
          if (data?.errorCode === "ALREADY_ACTIVATED") {
            setStatus("already-activated");
            setErrorCode(data.errorCode);
            setMessage(data.error || "Account already activated");
          } else {
            throw new Error(data?.error || "Activation failed");
          }
        } else {
          // Pre-populate names if available from approval request
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

  // After profile save, redirect to home page after 2 seconds
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

  return (
    <>
      <Head>
        <title>Verify Account</title>
      </Head>
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-2xl font-semibold mb-4">Account Verification</h1>
        {status === "idle" || status === "activating" ? (
          <div className="text-sm text-gray-700">Verifying your link…</div>
        ) : null}
        {status === "collecting" ? (
          <form onSubmit={onSubmitName} className="space-y-4">
            <p className="text-sm text-gray-700">Welcome! Please tell us your name.</p>
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
                required
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
                required
              />
            </div>
            {enabledEmailTypes.length > 0 ? (
              <section className="rounded border border-gray-200 p-3">
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
              className="inline-flex items-center rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
            >
              Continue
            </button>
          </form>
        ) : null}
        {status === "saving" && <div>Saving your profile…</div>}
        {status === "success" ? (
          <div className="rounded border border-green-300 bg-green-50 p-3 text-sm mb-3">
            {message}
            <div className="mt-1">Redirecting…</div>
          </div>
        ) : null}
        {status === "already-activated" ? (
          <div className="rounded border border-blue-300 bg-blue-50 p-3 text-sm mb-3">
            <div className="font-medium mb-2">Account Already Activated</div>
            <p className="mb-3">Your account has already been activated and is ready to use.</p>
            <div>
              <p className="mb-3">Please log in with your email address to access your account.</p>
              <button
                onClick={() => router.push("/login")}
                className="inline-flex items-center rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              >
                Go to Login Page
              </button>
            </div>
          </div>
        ) : null}
        {status === "error" ? (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm mb-3">{message}</div>
        ) : null}
      </main>
    </>
  );
}
