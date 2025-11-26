import React, { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import type { GetServerSideProps, NextApiRequest } from "next";
import { AdminLayout } from "@/components/AdminLayout";
import { isAdminPageAllowed } from "@/utils/server/adminPageGate";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { SiteConfig } from "@/types/siteConfig";
import { validateEmailInput } from "@/utils/client/emailParser";
import { AdminAccessGuidelinesModal } from "@/components/AdminAccessGuidelinesModal";

interface AddUsersPageProps {
  siteConfig: SiteConfig | null;
}

export default function AddUsersPage({ siteConfig }: AddUsersPageProps) {
  const router = useRouter();
  const [emailInput, setEmailInput] = useState("");
  const [customMessage, setCustomMessage] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [adminFirstName, setAdminFirstName] = useState<string>("Admin");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"info" | "error">("info");
  const [jwt, setJwt] = useState<string | null>(null);
  const [showGuidelinesModal, setShowGuidelinesModal] = useState(false);

  // Local storage key for persisting custom message
  const CUSTOM_MESSAGE_STORAGE_KEY = "admin-invitation-custom-message";

  // Fetch admin's profile to get first name
  useEffect(() => {
    async function fetchAdminProfile() {
      try {
        const res = await fetch("/api/profile");
        if (res.ok) {
          const profile = await res.json();
          const firstName = profile?.firstName?.trim();
          if (firstName) {
            setAdminFirstName(firstName);
          }
        }
      } catch (error) {
        console.error("Failed to fetch admin profile:", error);
      }
    }

    fetchAdminProfile();
  }, []);

  // Load custom message from local storage and set default on mount
  useEffect(() => {
    // Try to load saved custom message from local storage
    const savedMessage = localStorage.getItem(CUSTOM_MESSAGE_STORAGE_KEY);

    if (savedMessage) {
      setCustomMessage(savedMessage);
    } else {
      // Use default message if no saved message exists
      const siteName = siteConfig?.shortname || siteConfig?.name || "our chatbot";
      const siteTagline = siteConfig?.tagline || "explore and discover answers to your questions";
      const defaultMessage = `Please join us in using ${siteName} to ${siteTagline.toLowerCase()}\n\nAums,\n${adminFirstName}`;
      setCustomMessage(defaultMessage);
    }
  }, [adminFirstName, siteConfig]);

  // Initialize JWT
  useEffect(() => {
    async function initJwt() {
      try {
        const res = await fetch("/api/web-token");
        if (res.ok) {
          const data = await res.json();
          setJwt(data.token);
        }
      } catch (error) {
        console.error("Failed to initialize JWT:", error);
      }
    }

    initJwt();
  }, []);

  // Save custom message to local storage when it changes
  const handleCustomMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newMessage = e.target.value;
    setCustomMessage(newMessage);

    if (newMessage.trim()) {
      localStorage.setItem(CUSTOM_MESSAGE_STORAGE_KEY, newMessage);
    }
  };

  // Shared function to handle token refresh and retry logic
  async function fetchWithTokenRefresh<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<{ data: T; refreshedToken?: string }> {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${jwt}`,
      },
    });

    if (res.status === 401) {
      // Token expired, try to refresh
      const tokenRes = await fetch("/api/web-token");
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        const newToken = tokenData.token;

        // Retry request with new token
        const retryRes = await fetch(url, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
          },
        });

        if (!retryRes.ok) {
          throw new Error(`API call failed after token refresh: ${retryRes.status}`);
        }

        const data = await retryRes.json();
        return { data: data as T, refreshedToken: newToken };
      } else {
        throw new Error("Failed to refresh token");
      }
    }

    if (!res.ok) {
      throw new Error(`API call failed: ${res.status}`);
    }

    const data = await res.json();
    return { data: data as T };
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!emailInput.trim()) {
      setValidationError("Please enter at least one email address");
      return;
    }

    const validation = validateEmailInput(emailInput);

    if (validation.validCount === 0) {
      setValidationError("No valid email addresses found");
      return;
    }

    if (validation.invalidEntries.length > 0) {
      setValidationError(
        `Invalid email format${validation.invalidEntries.length > 1 ? "s" : ""}: ${validation.invalidEntries.join(", ")}`
      );
      return;
    }

    // Check email limit (40 emails maximum)
    const EMAIL_LIMIT = 40;
    if (validation.validEmails.length > EMAIL_LIMIT) {
      setValidationError(
        `Maximum ${EMAIL_LIMIT} email addresses allowed. You entered ${validation.validEmails.length}.`
      );
      return;
    }

    setValidationError(null);
    setSubmitting(true);
    setMessage(null);

    try {
      const emails = validation.validEmails;
      const messageToSend = customMessage.trim() || undefined;

      let successCount = 0;
      let resentCount = 0;
      const alreadyActiveEmails: string[] = [];
      const errors: string[] = [];

      // Process emails in batches of 10 for better performance
      const BATCH_SIZE = 10;
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const batch = emails.slice(i, i + BATCH_SIZE);

        const promises = batch.map(async (email) => {
          try {
            const { data, refreshedToken } = await fetchWithTokenRefresh<{ message: string }>("/api/admin/addUser", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, customMessage: messageToSend }),
            });

            if (refreshedToken) {
              setJwt(refreshedToken);
            }

            return { email, success: true, message: data.message };
          } catch (error: any) {
            return { email, success: false, error: error.message };
          }
        });

        const results = await Promise.all(promises);

        results.forEach((result) => {
          if (result.success) {
            if (result.message === "already_active") {
              alreadyActiveEmails.push(result.email);
            } else if (result.message === "resent") {
              resentCount++;
            } else if (result.message === "created") {
              successCount++;
            } else {
              successCount++;
            }
          } else {
            errors.push(`${result.email}: ${result.error}`);
          }
        });
      }

      // Generate summary message
      const parts: string[] = [];
      if (successCount > 0) {
        parts.push(`${successCount} invitation${successCount === 1 ? "" : "s"} sent`);
      }
      if (resentCount > 0) {
        parts.push(`${resentCount} invitation${resentCount === 1 ? "" : "s"} resent`);
      }
      if (alreadyActiveEmails.length > 0) {
        const emailBullets = alreadyActiveEmails.map((email) => `• ${email}`).join("\n");
        parts.push(
          `${alreadyActiveEmails.length} user${alreadyActiveEmails.length === 1 ? " was" : "s were"} already active:\n${emailBullets}`
        );
      }

      if (parts.length > 0) {
        setMessage(parts.join(". "));
        setMessageType("info");
      }

      if (errors.length > 0) {
        if (parts.length === 0) {
          setMessage(`Failed to add users: ${errors.join("; ")}`);
          setMessageType("error");
        } else {
          setMessage(`${parts.join(". ")}. Errors: ${errors.join("; ")}`);
          setMessageType("info");
        }
      }

      // Clear the email input on success
      if (parts.length > 0 && errors.length === 0) {
        setEmailInput("");
      }
    } catch (e: any) {
      setMessage(e?.message || "Failed to add users");
      setMessageType("error");
    } finally {
      setSubmitting(false);
    }
  };

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Add Users</h1>
        <p className="text-sm text-gray-600 mt-1">Send invitation emails to new users</p>
      </div>

      {message && (
        <div
          className={`mb-4 rounded border p-3 text-sm whitespace-pre-line ${
            messageType === "error"
              ? "border-red-300 bg-red-50 text-red-800"
              : "border-blue-300 bg-blue-50 text-blue-800"
          }`}
        >
          {message}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6">
        <div className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="emails" className="block text-sm font-medium text-gray-700">
                Email Addresses <span className="text-red-500">*</span>
              </label>
              {siteConfig?.adminAccessGuidelines && (
                <button
                  type="button"
                  onClick={() => setShowGuidelinesModal(true)}
                  className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 transition-colors"
                >
                  <span className="material-icons text-sm">info</span>
                  Who can be added?
                </button>
              )}
            </div>
            <textarea
              id="emails"
              value={emailInput}
              onChange={(e) => {
                setEmailInput(e.target.value);
                setValidationError(null);
              }}
              className="w-full min-h-[120px] px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter email addresses (one per line, comma separated, or space separated)"
            />
            {validationError && <p className="mt-1 text-xs text-red-600">{validationError}</p>}
            <p className="mt-1 text-xs text-gray-500">
              Maximum 40 email addresses. Separate with commas, spaces, or new lines.
            </p>
          </div>

          <div>
            <label htmlFor="customMessage" className="block text-sm font-medium text-gray-700 mb-2">
              Custom Message (Optional)
            </label>
            <textarea
              id="customMessage"
              value={customMessage}
              onChange={handleCustomMessageChange}
              className="w-full min-h-[120px] px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Optional custom message to include in the invitation email"
            />
            <p className="mt-1 text-xs text-gray-500">
              Your custom message will be saved and used for future invitations. The message above will be included in
              the invitation email.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Sending Invitations..." : "Send Invitations"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/admin")}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </form>
    </>
  );

  return (
    <>
      <Head>
        <title>Add Users - Admin</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="Add Users">
        <div className="max-w-4xl">
          {mainContent}
          <AdminAccessGuidelinesModal
            isOpen={showGuidelinesModal}
            onClose={() => setShowGuidelinesModal(false)}
            siteConfig={siteConfig}
          />
        </div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<AddUsersPageProps> = async ({ req }) => {
  const siteConfig = await loadSiteConfig();
  const allowed = await isAdminPageAllowed(req as NextApiRequest, undefined as any, siteConfig);
  if (!allowed) {
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }
  return { props: { siteConfig } };
};
