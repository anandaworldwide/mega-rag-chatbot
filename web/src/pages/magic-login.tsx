// Magic Login page: consumes token/email from query, calls /api/auth/magicLogin, sets session cookie
import React, { useEffect, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";

export default function MagicLoginPage() {
  const router = useRouter();
  const { token, email, redirect } = router.query as { token?: string; email?: string; redirect?: string };
  const [status, setStatus] = useState<"idle" | "working" | "success" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!token || !email || status !== "idle") return;
    setStatus("working");
    (async () => {
      try {
        const res = await fetch("/api/auth/magicLogin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token, email: decodeURIComponent(email) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Sign-in failed");
        setStatus("success");
        setMessage("You're signed in. Redirecting…");

        // Force token manager to refresh and recognize the new authentication state
        const { initializeTokenManager } = await import("@/utils/client/tokenManager");
        await initializeTokenManager();

        // Redirect to intended page or home after a short delay
        let target = "/";
        if (typeof redirect === "string") {
          // If redirect came double-encoded (e.g., %252Fanswers?page%3D2), decode twice defensively
          let decoded = redirect;
          try {
            decoded = decodeURIComponent(decoded);
          } catch {}
          try {
            decoded = decodeURIComponent(decoded);
          } catch {}
          // Only allow internal redirects
          if (decoded.startsWith("/")) target = decoded;
        }
        setTimeout(() => router.replace(target), 800);
      } catch (e: any) {
        setStatus("error");
        setMessage(e?.message || "Sign-in failed");
      }
    })();
  }, [token, email, status, router, redirect]);

  return (
    <>
      <Head>
        <title>Login Link</title>
      </Head>
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-2xl font-semibold mb-4">Login Link</h1>
        {status === "idle" || status === "working" ? (
          <div className="text-sm text-gray-700">Signing you in…</div>
        ) : null}
        {status === "success" ? (
          <div className="rounded border border-green-300 bg-green-50 p-3 text-sm mb-3">{message}</div>
        ) : null}
        {status === "error" ? (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm mb-3">{message}</div>
        ) : null}
        {status === "success" ? (
          <div className="mt-4">
            <Link href="/" className="text-blue-600 underline">
              Go to Home
            </Link>
          </div>
        ) : null}
      </main>
    </>
  );
}
