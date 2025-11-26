// Combined Admin Dashboard
import React, { useEffect, useState } from "react";
import Head from "next/head";
import type { GetServerSideProps, NextApiRequest, NextApiResponse } from "next";
import { isAdminPageAllowed } from "@/utils/server/adminPageGate";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { AdminLayout } from "@/components/AdminLayout";
import Layout from "@/components/layout";
import { maskUserPII } from "@/utils/client/demoMode";
import { formatFullName } from "@/utils/shared/nameUtils";

interface ActiveUser {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  uuid?: string | null;
  role?: string;
  verifiedAt: string | null;
  lastLoginAt: string | null;
  entitlements: Record<string, any>;
}

interface PaginationInfo {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

type SortOption = "name-asc" | "login-desc";

interface AdminDashboardProps {
  isSudoAdmin: boolean;
  siteConfig: SiteConfig | null;
}

// Helper component for date display (date only, no time)
function DateDisplay({ dateString }: { dateString: string | null }) {
  if (!dateString) return <span>–</span>;

  // dateString is already formatted as locale string from the API
  // Extract just the date part (before the comma and time)
  const dateOnly = dateString.split(",")[0];

  return <span>{dateOnly}</span>;
}

// Helper function to get display name
function getDisplayName(user: ActiveUser): string {
  const maskedUser = maskUserPII(user);
  const firstName = maskedUser.firstName;
  const lastName = maskedUser.lastName;

  // Use formatFullName to handle escaped quotes
  const fullName = formatFullName(firstName, lastName);
  if (fullName) {
    return fullName;
  }
  return maskedUser.email; // Email comes from API response mapping (doc.id)
}

// Helper function to truncate email for display
function truncateEmail(email: string, maxLength: number = 35): string {
  if (email.length <= maxLength) {
    return email;
  }
  return email.substring(0, maxLength) + "...";
}

export default function AdminDashboardPage({ isSudoAdmin, siteConfig }: AdminDashboardProps) {
  const loginRequired = !!siteConfig?.requireLogin;
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"info" | "error">("info");
  const [active, setActive] = useState<ActiveUser[]>([]);
  const [activeLoading, setActiveLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [jwt, setJwt] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>("login-desc");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>("");
  const [showAdminsOnly, setShowAdminsOnly] = useState<boolean>(false);

  // Shared function to handle token refresh and retry logic
  async function fetchWithTokenRefresh<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<{ data: T; refreshedToken?: string }> {
    const res = await fetch(url, {
      ...options,
      headers: jwt ? { Authorization: `Bearer ${jwt}`, ...options.headers } : options.headers,
    });
    const data = await res.json();

    if (res.status === 401) {
      // Token expired - try to refresh
      const tokenRes = await fetch("/api/web-token");
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        const newToken = tokenData.token;

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

  async function fetchActive(page: number = 1) {
    setActiveLoading(true);
    setDataLoaded(false);

    // Show loading message only after 3 seconds
    const loadingTimer = setTimeout(() => {
      setShowLoading(true);
    }, 3000);

    try {
      // Build query parameters
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
        sortBy: sortBy,
      });

      // Add search parameter if there's a debounced search query
      if (debouncedSearchQuery.trim()) {
        params.append("search", debouncedSearchQuery.trim());
      }

      // Add admin-only filter if checkbox is checked
      if (showAdminsOnly) {
        params.append("adminsOnly", "true");
      }

      const { data, refreshedToken } = await fetchWithTokenRefresh<{
        items: any[];
        pagination: PaginationInfo;
      }>(`/api/admin/listActiveUsers?${params.toString()}`);

      // Update JWT if it was refreshed
      if (refreshedToken) {
        setJwt(refreshedToken);
      }

      const items: ActiveUser[] = (data.items || []).map((it: any) => ({
        email: it.email,
        firstName: it.firstName ?? null,
        lastName: it.lastName ?? null,
        uuid: it.uuid ?? null,
        role: it.role || undefined,
        verifiedAt: it.verifiedAt ? new Date(it.verifiedAt).toLocaleString() : null,
        lastLoginAt: it.lastLoginAt ? new Date(it.lastLoginAt).toLocaleString() : null,
        entitlements: it.entitlements || {},
      }));

      setActive(items);
      setPagination(data.pagination);
      setDataLoaded(true);
    } catch (e: any) {
      setMessage(e?.message || "Failed to load active users");
      setMessageType("error");
    } finally {
      clearTimeout(loadingTimer);
      setActiveLoading(false);
      setShowLoading(false);
      // Only set dataLoaded if we didn't have an error
      if (!dataLoaded) {
        setDataLoaded(true);
      }
    }
  }

  // Acquire a short-lived JWT on mount and handle token refresh
  useEffect(() => {
    async function getToken() {
      try {
        const res = await fetch("/api/web-token");
        const data = await res.json();
        if (res.ok && data?.token) {
          setJwt(data.token);
          setMessage(null); // Clear any previous error messages
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
    getToken();
  }, []);

  // Add window focus listener to refresh token when user returns to page
  useEffect(() => {
    async function handleWindowFocus() {
      // Only refresh if we don't have a valid JWT or if it's been a while
      if (!jwt) {
        try {
          const res = await fetch("/api/web-token");
          const data = await res.json();
          if (res.ok && data?.token) {
            setJwt(data.token);
            setMessage(null);
            // Refresh data with new token
            fetchActive(currentPage);
          } else if (res.status === 401) {
            const fullPath = window.location.pathname + (window.location.search || "");
            window.location.href = `/login?redirect=${encodeURIComponent(fullPath)}`;
          }
        } catch (e) {
          console.error("Failed to refresh token on focus:", e);
        }
      }
    }

    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, currentPage]);
  // Note: fetchActive is not included to avoid infinite loops - it's defined inline and changes on every render

  // Fetch active users once JWT is available (only for login-required sites)
  useEffect(() => {
    if (!loginRequired || !jwt) return;
    fetchActive(currentPage);
    // Intentionally only depends on jwt to refetch if token is refreshed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, currentPage, loginRequired]);
  // Note: fetchActive is not included to avoid infinite loops

  // Debounce search query to prevent excessive API calls
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300); // 300ms debounce delay

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch active users when page, sort, debounced search, or admin filter changes (only for login-required sites)
  useEffect(() => {
    if (!loginRequired || !jwt) return;
    fetchActive(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, jwt, sortBy, debouncedSearchQuery, showAdminsOnly, loginRequired]);
  // Note: fetchActive is not included to avoid infinite loops

  // Handle sort change
  const handleSortChange = (newSort: SortOption) => {
    setSortBy(newSort);
    setCurrentPage(1); // Reset to first page when sorting changes
  };

  // Handle search change with debouncing
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1); // Reset to first page when searching
  };

  // Handle admin filter change
  const handleAdminFilterChange = (checked: boolean) => {
    setShowAdminsOnly(checked);
    setCurrentPage(1); // Reset to first page when filter changes
  };

  if (!isSudoAdmin) {
    return (
      <Layout siteConfig={siteConfig}>
        <div className="mx-auto max-w-3xl p-6">
          <h1 className="text-2xl font-semibold mb-4">Admin Dashboard</h1>
          <div className="rounded border bg-yellow-50 p-3 text-sm">Access denied. Set sudo cookie to proceed.</div>
        </div>
      </Layout>
    );
  }

  const mainContent = (
    <>
      {message && (
        <div
          className={`mb-4 rounded border p-3 text-sm whitespace-pre-line ${
            messageType === "error" ? "border-red-300 bg-red-50 text-red-800" : "border-yellow-300 bg-yellow-50"
          }`}
        >
          {message}
        </div>
      )}

      {!loginRequired ? (
        <div className="bg-white shadow rounded-lg p-6">
          <h1 className="text-2xl font-semibold text-gray-900 mb-4">Admin Dashboard</h1>
          <p className="text-gray-600">
            User management is not available for sites that do not require login. Use other admin features from the
            navigation menu.
          </p>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex justify-between items-center">
              <h1 className="text-2xl font-semibold text-gray-900">Active Users</h1>
              <div className="text-sm text-gray-600 min-w-0 flex-shrink-0">
                {pagination && pagination.totalCount > 0 ? (
                  <>
                    Showing {(pagination.page - 1) * pagination.limit + 1} to{" "}
                    {Math.min(pagination.page * pagination.limit, pagination.totalCount)} of {pagination.totalCount}{" "}
                    users
                    {(debouncedSearchQuery || showAdminsOnly) && <span className="ml-2 text-gray-500">(filtered)</span>}
                  </>
                ) : (
                  <span className="opacity-0">Showing 1 to 20 of 100 users</span>
                )}
              </div>
            </div>
          </div>

          {/* Search Box and Filters */}
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex flex-col gap-3">
              <div className="relative max-w-md">
                <input
                  type="text"
                  placeholder="Search by name or email..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => handleSearchChange("")}
                    className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <span className="material-icons text-sm">close</span>
                  </button>
                )}
              </div>
              <div className="flex items-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showAdminsOnly}
                    onChange={(e) => handleAdminFilterChange(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Show admins and superusers only</span>
                </label>
              </div>
            </div>
          </div>

          {/* Mobile Card View */}
          <div className="lg:hidden">
            {activeLoading ? (
              <div className="px-6 py-8 text-center text-sm text-gray-600">
                {showLoading ? (
                  <div className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                    <span>Loading users...</span>
                  </div>
                ) : (
                  <div className="py-4"></div>
                )}
              </div>
            ) : dataLoaded && active.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-gray-600">
                {debouncedSearchQuery && showAdminsOnly
                  ? `No admins/superusers found matching "${debouncedSearchQuery}"`
                  : debouncedSearchQuery
                    ? `No users found matching "${debouncedSearchQuery}"`
                    : showAdminsOnly
                      ? "No admins or superusers found"
                      : "No active users"}
              </div>
            ) : dataLoaded && active.length > 0 ? (
              <div className="space-y-3 px-4 py-4">
                {active.map((u) => (
                  <div
                    key={u.email}
                    className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
                    onClick={() => {
                      window.location.href = `/admin/users/${encodeURIComponent(u.email)}`;
                    }}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <a
                        className="text-blue-600 hover:text-blue-800 font-semibold text-base"
                        href={`/admin/users/${encodeURIComponent(u.email)}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {getDisplayName(u)}
                      </a>
                      <span
                        className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                          u.role === "superuser"
                            ? "bg-purple-100 text-purple-700"
                            : u.role === "admin"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {u.role || "user"}
                      </span>
                    </div>
                    <div className="space-y-1 text-sm">
                      <div className="flex items-start gap-2">
                        <span className="material-icons text-gray-400 text-sm mt-0.5">email</span>
                        <span className="text-gray-700 break-all">{maskUserPII(u).email}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="material-icons text-gray-400 text-sm">schedule</span>
                        <span className="text-gray-600">
                          <DateDisplay dateString={u.lastLoginAt} />
                        </span>
                      </div>
                      {Object.keys(u.entitlements).length > 0 && (
                        <div className="flex items-start gap-2 mt-2 pt-2 border-t border-gray-100">
                          <span className="material-icons text-gray-400 text-sm mt-0.5">verified_user</span>
                          <span className="text-gray-600 text-xs">
                            {Object.keys(u.entitlements)
                              .filter((key) => u.entitlements[key])
                              .join(", ")}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* Desktop Table View */}
          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-left text-sm table-fixed">
              <colgroup>
                <col className="w-1/5" />
                <col className="w-2/5" />
                <col className="w-28" />
                <col className="w-24" />
                <col className="w-auto" />
              </colgroup>
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <button
                      onClick={() => handleSortChange("name-asc")}
                      className={`flex items-center gap-1 hover:text-blue-600 ${
                        sortBy === "name-asc" ? "text-blue-600 font-semibold" : ""
                      }`}
                    >
                      Name
                      {sortBy === "name-asc" && <span className="text-xs">↑</span>}
                    </button>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <button
                      onClick={() => handleSortChange("login-desc")}
                      className={`flex items-center gap-1 hover:text-blue-600 ${
                        sortBy === "login-desc" ? "text-blue-600 font-semibold" : ""
                      }`}
                    >
                      Last Login
                      {sortBy === "login-desc" && <span className="text-xs">↓</span>}
                    </button>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Entitlements
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {activeLoading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-600">
                      {showLoading ? (
                        <div className="flex items-center justify-center gap-2">
                          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                          <span>Loading users...</span>
                        </div>
                      ) : (
                        <div className="py-4"></div>
                      )}
                    </td>
                  </tr>
                ) : dataLoaded && active.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-600">
                      {debouncedSearchQuery && showAdminsOnly
                        ? `No admins/superusers found matching "${debouncedSearchQuery}"`
                        : debouncedSearchQuery
                          ? `No users found matching "${debouncedSearchQuery}"`
                          : showAdminsOnly
                            ? "No admins or superusers found"
                            : "No active users"}
                    </td>
                  </tr>
                ) : dataLoaded && active.length > 0 ? (
                  active.map((u) => (
                    <tr
                      key={u.email}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => {
                        window.location.href = `/admin/users/${encodeURIComponent(u.email)}`;
                      }}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <a
                          className="text-blue-600 hover:text-blue-800 font-medium"
                          href={`/admin/users/${encodeURIComponent(u.email)}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {getDisplayName(u)}
                        </a>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span title={maskUserPII(u).email} className="text-gray-900">
                          {truncateEmail(maskUserPII(u).email)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-900">{u.role || "–"}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-900">
                        <DateDisplay dateString={u.lastLoginAt} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-900">
                        {Object.keys(u.entitlements).length > 0
                          ? Object.keys(u.entitlements)
                              .filter((key) => u.entitlements[key])
                              .join(", ")
                          : "–"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-6 py-4"></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {!activeLoading && pagination && pagination.totalPages > 1 && (
            <div className="px-6 py-4 border-t border-gray-200 flex justify-center items-center gap-2">
              <button
                onClick={() => setCurrentPage(1)}
                disabled={!pagination.hasPrev}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                First
              </button>
              <button
                onClick={() => setCurrentPage(currentPage - 1)}
                disabled={!pagination.hasPrev}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Previous
              </button>

              <span className="px-3 py-1 text-sm text-gray-700">
                Page {pagination.page} of {pagination.totalPages}
              </span>

              <button
                onClick={() => setCurrentPage(currentPage + 1)}
                disabled={!pagination.hasNext}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Next
              </button>
              <button
                onClick={() => setCurrentPage(pagination.totalPages)}
                disabled={!pagination.hasNext}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Last
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <>
      <Head>
        <title>Admin · Dashboard</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="Admin Dashboard">
        <div className="max-w-4xl">{mainContent}</div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<AdminDashboardProps> = async (ctx) => {
  const req = ctx.req as unknown as NextApiRequest;
  const res = ctx.res as unknown as NextApiResponse;
  const siteConfig = await loadSiteConfig();
  const allowed = await isAdminPageAllowed(req, res, siteConfig);
  if (!allowed) {
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }
  // For render, treat allowed as sudo/admin presence
  return { props: { isSudoAdmin: true, siteConfig } };
};
