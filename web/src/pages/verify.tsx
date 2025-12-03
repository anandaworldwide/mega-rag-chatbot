// Activation page: consumes token/email from query, calls /api/verifyMagicLink, sets session cookie
import React, { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";

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
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
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
