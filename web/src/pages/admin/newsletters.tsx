import React, { useState, useEffect, useMemo, useCallback } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import type { GetServerSideProps, NextApiRequest } from "next";
import { isSuperuserPageAllowed } from "@/utils/server/adminPageGate";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { AdminLayout } from "@/components/AdminLayout";
import { getToken } from "@/utils/client/tokenManager";
import { marked } from "marked";
import { maskEmail } from "@/utils/client/demoMode";

interface NewsletterPageProps {
  siteConfig: SiteConfig | null;
}

interface NewsletterHistory {
  id: string;
  subject: string;
  content: string;
  sentAt: string;
  sentBy: string;
  recipientCount: number;
  successCount: number;
  errorCount: number;
}

export default function NewslettersPage({ siteConfig }: NewsletterPageProps) {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [ctaText, setCtaText] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [history, setHistory] = useState<NewsletterHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [showPreview, setShowPreview] = useState(false);

  // Role selection for newsletter recipients
  const [includeUsers, setIncludeUsers] = useState(true);
  const [includeAdmins, setIncludeAdmins] = useState(true);
  const [includeSuperUsers, setIncludeSuperUsers] = useState(true);

  // Newsletter Queue Processor state
  const [selectedNewsletterId, setSelectedNewsletterId] = useState("");
  const [progress, setProgress] = useState<{
    sent: number;
    failed: number;
    remaining: number;
    errors: string[];
  } | null>(null);
  const [newsletters, setNewsletters] = useState<any[]>([]);
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);

  // Check if selected newsletter has remaining emails
  const selectedNewsletterRemainingCount = useMemo(() => {
    if (!selectedNewsletterId) return 0;
    const selectedNewsletter = newsletters.find((nl) => nl.id === selectedNewsletterId);
    return selectedNewsletter
      ? selectedNewsletter.totalQueued - selectedNewsletter.sentCount - selectedNewsletter.failedCount
      : 0;
  }, [selectedNewsletterId, newsletters]);

  const selectedNewsletterHasRemaining = selectedNewsletterRemainingCount > 0;

  // Newsletter Queue Processor functions
  const fetchNewsletters = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) {
        console.error("No authentication token available");
        return;
      }

      const response = await fetch("/api/admin/newsletters?status=queued", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();
      const fetchedNewsletters = data.newsletters || [];
      setNewsletters(fetchedNewsletters);
    } catch (error) {
      console.error("Failed to fetch newsletters:", error);
    }
  }, []);

  // Load newsletter history and CTA fields from localStorage
  useEffect(() => {
    loadHistory();
    loadCtaFromLocalStorage();
    fetchNewsletters();
  }, [fetchNewsletters]);

  // Auto-select the first newsletter when newsletters are loaded
  useEffect(() => {
    // Filter newsletters to only those with remaining emails
    const newslettersWithRemaining = newsletters.filter((nl) => {
      const remaining = nl.totalQueued - nl.sentCount - nl.failedCount;
      return remaining > 0;
    });

    // Auto-select if there's only one newsletter with remaining emails
    if (newslettersWithRemaining.length === 1 && !selectedNewsletterId) {
      setSelectedNewsletterId(newslettersWithRemaining[0].id);
    }
  }, [newsletters, selectedNewsletterId]);

  // Load CTA fields from localStorage
  function loadCtaFromLocalStorage() {
    try {
      if (typeof window !== "undefined") {
        const savedCtaUrl = localStorage.getItem("newsletter_cta_url");
        const savedCtaText = localStorage.getItem("newsletter_cta_text");

        if (savedCtaUrl) {
          setCtaUrl(savedCtaUrl);
        }
        if (savedCtaText) {
          setCtaText(savedCtaText);
        }
      }
    } catch (error) {
      console.error("Failed to load CTA fields from localStorage:", error);
    }
  }

  // Save CTA fields to localStorage
  function saveCtaToLocalStorage(url: string, text: string) {
    try {
      if (typeof window !== "undefined") {
        if (url.trim()) {
          localStorage.setItem("newsletter_cta_url", url.trim());
        } else {
          localStorage.removeItem("newsletter_cta_url");
        }

        if (text.trim()) {
          localStorage.setItem("newsletter_cta_text", text.trim());
        } else {
          localStorage.removeItem("newsletter_cta_text");
        }
      }
    } catch (error) {
      console.error("Failed to save CTA fields to localStorage:", error);
    }
  }

  async function loadHistory() {
    try {
      const token = await getToken();
      if (!token) return;

      const response = await fetch("/api/admin/newsletters/history", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setHistory(data.newsletters || []);
      }
    } catch (error) {
      console.error("Failed to load newsletter history:", error);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function handleSend() {
    if (!subject.trim() || !content.trim()) {
      setMessage("Subject and content are required");
      setMessageType("error");
      return;
    }

    if (ctaUrl && !ctaText.trim()) {
      setMessage("CTA text is required when CTA URL is provided");
      setMessageType("error");
      return;
    }

    if (ctaText && !ctaUrl.trim()) {
      setMessage("CTA URL is required when CTA text is provided");
      setMessageType("error");
      return;
    }

    if (!includeUsers && !includeAdmins && !includeSuperUsers) {
      setMessage("At least one user role must be selected");
      setMessageType("error");
      return;
    }

    setSending(true);
    setMessage(null);

    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Authentication required");
      }

      const response = await fetch("/api/admin/sendNewsletter", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          subject: subject.trim(),
          content: content.trim(),
          ctaUrl: ctaUrl.trim() || undefined,
          ctaText: ctaText.trim() || undefined,
          includeRoles: {
            users: includeUsers,
            admins: includeAdmins,
            superusers: includeSuperUsers,
          },
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setMessage(
          `Newsletter queued successfully! ${data.totalQueued} emails queued for processing. Use the Newsletter Queue Processor below to send them in batches.`
        );
        setMessageType("success");

        // Clear form (but preserve CTA fields since they're saved in localStorage)
        setSubject("");
        setContent("");

        // Reset role selections to default (all checked)
        setIncludeUsers(true);
        setIncludeAdmins(true);
        setIncludeSuperUsers(true);

        // Reload history and refresh newsletters
        loadHistory();
        setTimeout(() => {
          fetchNewsletters();
          scrollToTop();
        }, 100);
      } else {
        // Handle API error response
        let errorMessage = data.error || "Failed to queue newsletter";

        // Add details if available
        if (data.details) {
          errorMessage += `: ${data.details}`;
        }

        // Add specific errors if available
        if (data.errors && data.errors.length > 0) {
          errorMessage += `\n\nSpecific errors:\n${data.errors.join("\n")}`;
        }

        throw new Error(errorMessage);
      }
    } catch (error: any) {
      let errorMessage = error.message || "Failed to queue newsletter";

      // Handle network errors
      if (error.name === "TypeError" && error.message.includes("fetch")) {
        errorMessage = "Network error: Unable to connect to server. Please check your connection and try again.";
      }

      setMessage(errorMessage);
      setMessageType("error");
    } finally {
      setSending(false);
    }
  }

  const handleProcessBatch = async () => {
    if (!selectedNewsletterId || isProcessingBatch) return;

    setIsProcessingBatch(true);
    try {
      const token = await getToken();
      if (!token) {
        console.error("No authentication token available");
        return;
      }

      const response = await fetch("/api/admin/processNewsletterBatch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newsletterId: selectedNewsletterId }),
      });
      const data = await response.json();
      setProgress(data);

      // Refresh newsletters list
      await fetchNewsletters();
    } catch (error) {
      console.error("Failed to process batch:", error);
    } finally {
      setIsProcessingBatch(false);
    }
  };

  const handleDeleteQueue = async () => {
    if (!selectedNewsletterId) return;

    const selectedNewsletter = newsletters.find((nl) => nl.id === selectedNewsletterId);
    const remainingCount = selectedNewsletter
      ? selectedNewsletter.totalQueued - selectedNewsletter.sentCount - selectedNewsletter.failedCount
      : 0;

    if (remainingCount === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete ${remainingCount} remaining queue items? This action cannot be undone.`
    );

    if (!confirmed) return;

    try {
      const token = await getToken();
      if (!token) {
        console.error("No authentication token available");
        return;
      }

      const response = await fetch("/api/admin/deleteNewsletterQueue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newsletterId: selectedNewsletterId }),
      });

      const data = await response.json();

      if (response.ok) {
        setMessage(`Successfully deleted ${data.deleted} queue items.`);
        setMessageType("success");
        // Refresh newsletters list
        await fetchNewsletters();
        scrollToTop();
      } else {
        setMessage(`Failed to delete queue: ${data.error}`);
        setMessageType("error");
        scrollToTop();
      }
    } catch (error) {
      console.error("Failed to delete queue:", error);
      setMessage("Failed to delete queue items.");
      setMessageType("error");
      scrollToTop();
    }
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  function generatePreviewContent() {
    if (!content.trim()) {
      return "<p>Your newsletter content will appear here...</p>";
    }

    try {
      // Configure marked for safe HTML generation
      marked.setOptions({
        breaks: true, // Convert line breaks to <br>
        gfm: true, // Enable GitHub Flavored Markdown
      });

      // Convert Markdown to HTML
      const htmlContent = marked(content);
      return htmlContent;
    } catch (error) {
      console.error("Markdown parsing error:", error);
      // Fallback to plain text with line breaks
      return `<p>${content.replace(/\n/g, "<br>")}</p>`;
    }
  }

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Newsletters</h1>
        <p className="text-sm text-gray-600 mt-1">Send newsletters to users</p>
      </div>

      {/* Status Message */}
      {message && (
        <div
          className={`mb-6 rounded border p-3 text-sm ${
            messageType === "error"
              ? "border-red-300 bg-red-50 text-red-800"
              : "border-green-300 bg-green-50 text-green-800"
          }`}
        >
          {message}
        </div>
      )}

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Newsletter Management</h1>
      </div>

      {/* Newsletter Queue Processor */}
      <div className="bg-white rounded-lg border shadow-sm mb-8">
        <div className="p-6 border-b">
          <h2 className="text-lg font-semibold">Newsletter Queue Processor</h2>
          <p className="text-sm text-gray-600 mt-1">Process queued newsletters in batches of 50 emails</p>
        </div>
        <div className="p-6">
          <select
            value={selectedNewsletterId}
            onChange={(e) => setSelectedNewsletterId(e.target.value)}
            className="mb-4 p-2 border rounded w-full"
          >
            <option value="">
              {newsletters.filter((nl) => {
                const remaining = nl.totalQueued - nl.sentCount - nl.failedCount;
                return remaining > 0;
              }).length === 0
                ? "No newsletters with remaining emails"
                : "Select a newsletter to process"}
            </option>
            {newsletters
              .filter((nl) => {
                const remaining = nl.totalQueued - nl.sentCount - nl.failedCount;
                return remaining > 0;
              })
              .map((nl) => (
                <option key={nl.id} value={nl.id}>
                  {nl.subject} ({nl.totalQueued - nl.sentCount - nl.failedCount} remaining)
                </option>
              ))}
          </select>
          <div className="flex gap-3">
            <button
              onClick={handleProcessBatch}
              disabled={!selectedNewsletterId || !selectedNewsletterHasRemaining || isProcessingBatch}
              className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50 hover:bg-blue-700 flex items-center gap-2"
            >
              {isProcessingBatch && (
                <svg
                  className="animate-spin h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              )}
              {isProcessingBatch
                ? "Processing..."
                : `Process Next ${Math.min(selectedNewsletterRemainingCount, 50)} Email${Math.min(selectedNewsletterRemainingCount, 50) === 1 ? "" : "s"}`}
            </button>
            <button
              onClick={handleDeleteQueue}
              disabled={!selectedNewsletterId || !selectedNewsletterHasRemaining || isProcessingBatch}
              className="bg-red-600 text-white px-4 py-2 rounded disabled:opacity-50 hover:bg-red-700"
            >
              Delete remaining {selectedNewsletterRemainingCount} messages
            </button>
          </div>
          {progress && (
            <div className="mt-4 p-3 bg-gray-50 rounded">
              <p className="text-sm">
                Sent: <span className="font-semibold text-green-600">{progress.sent}</span>
              </p>
              <p className="text-sm">
                Failed: <span className="font-semibold text-red-600">{progress.failed}</span>
              </p>
              <p className="text-sm">
                Remaining: <span className="font-semibold">{progress.remaining}</span>
              </p>
              {progress.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-red-600">
                    View Errors ({progress.errors.length})
                  </summary>
                  <div className="mt-1 text-xs text-red-600 max-h-32 overflow-y-auto">
                    {progress.errors.map((error, index) => (
                      <div key={index} className="mb-1">
                        {error}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Newsletter Composer */}
      <div className="bg-white rounded-lg border shadow-sm mb-8">
        <div className="p-6 border-b">
          <h2 className="text-lg font-semibold">Compose Newsletter</h2>
          <p className="text-gray-600 mt-2">
            Compose and send newsletters to subscribed users. All subscribers will receive the newsletter with a
            personalized unsubscribe link.
          </p>
          <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-md">
            <p className="text-sm text-blue-800">
              <strong>Image Hosting:</strong> Images can be hosted in <code>/public/newsletter</code> within S3 or
              hosted wherever else you prefer. Use standard Markdown image syntax: <code>![Alt text](image-url)</code>
            </p>
          </div>
        </div>
        <div className="p-6 space-y-6">
          {/* Subject */}
          <div>
            <label htmlFor="subject" className="block text-sm font-medium text-gray-700 mb-2">
              Subject Line *
            </label>
            <input
              id="subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter newsletter subject..."
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-blue-500"
              maxLength={200}
            />
            <p className="text-xs text-gray-500 mt-1">{subject.length}/200 characters</p>
          </div>

          {/* Content */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label htmlFor="content" className="block text-sm font-medium text-gray-700">
                Newsletter Content * (Markdown)
              </label>
              <button
                type="button"
                onClick={() => setShowPreview(!showPreview)}
                className="text-xs text-blue-600 hover:text-blue-800 underline"
              >
                {showPreview ? "Hide Preview" : "Show Preview"}
              </button>
            </div>
            <textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={`Write your newsletter in Markdown...

Examples:
# Main Heading
## Subheading

**Bold text** and *italic text*

- Bullet point 1
- Bullet point 2

[Link text](https://example.com)

![Image alt text](https://example.com/image.jpg)

> This is a blockquote

\`\`\`
Code block
\`\`\`

Image Hosting:
Images can be hosted in /public/newsletter within S3 or hosted wherever else you prefer.
For S3 images: ![Alt text](https://your-s3-bucket.s3.amazonaws.com/public/newsletter/image.jpg)
For external images: ![Alt text](https://external-site.com/image.jpg)
`}
              rows={16}
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-blue-500 font-mono text-sm"
              maxLength={50000}
            />
            <div className="flex justify-between items-center mt-1">
              <p className="text-xs text-gray-500">{content.length}/50,000 characters</p>
              <div className="text-xs text-gray-600 space-x-4">
                <span>**bold**</span>
                <span>*italic*</span>
                <span>[link](url)</span>
                <span>![image](url)</span>
                <span># heading</span>
              </div>
            </div>
          </div>

          {/* Call-to-Action (Optional) */}
          <div className="border-t pt-6">
            <h3 className="text-sm font-medium text-gray-700 mb-4">Call-to-Action Button (Optional)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="ctaText" className="block text-sm font-medium text-gray-700 mb-2">
                  Button Text
                </label>
                <input
                  id="ctaText"
                  type="text"
                  value={ctaText}
                  onChange={(e) => {
                    const newText = e.target.value;
                    setCtaText(newText);
                    saveCtaToLocalStorage(ctaUrl, newText);
                  }}
                  placeholder="e.g., Visit Our Website"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="ctaUrl" className="block text-sm font-medium text-gray-700 mb-2">
                  Button URL
                </label>
                <input
                  id="ctaUrl"
                  type="url"
                  value={ctaUrl}
                  onChange={(e) => {
                    const newUrl = e.target.value;
                    setCtaUrl(newUrl);
                    saveCtaToLocalStorage(newUrl, ctaText);
                  }}
                  placeholder="https://example.com"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-blue-500"
                />
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              💾 CTA button settings are automatically saved and will be remembered for future newsletters
            </p>
          </div>

          {/* Recipient Role Selection */}
          <div className="border-t pt-6">
            <h3 className="text-sm font-medium text-gray-700 mb-4">Newsletter Recipients</h3>
            <p className="text-xs text-gray-500 mb-4">Select which user roles should receive this newsletter:</p>
            <div className="space-y-3">
              <div className="flex items-center">
                <input
                  id="includeUsers"
                  type="checkbox"
                  checked={includeUsers}
                  onChange={(e) => setIncludeUsers(e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <label htmlFor="includeUsers" className="ml-2 text-sm text-gray-700">
                  <span className="font-medium">Users</span> - Regular users with basic access
                </label>
              </div>
              <div className="flex items-center">
                <input
                  id="includeAdmins"
                  type="checkbox"
                  checked={includeAdmins}
                  onChange={(e) => setIncludeAdmins(e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <label htmlFor="includeAdmins" className="ml-2 text-sm text-gray-700">
                  <span className="font-medium">Admins</span> - Administrative users with elevated privileges
                </label>
              </div>
              <div className="flex items-center">
                <input
                  id="includeSuperUsers"
                  type="checkbox"
                  checked={includeSuperUsers}
                  onChange={(e) => setIncludeSuperUsers(e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <label htmlFor="includeSuperUsers" className="ml-2 text-sm text-gray-700">
                  <span className="font-medium">Super Users</span> - Highest level administrators
                </label>
              </div>
            </div>
            {!includeUsers && !includeAdmins && !includeSuperUsers && (
              <p className="text-xs text-red-600 mt-2">⚠️ At least one user role must be selected</p>
            )}
          </div>

          {/* Actions */}
          <div className="pt-6 border-t">
            <div className="flex justify-end">
              <button
                onClick={handleSend}
                disabled={
                  sending ||
                  !subject.trim() ||
                  !content.trim() ||
                  (!includeUsers && !includeAdmins && !includeSuperUsers)
                }
                className="px-6 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? "Queueing..." : "Queue Newsletter"}
              </button>
            </div>
          </div>

          {/* Preview */}
          {showPreview && (
            <div className="border-t pt-6">
              <h3 className="text-sm font-medium text-gray-700 mb-4">Preview</h3>
              <div className="border rounded-lg p-4 bg-gray-50">
                <div className="bg-white rounded border max-w-2xl mx-auto">
                  {/* Email Header */}
                  <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-6 text-center">
                    <h1 className="text-xl font-bold">{siteConfig?.name || "Ananda Library"} Newsletter</h1>
                  </div>

                  {/* Email Content */}
                  <div className="p-6">
                    <div className="mb-4">
                      <strong>Subject:</strong> {subject || "Your newsletter subject"}
                    </div>
                    <div className="mb-4">Hello Friend,</div>
                    <div
                      className="prose prose-sm max-w-none mb-6"
                      dangerouslySetInnerHTML={{ __html: generatePreviewContent() }}
                    />

                    {/* CTA Button */}
                    {ctaText && ctaUrl && (
                      <div className="text-center mb-6">
                        <div className="inline-block bg-blue-600 text-white px-6 py-3 rounded-md font-medium">
                          {ctaText}
                        </div>
                      </div>
                    )}

                    {/* Footer */}
                    <div className="text-xs text-gray-500 border-t pt-4">
                      <p>
                        You&apos;re receiving this newsletter because you&apos;re subscribed to{" "}
                        {siteConfig?.name || "Ananda Library"} updates.
                      </p>
                      <p>
                        If you no longer wish to receive these emails, you can{" "}
                        <span className="text-blue-600 underline">unsubscribe instantly</span>.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Newsletter History */}
      <div className="bg-white rounded-lg border shadow-sm">
        <div className="p-6 border-b">
          <h2 className="text-lg font-semibold">Newsletter History</h2>
        </div>
        <div className="p-6">
          {loadingHistory ? (
            <div className="text-center py-8 text-gray-500">Loading history...</div>
          ) : history.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No newsletters sent yet.</div>
          ) : (
            <div className="space-y-4">
              {history.map((newsletter) => (
                <div
                  key={newsletter.id}
                  className="border rounded-lg p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => router.push(`/admin/newsletters/${newsletter.id}`)}
                >
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-medium text-gray-900 hover:text-blue-600">{newsletter.subject}</h3>
                    <span className="text-xs text-gray-500">
                      {new Date(newsletter.sentAt).toLocaleDateString()} at{" "}
                      {new Date(newsletter.sentAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 mb-2">
                    Sent by: {maskEmail(newsletter.sentBy)} • Recipients: {newsletter.recipientCount} • Success:{" "}
                    {newsletter.successCount}
                    {newsletter.errorCount > 0 && ` • Errors: ${newsletter.errorCount}`}
                  </div>
                  <div className="text-sm text-gray-700 line-clamp-3">
                    {newsletter.content.substring(0, 200)}
                    {newsletter.content.length > 200 && "..."}
                  </div>
                  <div className="mt-2 text-xs text-blue-600 hover:text-blue-800">
                    Click to view detailed statistics →
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      <Head>
        <title>Admin · Newsletters</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="Newsletters">
        <div className="max-w-4xl">{mainContent}</div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<NewsletterPageProps> = async ({ req }) => {
  try {
    const siteConfig = await loadSiteConfig();
    const isAllowed = await isSuperuserPageAllowed(req as NextApiRequest, undefined as any, siteConfig);

    if (!isAllowed) {
      return {
        redirect: {
          destination: "/unauthorized",
          permanent: false,
        },
      };
    }

    return { props: { siteConfig } };
  } catch (error) {
    console.error("Failed to load admin newsletters page:", error);
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }
};
