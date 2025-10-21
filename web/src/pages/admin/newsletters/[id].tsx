import React, { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import type { GetServerSideProps, NextApiRequest } from "next";
import { isSuperuserPageAllowed } from "@/utils/server/adminPageGate";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { AdminLayout } from "@/components/AdminLayout";
import { getToken } from "@/utils/client/tokenManager";

interface NewsletterDetailsPageProps {
  siteConfig: SiteConfig | null;
}

interface NewsletterDetails {
  id: string;
  subject: string;
  content: string;
  sentAt: string;
  sentBy: string;
  totalQueued: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  status: string;
  ctaUrl?: string;
  ctaText?: string;
  recipients: {
    email: string;
    status: "sent" | "failed" | "pending";
    attempts: number;
    updatedAt?: string;
    error?: string;
  }[];
}

export default function NewsletterDetailsPage({ siteConfig }: NewsletterDetailsPageProps) {
  const router = useRouter();
  const { id } = router.query;
  const [newsletter, setNewsletter] = useState<NewsletterDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "sent" | "failed" | "pending">("overview");

  useEffect(() => {
    if (id && typeof id === "string") {
      fetchNewsletterDetails(id);
    }
  }, [id]);

  const fetchNewsletterDetails = async (newsletterId: string) => {
    try {
      setLoading(true);
      const token = await getToken();
      if (!token) {
        setError("Authentication required");
        return;
      }

      const response = await fetch(`/api/admin/newsletters/${newsletterId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          setError("Newsletter not found");
        } else {
          setError("Failed to fetch newsletter details");
        }
        return;
      }

      const data = await response.json();
      setNewsletter(data);
    } catch (err) {
      console.error("Failed to fetch newsletter details:", err);
      setError("Failed to fetch newsletter details");
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "text-green-600 bg-green-100";
      case "in_progress":
        return "text-yellow-600 bg-yellow-100";
      case "queued":
        return "text-blue-600 bg-blue-100";
      case "failed":
        return "text-red-600 bg-red-100";
      default:
        return "text-gray-600 bg-gray-100";
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  if (loading) {
    return (
      <>
        <Head>
          <title>Loading... · Admin</title>
        </Head>
        <AdminLayout siteConfig={siteConfig} pageTitle="Newsletter Details">
          <div className="max-w-6xl">
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-2 text-gray-600">Loading newsletter details...</p>
            </div>
          </div>
        </AdminLayout>
      </>
    );
  }

  if (error || !newsletter) {
    return (
      <>
        <Head>
          <title>Error · Admin</title>
        </Head>
        <AdminLayout siteConfig={siteConfig} pageTitle="Newsletter Details">
          <div className="max-w-6xl">
            <div className="text-center py-8">
              <div className="text-red-600 mb-4">
                <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">Error</h2>
              <p className="text-gray-600 mb-4">{error}</p>
              <button
                onClick={() => router.back()}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              >
                Go Back
              </button>
            </div>
          </div>
        </AdminLayout>
      </>
    );
  }

  const sentRecipients = newsletter.recipients.filter((r) => r.status === "sent");
  const failedRecipients = newsletter.recipients.filter((r) => r.status === "failed");
  const pendingRecipients = newsletter.recipients.filter((r) => r.status === "pending");

  const mainContent = (
    <>
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{newsletter.subject}</h1>
            <p className="text-sm text-gray-600 mt-1">Newsletter Details • Sent {formatDate(newsletter.sentAt)}</p>
          </div>
          <button onClick={() => router.back()} className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700">
            ← Back to Newsletters
          </button>
        </div>
      </div>

      {/* Status and Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="bg-white rounded-lg border shadow-sm p-6">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(newsletter.status)}`}
              >
                {newsletter.status.replace("_", " ").toUpperCase()}
              </div>
            </div>
          </div>
          <div className="mt-2">
            <p className="text-sm font-medium text-gray-500">Status</p>
            <p className="text-lg font-semibold text-gray-900">{newsletter.status}</p>
          </div>
        </div>

        <div className="bg-white rounded-lg border shadow-sm p-6">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <svg className="h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            </div>
          </div>
          <div className="mt-2">
            <p className="text-sm font-medium text-gray-500">Total Recipients</p>
            <p className="text-lg font-semibold text-gray-900">{newsletter.totalQueued}</p>
          </div>
        </div>

        <div className="bg-white rounded-lg border shadow-sm p-6">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <div className="mt-2">
            <p className="text-sm font-medium text-gray-500">Successfully Sent</p>
            <p className="text-lg font-semibold text-gray-900">{newsletter.sentCount}</p>
          </div>
        </div>

        <div className="bg-white rounded-lg border shadow-sm p-6">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
          </div>
          <div className="mt-2">
            <p className="text-sm font-medium text-gray-500">Failed</p>
            <p className="text-lg font-semibold text-gray-900">{newsletter.failedCount}</p>
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="bg-white rounded-lg border shadow-sm p-6 mb-8">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Delivery Progress</h3>
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-sm text-gray-600 mb-1">
              <span>Progress</span>
              <span>
                {newsletter.sentCount + newsletter.failedCount} / {newsletter.totalQueued}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full"
                style={{
                  width: `${newsletter.totalQueued > 0 ? ((newsletter.sentCount + newsletter.failedCount) / newsletter.totalQueued) * 100 : 0}%`,
                }}
              ></div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="text-center">
              <div className="text-green-600 font-semibold">{newsletter.sentCount}</div>
              <div className="text-gray-500">Sent</div>
            </div>
            <div className="text-center">
              <div className="text-yellow-600 font-semibold">{newsletter.pendingCount}</div>
              <div className="text-gray-500">Pending</div>
            </div>
            <div className="text-center">
              <div className="text-red-600 font-semibold">{newsletter.failedCount}</div>
              <div className="text-gray-500">Failed</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg border shadow-sm">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8 px-6">
            {[
              { id: "overview", label: "Overview", count: newsletter.totalQueued },
              { id: "sent", label: "Sent", count: sentRecipients.length },
              { id: "failed", label: "Failed", count: failedRecipients.length },
              { id: "pending", label: "Pending", count: pendingRecipients.length },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? "border-blue-500 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === "overview" && (
            <div className="space-y-6">
              <div>
                <h4 className="text-lg font-semibold text-gray-900 mb-3">Newsletter Information</h4>
                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Subject:</span>
                    <span className="text-sm font-medium">{newsletter.subject}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Sent By:</span>
                    <span className="text-sm font-medium">{newsletter.sentBy}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Sent At:</span>
                    <span className="text-sm font-medium">{formatDate(newsletter.sentAt)}</span>
                  </div>
                  {newsletter.ctaText && newsletter.ctaUrl && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-600">CTA Text:</span>
                        <span className="text-sm font-medium">{newsletter.ctaText}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-600">CTA URL:</span>
                        <span className="text-sm font-medium break-all">{newsletter.ctaUrl}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div>
                <h4 className="text-lg font-semibold text-gray-900 mb-3">Content Preview</h4>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="prose prose-sm max-w-none">
                    <div
                      dangerouslySetInnerHTML={{
                        __html: newsletter.content.substring(0, 500) + (newsletter.content.length > 500 ? "..." : ""),
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "sent" && (
            <div>
              <h4 className="text-lg font-semibold text-gray-900 mb-4">Successfully Sent ({sentRecipients.length})</h4>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {sentRecipients.map((recipient, index) => (
                  <div key={index} className="flex items-center justify-between p-3 bg-green-50 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <div className="text-green-600">
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </div>
                      <span className="text-sm font-medium">{recipient.email}</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {recipient.updatedAt && formatDate(recipient.updatedAt)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "failed" && (
            <div>
              <h4 className="text-lg font-semibold text-gray-900 mb-4">
                Failed Deliveries ({failedRecipients.length})
              </h4>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {failedRecipients.map((recipient, index) => (
                  <div key={index} className="p-3 bg-red-50 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-3">
                        <div className="text-red-600">
                          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <span className="text-sm font-medium">{recipient.email}</span>
                      </div>
                      <div className="text-xs text-gray-500">Attempts: {recipient.attempts}</div>
                    </div>
                    {recipient.error && <div className="text-xs text-red-600 mt-1">Error: {recipient.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "pending" && (
            <div>
              <h4 className="text-lg font-semibold text-gray-900 mb-4">
                Pending Delivery ({pendingRecipients.length})
              </h4>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {pendingRecipients.map((recipient, index) => (
                  <div key={index} className="flex items-center justify-between p-3 bg-yellow-50 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <div className="text-yellow-600">
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </div>
                      <span className="text-sm font-medium">{recipient.email}</span>
                    </div>
                    <div className="text-xs text-gray-500">Attempts: {recipient.attempts}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      <Head>
        <title>{newsletter.subject} · Admin</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="Newsletter Details">
        <div className="max-w-6xl">{mainContent}</div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<NewsletterDetailsPageProps> = async ({ req }) => {
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
    console.error("Failed to load newsletter details page:", error);
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }
};
