// This component renders a contact/feedback form, handles form submission,
// and displays success or error messages to the user.

import { SiteConfig } from "@/types/siteConfig";
import React, { useState, useEffect } from "react";
import Head from "next/head";
import Layout from "@/components/layout";
import Link from "next/link";
import validator from "validator";
import { getToken } from "@/utils/client/tokenManager";
import { getSiteName } from "@/utils/client/siteConfig";

interface ContactProps {
  siteConfig: SiteConfig | null;
}

const Contact = ({ siteConfig }: ContactProps) => {
  // State for form fields and submission status
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Auto-fill user data for logged-in users
  useEffect(() => {
    const autoFillUserData = async () => {
      try {
        const token = await getToken();
        if (token) {
          setIsLoggedIn(true);

          // Fetch user profile if login is required
          if (siteConfig?.requireLogin) {
            const profileResponse = await fetch("/api/profile", {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            });

            if (profileResponse.ok) {
              const profileData = await profileResponse.json();
              if (profileData.firstName || profileData.lastName) {
                const nameParts = [profileData.firstName, profileData.lastName].filter(Boolean);
                const fullName = nameParts.join(" ");
                setName(fullName);
              }
              if (profileData.email) {
                setEmail(profileData.email);
              }
            }
          }
        }
      } catch (error) {
        // Silently fail - user can still fill form manually
        console.warn("Failed to auto-fill user data:", error);
      }
    };

    autoFillUserData();
  }, [siteConfig?.requireLogin]);

  // Validate form inputs
  const validateInputs = () => {
    if (!validator.isLength(name, { min: 1, max: 100 })) {
      setError("Name must be between 1 and 100 characters");
      return false;
    }
    if (!validator.isEmail(email)) {
      setError("Invalid email address");
      return false;
    }
    if (!validator.isLength(message, { min: 1, max: 1000 })) {
      setError("Message must be between 1 and 1000 characters");
      return false;
    }
    return true;
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    if (!validateInputs()) {
      setIsSubmitting(false);
      return;
    }

    try {
      // Get a token first
      const token = await getToken();

      const apiUrl = "/api/contact";
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, email, message }),
      });

      if (res.ok) {
        setIsSubmitted(true);
      } else {
        const data = await res.json();
        setError(data.message || "Failed to send message. Please try again later.");
      }
    } catch (error) {
      console.error("Error submitting contact form:", error);
      setError("Failed to send message. Please try again later.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Head>
        <title>Contact - {getSiteName(siteConfig)}</title>
      </Head>
      <Layout siteConfig={siteConfig}>
        <div className="container mx-auto p-4">
          <h1 className="text-2xl mb-4">Contact Us</h1>
          {/* Display error message if any */}
          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4" role="alert">
              <span className="block sm:inline">{error}</span>
            </div>
          )}
          {/* Contact form */}
          <form
            data-testid="contact-form"
            onSubmit={handleSubmit}
            className={`space-y-4 ${isSubmitted ? "opacity-50 pointer-events-none" : ""}`}
          >
            <div className="flex space-x-4">
              {/* Name input field */}
              <div className="w-1/2">
                <label htmlFor="name-input" id="name-input-label" className="block text-sm font-medium text-gray-700">
                  Name
                </label>
                <input
                  id="name-input"
                  name="name"
                  type="text"
                  autoComplete="name"
                  aria-labelledby="name-input-label"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={`mt-1 block w-full border rounded-md shadow-sm ${
                    isLoggedIn && siteConfig?.requireLogin
                      ? "bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed"
                      : "border-gray-300"
                  }`}
                  required
                  readOnly={isLoggedIn && siteConfig?.requireLogin}
                  disabled={isSubmitted || isSubmitting}
                  maxLength={100}
                />
              </div>
              {/* Email input field */}
              <div className="w-1/2">
                <label htmlFor="email-input" id="contact-email-label" className="block text-sm font-medium text-gray-700">
                  Email
                </label>
                <input
                  id="email-input"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-labelledby="contact-email-label"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`mt-1 block w-full border rounded-md shadow-sm ${
                    isLoggedIn && siteConfig?.requireLogin
                      ? "bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed"
                      : "border-gray-300"
                  }`}
                  required
                  readOnly={isLoggedIn && siteConfig?.requireLogin}
                  disabled={isSubmitted || isSubmitting}
                />
              </div>
            </div>
            {/* Message textarea */}
            <div>
              <label htmlFor="message-input" id="message-input-label" className="block text-sm font-medium text-gray-700">
                Message
              </label>
              <textarea
                id="message-input"
                name="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm h-48"
                required
                disabled={isSubmitted || isSubmitting}
                maxLength={1000}
                aria-labelledby="message-input-label"
              />
            </div>
            {/* Submit button */}
            <button
              type="submit"
              className="bg-blue-500 text-white px-4 py-2 rounded-md disabled:bg-blue-300"
              disabled={isSubmitted || isSubmitting}
            >
              {isSubmitting ? "Sending..." : "Send"}
            </button>
          </form>
          {/* Success message and homepage link */}
          {isSubmitted && (
            <div className="mt-8 text-center">
              <h2 className="text-xl font-semibold text-green-600 mb-4">Thanks, message sent!</h2>
              <Link
                href="/"
                className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 transition-colors"
              >
                Go to Homepage
              </Link>
            </div>
          )}
        </div>
      </Layout>
    </>
  );
};

export default Contact;
