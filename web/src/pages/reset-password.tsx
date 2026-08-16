import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { SiteConfig } from "@/types/siteConfig";
import { PasswordValidation } from "@/types/user";
import { PasswordStrengthIndicator } from "@/components/PasswordStrengthIndicator";
import AuthLayout from "@/components/AuthLayout";

interface ResetPasswordProps {
  siteConfig: SiteConfig | null;
}

export default function ResetPasswordPage({ siteConfig }: ResetPasswordProps) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validation, setValidation] = useState<PasswordValidation | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  useEffect(() => {
    if (router.isReady) {
      const { token: tokenParam, email: emailParam } = router.query;
      if (typeof tokenParam === "string") setToken(tokenParam);
      if (typeof emailParam === "string") setEmail(emailParam);
    }
  }, [router.isReady, router.query]);

  useEffect(() => {
    if (!password) {
      setValidation(null);
      return;
    }

    const requirements = {
      minLength: password.length >= 8,
      hasUppercase: /[A-Z]/.test(password),
      hasLowercase: /[a-z]/.test(password),
      hasNumber: /[0-9]/.test(password),
    };

    const allMet =
      requirements.minLength && requirements.hasUppercase && requirements.hasLowercase && requirements.hasNumber;

    setValidation({
      valid: allMet,
      requirements,
    });
  }, [password]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!token || !email) {
      setError("Invalid reset link");
      return;
    }

    if (!password) {
      setError("Password is required");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (!validation?.valid) {
      setError("Password does not meet all requirements");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch("/api/auth/resetPassword", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, email, password }),
      });

      if (res.ok) {
        setSuccess(true);
        setIsSubmitting(false);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to reset password");
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error("Reset password error:", error);
      setError("An error occurred. Please try again.");
      setIsSubmitting(false);
    }
  };

  if (success) {
    return (
      <AuthLayout siteConfig={siteConfig} title="Password Reset Successfully">
        <div className="p-8">
          <h1 className="mb-4 text-2xl font-semibold text-green-600 lg:text-left">Password Reset Successfully!</h1>
          <p className="mb-6 text-gray-700 lg:text-left">
            Your password has been changed. You can now log in with your new password.
          </p>
          <Link
            href="/login"
            className="block w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200 text-center"
          >
            Go to Login
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout siteConfig={siteConfig} title="Reset Password">
      <div className="p-8">
        <h1 className="mb-3 text-3xl font-bold text-gray-900 lg:text-[32px] lg:leading-tight lg:text-left">
          Reset Your Password
        </h1>
        <p className="mb-6 text-gray-600 lg:text-left">Enter your new password below.</p>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label htmlFor="password" id="reset-password-label" className="block text-sm font-medium text-gray-700 mb-2">
              New Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 pr-16 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 outline-none"
                placeholder="Enter your new password"
                autoComplete="new-password"
                aria-labelledby="reset-password-label"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <PasswordStrengthIndicator validation={validation} password={password} />
          </div>

          <div className="mb-5">
            <label htmlFor="confirmPassword" id="reset-confirm-password-label" className="block text-sm font-medium text-gray-700 mb-2">
              Confirm Password
            </label>
            <div className="relative">
              <input
                id="confirmPassword"
                name="confirmPassword"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 pr-16 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 outline-none"
                placeholder="Confirm your new password"
                autoComplete="new-password"
                aria-labelledby="reset-confirm-password-label"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors"
                aria-label={showConfirmPassword ? "Hide password" : "Show password"}
              >
                {showConfirmPassword ? "Hide" : "Show"}
              </button>
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
              disabled={isSubmitting || !validation?.valid}
            >
              {isSubmitting ? "Resetting Password..." : "Reset Password"}
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
