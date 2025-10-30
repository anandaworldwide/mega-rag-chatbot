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
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full border border-gray-100 transform transition-all duration-300 hover:shadow-2xl overflow-hidden">
        {siteConfig?.loginImage && (
          <div className="flex flex-col items-center pt-8 px-8 pb-4">
            <div className="relative">
              <Image
                src={`/${siteConfig.loginImage}`}
                alt="Login Image"
                width={320}
                height={320}
                className="w-full h-auto object-contain drop-shadow-lg"
              />
            </div>
          </div>
        )}
        <div
          className={`text-center ${siteConfig?.loginImage ? "px-8 pb-6" : "p-8"} ${siteConfig?.loginImage ? "" : "mb-6"}`}
        >
          <h1 className="mb-3 text-3xl font-bold text-gray-900">Welcome to {getSiteName(siteConfig)}!</h1>
          <p className="text-lg text-gray-600 leading-relaxed">{getTagline(siteConfig)}</p>
        </div>
        <div className="px-8 pb-8">
          {step === "email" && (
            <form onSubmit={submitEmail} aria-busy={isSubmitting}>
              <div className="mb-5">
                <label htmlFor="email-input" className="block text-sm font-medium text-gray-700 mb-2">
                  Email Address
                </label>
                <input
                  id="email-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  ref={emailInputRef}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 outline-none"
                  placeholder="Enter your email"
                />
              </div>

              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-600 text-sm">{error}</p>
                </div>
              )}
              {info && (
                <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg" aria-live="polite">
                  <p className="text-green-700 text-sm">{info}</p>
                </div>
              )}

              <div className="flex flex-col gap-3 mt-6">
                <button
                  type="submit"
                  className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
                  disabled={isSubmitting || emailSent}
                >
                  {isSubmitting ? "Processing…" : emailSent ? "Check your email" : "Continue"}
                </button>
                {emailSent && resendSeconds > 0 && (
                  <p className="text-center text-sm text-gray-600" aria-live="polite">
                    You can resend the {lastSendType === "activation" ? "invitation email" : "login link"} in{" "}
                    <span className="font-semibold text-blue-600">{resendSeconds}s</span>
                  </p>
                )}
              </div>
            </form>
          )}

          {step === "password" && (
            <form onSubmit={submitPassword} aria-busy={isSubmitting}>
              <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm text-gray-700">
                  Enter your password for <strong className="text-gray-900">{email}</strong>
                </p>
              </div>

              <div className="mb-5">
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
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg pr-16 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 outline-none"
                    placeholder="Enter your password"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-600 text-sm">{error}</p>
                </div>
              )}
              {info && (
                <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg" aria-live="polite">
                  <p className="text-green-700 text-sm">{info}</p>
                </div>
              )}

              <div className="flex flex-col gap-3">
                <button
                  type="submit"
                  className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Logging in..." : "Log In"}
                </button>
                <div className="flex flex-col gap-2 text-sm text-center pt-2">
                  <button
                    type="button"
                    onClick={useMagicLinkInstead}
                    className="text-blue-600 hover:text-blue-800 font-medium transition-colors"
                    disabled={isSubmitting}
                  >
                    Email me a Magic Login Link
                  </button>
                  <a
                    href={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                    className="text-blue-600 hover:text-blue-800 transition-colors"
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

              <div className="mt-6 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg text-sm text-gray-700">
                <p>
                  Don&apos;t see an admin for your area? Please{" "}
                  <button
                    type="button"
                    onClick={() => setShowFeedbackModal(true)}
                    className="text-blue-600 font-semibold hover:text-blue-800 underline transition-colors"
                  >
                    click here
                  </button>{" "}
                  to contact us directly and request an account.
                </p>
              </div>

              {error && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-600 text-sm">{error}</p>
                </div>
              )}
              {info && (
                <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg" aria-live="polite">
                  <p className="text-green-700 text-sm">{info}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {step === "email" && siteConfig?.siteId === "ananda" && (
        <p className="mt-6 text-center text-sm text-gray-600 max-w-md px-4">
          If your email isn&apos;t recognized, we&apos;ll help you request access from an admin.
        </p>
      )}
      {siteConfig?.siteId === "jairam" && (
        <p className="mt-6 text-center text-sm text-gray-600 max-w-md px-4">
          For access, please contact the Free Joe Hunt team.
        </p>
      )}
      <p className="mt-6">
        <a
          href="https://github.com/anandaworldwide/mega-rag-chatbot"
          className="text-blue-600 hover:text-blue-800 text-sm font-medium transition-colors"
        >
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
