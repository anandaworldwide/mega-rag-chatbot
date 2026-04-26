// Admin Pending Users page: Detailed list of pending user invitations
import React, { useEffect, useState } from "react";
import Head from "next/head";
import { SiteConfig } from "@/types/siteConfig";
import type { GetServerSideProps, NextApiRequest } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isAdminPageAllowed } from "@/utils/server/adminPageGate";
import { AdminLayout } from "@/components/AdminLayout";
import { ResendInvitationModal } from "@/components/ResendInvitationModal";
import { maskEmail, isDemoModeEnabled } from "@/utils/client/demoMode";

interface PendingUser {
  email: string;
  invitedAt: string | null;
  expiresAt: string | null;
  invitedByEmail?: string | null;
  invitedByName?: string | null;
}

interface AdminPendingUsersPageProps {
  siteConfig: SiteConfig | null;
}

interface PaginationInfo {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export default function AdminPendingUsersPage({ siteConfig }: AdminPendingUsersPageProps) {
  const [pending, setPending] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"info" | "error">("info");
  const [isResendModalOpen, setIsResendModalOpen] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<string>("");
  const [resending, setResending] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [jwtReady, setJwtReady] = useState(false);

  // Use a ref for the JWT so token refreshes don't trigger data re-fetches
  const jwtRef = React.useRef<string | null>(null);

  // Shared function to handle token refresh and retry logic
  async function fetchWithTokenRefresh<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<{ data: T; refreshedToken?: string }> {
    const currentJwt = jwtRef.current;
    const res = await fetch(url, {
      ...options,
      headers: currentJwt ? { Authorization: `Bearer ${currentJwt}`, ...options.headers } : options.headers,
    });
    const data = await res.json();

    if (res.status === 401) {
      // Token expired - try to refresh
      const tokenRes = await fetch("/api/web-token");
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        const newToken = tokenData.token;
        jwtRef.current = newToken;

        // Retry the original request with new token
        const retryRes = await fetch(url, {
          ...options,
          headers: { Authorization: `Bearer ${newToken}`, ...options.headers },
        });
        const retryData = await retryRes.json();

        if (!retryRes.ok) {
          throw new Error(retryData?.error || "Request failed after token refresh");
        }

        return { data: retryData, refreshedToken: newToken };
      } else {
        // Refresh failed - redirect to login
        const fullPath = window.location.pathname + (window.location.search || "");
        window.location.href = `/login?redirect=${encodeURIComponent(fullPath)}`;
        throw new Error("Authentication failed");
      }
    }

    if (!res.ok) {
      throw new Error(data?.error || "Request failed");
    }

    return { data };
  }

  async function fetchPending(page: number = 1) {
    setLoading(true);
    setDataLoaded(false);

    // Show loading spinner only after 2 seconds
    const loadingTimer = setTimeout(() => {
      setShowLoading(true);
    }, 2000);

    try {
      // Build query parameters
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
      });

      const { data } = await fetchWithTokenRefresh<{
        items: any[];
        pagination: PaginationInfo;
      }>(`/api/admin/listPendingUsers?${params.toString()}`);

      const items: PendingUser[] = (data.items || []).map((it: any) => ({
        email: it.email,
        invitedAt: it.invitedAt || null,
        expiresAt: it.expiresAt || null,
        invitedByEmail: it.invitedByEmail || null,
        invitedByName: it.invitedByName || null,
      }));
      setPending(items);
      setPagination(data.pagination);
    } catch (e: any) {
      setMessage(e?.message || "Failed to load pending users");
      setMessageType("error");
    } finally {
      clearTimeout(loadingTimer);
      setLoading(false);
      setShowLoading(false);
      setDataLoaded(true);
    }
  }

  function handleResendClick(targetEmail: string) {
    setSelectedEmail(targetEmail);
    setIsResendModalOpen(true);
  }

  async function onResend(targetEmail: string, customMessage?: string) {
    setResending(true);
    setMessage(null);
    setMessageType("info");
    try {
      const currentJwt = jwtRef.current;
      const res = await fetch("/api/admin/resendActivation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(currentJwt ? { Authorization: `Bearer ${currentJwt}` } : {}),
        },
        body: JSON.stringify({ email: targetEmail, customMessage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to resend");
      setMessage(`Resent invitation to ${targetEmail}`);
      setMessageType("info");
      await fetchPending(currentPage);
    } catch (e: any) {
      setMessage(e?.message || "Failed to resend");
      setMessageType("error");
    } finally {
      setResending(false);
    }
  }

  // Acquire a short-lived JWT on mount and handle token refresh
  // Token is stored in jwtRef to avoid triggering data re-fetches on refresh
  useEffect(() => {
    async function refreshToken() {
      try {
        const res = await fetch("/api/web-token");
        const data = await res.json();
        if (res.ok && data?.token) {
          jwtRef.current = data.token;
          setMessage(null); // Clear any previous error messages
          // Only trigger data fetch on first token acquisition
          if (!jwtReady) {
            setJwtReady(true);
          }
        } else if (res.status === 401) {
          // Token expired or authentication issue - redirect to login
          const fullPath = window.location.pathname + (window.location.search || "");
          window.location.href = `/login?redirect=${encodeURIComponent(fullPath)}`;
        } else {
          setMessage(data?.error || "Failed to obtain auth token");
          setMessageType("error");
        }
      } catch (e: any) {
        setMessage(e?.message || "Failed to obtain auth token");
        setMessageType("error");
      }
    }
    refreshToken();

    // Periodic token refresh to prevent expiration while page is open and idle
    // JWT tokens expire after 15 minutes, so refresh every 10 minutes
    // This only updates the ref - does NOT trigger data re-fetches
    const TOKEN_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
    const refreshInterval = setInterval(refreshToken, TOKEN_REFRESH_INTERVAL);

    // Also refresh token when user returns to the page
    const handleWindowFocus = () => {
      refreshToken();
    };
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      clearInterval(refreshInterval);
      window.removeEventListener("focus", handleWindowFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch pending users once JWT is available and when page changes
  useEffect(() => {
    if (!jwtReady) return;
    fetchPending(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwtReady, currentPage]);

  const mainContent = (
    <>
      <div className="mb-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Pending User Invitations</h1>
            <p className="text-sm text-gray-600 mt-1">
              These are users who have been invited but haven&apos;t completed their activation yet.
            </p>
          </div>
          <div className="text-sm text-gray-600 min-w-0 flex-shrink-0">
            {pagination && pagination.totalCount > 0 ? (
              <>
                Showing {(pagination.page - 1) * pagination.limit + 1} to{" "}
                {Math.min(pagination.page * pagination.limit, pagination.totalCount)} of {pagination.totalCount} pending
                invitations
              </>
            ) : (
              <span className="opacity-0">Showing 1 to 20 of 100 invitations</span>
            )}
          </div>
        </div>
      </div>

      {message && (
        <div
          className={`mb-4 rounded border p-3 text-sm ${
            messageType === "error" ? "border-red-300 bg-red-50 text-red-800" : "border-yellow-300 bg-yellow-50"
          }`}
        >
          {message}
        </div>
      )}

      {loading && showLoading && (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading pending users...</p>
        </div>
      )}

      {dataLoaded && pending.length === 0 && (
        <div className="text-center py-8">
          <div className="text-gray-500 text-lg mb-2">No pending invitations</div>
          <p className="text-gray-400 text-sm">All users have completed their activation.</p>
        </div>
      )}

      {dataLoaded && pending.length > 0 && (
        <>
          {/* Mobile Card View */}
          <div className="lg:hidden space-y-3">
            {pending.map((u) => (
              <div key={u.email} className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <span className="material-icons text-gray-400 text-sm mt-0.5">email</span>
                    <span className="text-gray-900 font-medium break-all flex-1">
                      {isDemoModeEnabled() ? maskEmail(u.email) : u.email}
                    </span>
                  </div>
                  <div className="inline-flex w-fit items-center rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-medium text-yellow-800">
                    Awaiting activation
                  </div>
                  <p className="text-xs text-gray-500">Waiting for the user to click their activation email.</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-gray-500 text-xs mb-1">Invited</div>
                      <div className="text-gray-700">{u.invitedAt || "–"}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs mb-1">Expires</div>
                      <div className="text-gray-700">{u.expiresAt || "–"}</div>
                    </div>
                  </div>
                  {(u.invitedByEmail || u.invitedByName) && (
                    <div className="text-xs text-gray-600">
                      <span className="text-gray-500">Sent by:</span>
                      <span className="ml-1 text-gray-700">
                        {u.invitedByName ? u.invitedByName : u.invitedByEmail}
                        {u.invitedByName && u.invitedByEmail ? ` (${u.invitedByEmail})` : ""}
                      </span>
                    </div>
                  )}
                  <button
                    className="w-full inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-colors"
                    onClick={() => handleResendClick(u.email)}
                  >
                    <span className="material-icons text-sm mr-1">send</span>
                    Resend Invitation
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Table View */}
          <div className="hidden lg:block bg-white shadow-sm rounded-lg overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50">
                <tr className="border-b">
                  <th className="py-3 px-4 font-medium text-gray-900">Email</th>
                  <th className="py-3 px-4 font-medium text-gray-900">Invited</th>
                  <th className="py-3 px-4 font-medium text-gray-900">Expires</th>
                  <th className="py-3 px-4 font-medium text-gray-900">Status</th>
                  <th className="py-3 px-4 font-medium text-gray-900">Sent By</th>
                  <th className="py-3 px-4 font-medium text-gray-900">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {pending.map((u) => (
                  <tr key={u.email} className="hover:bg-gray-50">
                    <td className="py-3 px-4 font-medium text-gray-900">
                      {isDemoModeEnabled() ? maskEmail(u.email) : u.email}
                    </td>
                    <td className="py-3 px-4 text-gray-600">{u.invitedAt || "–"}</td>
                    <td className="py-3 px-4 text-gray-600">{u.expiresAt || "–"}</td>
                    <td className="py-3 px-4">
                      <div className="flex flex-col gap-1">
                        <span className="inline-flex w-fit items-center rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-medium text-yellow-800">
                          Awaiting activation
                        </span>
                        <span className="text-xs text-gray-500">User must click activation email</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {u.invitedByEmail || u.invitedByName ? (
                        <span>
                          {u.invitedByName ? u.invitedByName : u.invitedByEmail}
                          {u.invitedByName && u.invitedByEmail ? ` (${u.invitedByEmail})` : ""}
                        </span>
                      ) : (
                        <span className="text-gray-400">–</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        className="inline-flex items-center px-3 py-1 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-colors"
                        onClick={() => handleResendClick(u.email)}
                      >
                        Resend
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Pagination Controls - only show when data is loaded and have data */}
      {dataLoaded && pagination && pagination.totalPages > 1 && (
        <div className="flex justify-center items-center gap-2 mt-6">
          <button
            onClick={() => setCurrentPage(1)}
            disabled={!pagination.hasPrev}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            First
          </button>
          <button
            onClick={() => setCurrentPage(currentPage - 1)}
            disabled={!pagination.hasPrev}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Previous
          </button>

          <span className="px-3 py-1 text-sm">
            Page {pagination.page} of {pagination.totalPages}
          </span>

          <button
            onClick={() => setCurrentPage(currentPage + 1)}
            disabled={!pagination.hasNext}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Next
          </button>
          <button
            onClick={() => setCurrentPage(pagination.totalPages)}
            disabled={!pagination.hasNext}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Last
          </button>
        </div>
      )}

      <ResendInvitationModal
        isOpen={isResendModalOpen}
        onClose={() => setIsResendModalOpen(false)}
        onResend={onResend}
        email={selectedEmail}
        isSubmitting={resending}
        siteConfig={siteConfig}
      />
    </>
  );

  return (
    <>
      <Head>
        <title>Admin · Pending Users</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="Pending Users">
        <div className="max-w-4xl">{mainContent}</div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<AdminPendingUsersPageProps> = async ({ req }) => {
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
