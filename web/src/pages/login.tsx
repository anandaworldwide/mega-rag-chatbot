import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { SiteConfig } from "@/types/siteConfig";
import { getSiteName, getTagline } from "@/utils/client/siteConfig";
import Image from "next/image";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import AdminApproverSelector from "@/components/AdminApproverSelector";
import FeedbackButton from "@/components/FeedbackButton";
import FeedbackModal from "@/components/FeedbackModal";

interface LoginProps {
  siteConfig: SiteConfig | null;
}

export default function Login({ siteConfig }: LoginProps) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "password" | "request-approval">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [lastSendType, setLastSendType] = useState<"login" | "activation" | null>(null);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  // Tick countdown while active; when it reaches 0, re-enable button
  useEffect(() => {
    if (!emailSent) return;
    if (resendSeconds <= 0) {
      setEmailSent(false);
      return;
    }
    const t = setTimeout(() => setResendSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearTimeout(t);
  }, [emailSent, resendSeconds]);

  // Desktop-only autofocus for the email field on initial email step
  useEffect(() => {
    if (step !== "email") return;
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const isDesktop = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (isDesktop && emailInputRef.current) {
      emailInputRef.current.focus();
    }
  }, [step]);

  // Desktop-only autofocus for the password field when on password step
  useEffect(() => {
    if (step !== "password") return;
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const isDesktop = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (isDesktop && passwordInputRef.current) {
      passwordInputRef.current.focus();
    }
  }, [step]);

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setIsSubmitting(true);

    if (!email.trim()) {
      setError("Email cannot be empty");
      setIsSubmitting(false);
      return;
    }

    try {
      // Check if user has password set
      const checkRes = await fetchWithAuth("/api/auth/checkAuthMethod", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });

      if (checkRes.ok) {
        const checkData = await checkRes.json();

        if (checkData.hasPassword) {
          // User has password - show password field
          setStep("password");
          setIsSubmitting(false);
          return;
        }
      }

      // User doesn't have password or check failed - proceed with magic link flow
      const res = await fetchWithAuth("/api/auth/requestLoginLink", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          redirect:
            typeof window !== "undefined"
              ? new URLSearchParams(window.location.search).get("redirect") || undefined
              : undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.message === "login-link-sent") {
          setInfo("We sent you a sign-in link. Please check your email.");
          setEmailSent(true);
          setResendSeconds(60);
          setLastSendType("login");
          setIsSubmitting(false);
          return;
        }
        if (data.message === "activation-resent") {
          setInfo("We re-sent your activation link. Please check your email.");
          setEmailSent(true);
          setResendSeconds(60);
          setLastSendType("activation");
          setIsSubmitting(false);
          return;
        }
        if (data.next === "request-approval") {
          setStep("request-approval");
          setIsSubmitting(false);
          return;
        }
        setInfo("Check your email for further instructions.");
        setEmailSent(true);
        setResendSeconds(60);
        setLastSendType("login");
        setIsSubmitting(false);
      } else if (res.status === 429) {
        setError("Too many attempts. Please try again later.");
        setIsSubmitting(false);
      } else {
        const errorData = await res.json();
        setError(errorData.error || "Something went wrong");
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error("Login error:", error);
      setError("An error occurred. Please try again.");
      setIsSubmitting(false);
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setIsSubmitting(true);

    if (!password.trim()) {
      setError("Password cannot be empty");
      setIsSubmitting(false);
      return;
    }

    try {
      const res = await fetchWithAuth("/api/auth/loginWithPassword", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        // Redirect to chat or original destination
        const redirect =
          typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("redirect") : null;
        const action = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("action") : null;
        
        // If action is 'clone', redirect back to the share page where the clone will be triggered
        if (action === "clone" && redirect) {
          router.push(redirect);
        } else {
          router.push(redirect || "/");
        }
      } else if (res.status === 429) {
        setError("Too many attempts. Please try again later.");
        setIsSubmitting(false);
      } else {
        const errorData = await res.json();
        setError(errorData.error || "Invalid email or password");
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error("Password login error:", error);
      setError("An error occurred. Please try again.");
      setIsSubmitting(false);
    }
  };

  const useMagicLinkInstead = async () => {
    setError("");
    setInfo("");
    setIsSubmitting(true);

    try {
      const res = await fetchWithAuth("/api/auth/requestLoginLink", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          redirect:
            typeof window !== "undefined"
              ? new URLSearchParams(window.location.search).get("redirect") || undefined
              : undefined,
        }),
      });

      if (res.ok) {
        setInfo("We sent you a sign-in link. Please check your email.");
        setEmailSent(true);
        setResendSeconds(60);
        setLastSendType("login");
        setStep("email");
        setIsSubmitting(false);
      } else {
        const errorData = await res.json();
        setError(errorData.error || "Something went wrong");
        setIsSubmitting(false);
      }
    } catch (error) {
      console.error("Magic link error:", error);
      setError("An error occurred. Please try again.");
      setIsSubmitting(false);
    }
  };

  const handleApprovalSuccess = () => {
    router.push("/request-submitted");
  };

  const handleApprovalError = (errorMessage: string) => {
    setError(errorMessage);
  };

  const handleBackToEmail = () => {
    setStep("email");
    setError("");
    setInfo("");
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
      {siteConfig?.loginImage && (
        <div className="flex flex-col items-center mb-6 w-full max-w-md">
          <Image
            src={`/${siteConfig.loginImage}`}
            alt="Login Image"
            width={250}
            height={250}
            className="w-full h-auto object-contain"
          />
        </div>
      )}
      <div className="p-6 bg-white rounded shadow-md max-w-md w-full">
        <h1 className="mb-4 text-2xl">Welcome to {getSiteName(siteConfig)}!</h1>
        <p className="mb-4">{getTagline(siteConfig)}</p>

        {step === "email" && (
          <form onSubmit={submitEmail} aria-busy={isSubmitting}>
            <div className="mb-4">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                ref={emailInputRef}
                className="p-2 border border-gray-300 rounded w-full"
                placeholder="Enter your email"
              />
            </div>

            {error && <p className="text-red-500 mb-2">{error}</p>}
            {info && (
              <p className="text-green-600 mb-2" aria-live="polite">
                {info}
              </p>
            )}

            <div className="flex items-center justify-between mt-4">
              <button
                type="submit"
                className="p-2 bg-blue-500 text-white rounded disabled:opacity-60"
                disabled={isSubmitting || emailSent}
              >
                {isSubmitting ? "Processing…" : emailSent ? "Check your email" : "Continue"}
              </button>
              {emailSent && resendSeconds > 0 && (
                <span className="ml-3 text-sm text-gray-600" aria-live="polite">
                  You can resend the {lastSendType === "activation" ? "invitation email" : "login link"} in{" "}
                  {resendSeconds}s
                </span>
              )}
            </div>
          </form>
        )}

        {step === "password" && (
          <form onSubmit={submitPassword} aria-busy={isSubmitting}>
            <p className="mb-4 text-sm text-gray-600">
              Enter your password for <strong>{email}</strong>
            </p>

            <div className="mb-4">
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  ref={passwordInputRef}
                  className="p-2 border border-gray-300 rounded w-full pr-16"
                  placeholder="Enter your password"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {error && <p className="text-red-500 mb-4 text-sm">{error}</p>}
            {info && (
              <p className="text-green-600 mb-4 text-sm" aria-live="polite">
                {info}
              </p>
            )}

            <div className="flex flex-col gap-3">
              <button
                type="submit"
                className="w-full p-2 bg-blue-500 text-white rounded disabled:opacity-60 hover:bg-blue-600"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Logging in..." : "Log In"}
              </button>
              <div className="flex flex-col gap-2 text-sm text-center">
                <button
                  type="button"
                  onClick={useMagicLinkInstead}
                  className="text-blue-500 hover:underline"
                  disabled={isSubmitting}
                >
                  Email me a Magic Login Link
                </button>
                <a
                  href={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                  className="text-blue-500 hover:underline"
                >
                  Forgot password?
                </a>
              </div>
            </div>
          </form>
        )}

        {step === "request-approval" && (
          <div>
            <AdminApproverSelector
              requesterEmail={email}
              siteConfig={siteConfig}
              onSuccess={handleApprovalSuccess}
              onError={handleApprovalError}
              onBack={handleBackToEmail}
            />

            <div className="mt-4 p-3 bg-gray-50 rounded text-sm text-gray-600">
              <p>
                Don&apos;t see an admin for your area? Please{" "}
                <button
                  type="button"
                  onClick={() => setShowFeedbackModal(true)}
                  className="text-blue-500 underline hover:text-blue-700"
                >
                  click here
                </button>{" "}
                to contact us directly and request an account.
              </p>
            </div>

            {error && <p className="text-red-500 mt-4">{error}</p>}
            {info && (
              <p className="text-green-600 mt-4" aria-live="polite">
                {info}
              </p>
            )}
          </div>
        )}
      </div>
      {step === "email" && siteConfig?.siteId === "ananda" && (
        <p className="mt-4 text-center text-sm text-gray-700">
          If your email isn&apos;t recognized, we&apos;ll help you request access from an admin.
        </p>
      )}
      {siteConfig?.siteId === "jairam" && (
        <p className="mt-4 text-center">For access, please contact the Free Joe Hunt team.</p>
      )}
      <p className="mt-4">
        <a href="https://github.com/anandaworldwide/mega-rag-chatbot" className="text-blue-400 hover:underline mx-2">
          Open Source Project
        </a>
      </p>

      {/* Feedback Button */}
      <FeedbackButton siteConfig={siteConfig} onClick={() => setShowFeedbackModal(true)} />

      {/* Feedback Modal */}
      {showFeedbackModal && (
        <FeedbackModal isOpen={showFeedbackModal} onClose={() => setShowFeedbackModal(false)} siteConfig={siteConfig} />
      )}
    </div>
  );
}
