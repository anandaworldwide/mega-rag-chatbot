import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { SiteConfig } from "@/types/siteConfig";
import AuthLayout from "@/components/AuthLayout";

interface ForgotPasswordProps {
  siteConfig: SiteConfig | null;
}

export default function ForgotPasswordPage({ siteConfig }: ForgotPasswordProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (router.isReady && router.query.email && typeof router.query.email === "string") {
      setEmail(decodeURIComponent(router.query.email));
    }
  }, [router.isReady, router.query.email]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email) {
      setError("Email is required");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch("/api/auth/requestPasswordReset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        setSuccess(true);
        setIsSubmitting(false);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to send reset link");
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error("Forgot password error:", error);
      setError("An error occurred. Please try again.");
      setIsSubmitting(false);
    }
  };

  if (success) {
    return (
      <AuthLayout siteConfig={siteConfig} title="Check Your Email">
        <div className="p-8">
          <h1 className="mb-4 text-2xl font-semibold text-green-600 lg:text-left">Check Your Email</h1>
          <p className="mb-4 text-gray-700 lg:text-left">
            If an account exists with that email address, a password reset link has been sent.
          </p>
          <p className="mb-6 text-gray-600 text-sm lg:text-left">
            The link will expire in one hour. If you don&apos;t see the email, check your spam folder.
          </p>
          <Link
            href="/login"
            className="block w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200 text-center"
          >
            Back to Login
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout siteConfig={siteConfig} title="Forgot Password">
      <div className="p-8">
        <h1 className="mb-3 text-3xl font-bold text-gray-900 lg:text-[32px] lg:leading-tight lg:text-left">
          Forgot Your Password?
        </h1>
        <p className="mb-6 text-gray-600 lg:text-left">
          Enter your email address and we&apos;ll send you a link to reset your password.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label htmlFor="email" id="forgot-email-label" className="block text-sm font-medium text-gray-700 mb-2">
              Email Address
            </label>
            <div className="relative">
              <input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-labelledby="forgot-email-label"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 pr-11 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 outline-none"
                placeholder="Enter your email"
              />
              <span
                className="material-icons absolute right-3 top-1/2 -translate-y-1/2 text-[#8b3a3a] pointer-events-none"
                aria-hidden="true"
              >
                mail
              </span>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-600 text-sm">{error}</p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <button
              type="submit"
              className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Sending..." : "Send Reset Link"}
            </button>
            <Link
              href="/login"
              className="w-full py-2 px-4 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-center"
            >
              Back to Login
            </Link>
          </div>
        </form>
      </div>
    </AuthLayout>
  );
}

export async function getServerSideProps() {
  const { loadSiteConfigSync } = await import("@/utils/server/loadSiteConfig");
  const siteConfig = loadSiteConfigSync();

  return {
    props: {
      siteConfig,
    },
  };
}
