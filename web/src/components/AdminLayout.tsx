import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { SiteConfig } from "@/types/siteConfig";
import AnandaHeader from "./Header/AnandaHeader";
import AnandaPublicHeader from "./Header/AnandaPublicHeader";
import JairamHeader from "./Header/JairamHeader";
import CrystalHeader from "./Header/CrystalHeader";
import PhotoHeader from "./Header/PhotoHeader";
import Footer from "./Footer";
import { SudoProvider } from "@/contexts/SudoContext";
import { AdminAccessGuidelines } from "./AdminAccessGuidelines";
import { SuperuserOnlyBadge } from "./SuperuserOnlyBadge";

interface AdminLayoutProps {
  siteConfig: SiteConfig | null;
  children: React.ReactNode;
  pageTitle?: string;
  /** When true, shows a "Superuser only" affordance (page is gated via isSuperuserPageAllowed). */
  superuserOnly?: boolean;
}

interface PendingCounts {
  approvals: number;
  invitations: number;
}

export function AdminLayout({ siteConfig, children, pageTitle, superuserOnly = false }: AdminLayoutProps) {
  const router = useRouter();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [pendingCounts, setPendingCounts] = useState<PendingCounts>({ approvals: 0, invitations: 0 });
  const [isSuperuser, setIsSuperuser] = useState(false);

  const loginRequired = !!siteConfig?.requireLogin;
  const emailBlacklistEnabled = loginRequired && siteConfig?.enableEmailBlacklist !== false;

  // Fetch pending counts for badges (only for login-required sites)
  useEffect(() => {
    // Skip fetching counts for sites that don't require login
    if (!loginRequired) {
      return;
    }

    const fetchCounts = async () => {
      try {
        // Try to get JWT for API calls
        const tokenRes = await fetch("/api/web-token");
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          const token = tokenData.token;

          // Fetch pending approvals count
          const approvalsRes = await fetch("/api/admin/pendingRequests", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (approvalsRes.ok) {
            const approvalsData = await approvalsRes.json();
            const pendingApprovals = approvalsData.requests?.filter((r: any) => r.status === "pending") || [];
            setPendingCounts((prev) => ({ ...prev, approvals: pendingApprovals.length }));
          }

          // Fetch pending invitations count
          const invitesRes = await fetch("/api/admin/pendingUsersCount", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (invitesRes.ok) {
            const invitesData = await invitesRes.json();
            setPendingCounts((prev) => ({ ...prev, invitations: invitesData.count || 0 }));
          }
        }
      } catch (error) {
        console.error("Failed to fetch admin counts:", error);
      }
    };

    fetchCounts();
  }, [loginRequired]);

  // Fetch user role to determine if superuser
  useEffect(() => {
    const fetchRole = async () => {
      // Early return: Skip API call if site doesn't require login
      // For non-login sites, superuser status is determined server-side via getServerSideProps
      if (!loginRequired) {
        return;
      }

      // Check sessionStorage cache first
      try {
        const cached = sessionStorage.getItem("userRole");
        if (cached) {
          const { role, timestamp } = JSON.parse(cached);
          // Cache valid for 1 hour
          if (Date.now() - timestamp < 60 * 60 * 1000) {
            setIsSuperuser(role === "superuser");
            return;
          }
        }
      } catch {
        // Invalid cache, continue to API call
      }

      // Make API call only when necessary
      try {
        const res = await fetch("/api/profile", { credentials: "include" });
        if (!res.ok) {
          setIsSuperuser(false);
          return;
        }

        const data = await res.json();
        const role = (data?.role as string) || "user";
        const isSuper = role === "superuser";

        // Cache the result
        try {
          sessionStorage.setItem(
            "userRole",
            JSON.stringify({
              role,
              timestamp: Date.now(),
            })
          );
        } catch {
          // sessionStorage failed, continue without caching
        }

        setIsSuperuser(isSuper);
      } catch {
        setIsSuperuser(false);
      }
    };

    fetchRole();
  }, [loginRequired]);

  // Render the appropriate header based on siteConfig
  const renderHeader = () => {
    if (!siteConfig) return null;

    const headerPropsNoTempSessions = {
      siteConfig,
      onNewChat: undefined,
    };

    switch (siteConfig.siteId) {
      case "ananda":
        return <AnandaHeader {...headerPropsNoTempSessions} />;
      case "ananda-public":
        return <AnandaPublicHeader {...headerPropsNoTempSessions} />;
      case "jairam":
        return <JairamHeader {...headerPropsNoTempSessions} />;
      case "crystal":
        return <CrystalHeader {...headerPropsNoTempSessions} />;
      case "photo":
        return <PhotoHeader {...headerPropsNoTempSessions} />;
      default:
        return null;
    }
  };

  const LeftRail = () => (
    <div className="w-64 bg-gray-50 border-r border-gray-200 p-6 overflow-y-auto">
      {/* Admin Panel Header */}
      <div className="mb-6 pb-6 border-b-2 border-blue-600">
        <div className="flex items-center gap-2 mb-2">
          <span className="material-icons text-blue-600 text-2xl">admin_panel_settings</span>
          <h2 className="text-xl font-bold text-gray-900">Admin Panel</h2>
        </div>
        <p className="text-xs text-gray-600">System Management</p>
      </div>

      <div className="space-y-8">
        {/* USERS Section - Only show for sites that require login */}
        {loginRequired && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-3">Users</h3>
            <nav className="space-y-1">
              <Link
                href="/admin"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">group</span>
                Users List
              </Link>

              <Link
                href="/admin/users/add"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin/users/add"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">person_add</span>
                Add Users
              </Link>

              <Link
                href="/admin/approvals"
                className={`flex items-center px-3 py-2 text-sm rounded-md relative ${
                  router.pathname === "/admin/approvals"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">pending_actions</span>
                Pending Approvals
                {pendingCounts.approvals > 0 && (
                  <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-500 text-white">
                    {pendingCounts.approvals}
                  </span>
                )}
              </Link>

              <Link
                href="/admin/users/pending"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin/users/pending"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">schedule</span>
                Pending Invitations
                {pendingCounts.invitations > 0 && (
                  <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500 text-white">
                    {pendingCounts.invitations}
                  </span>
                )}
              </Link>

              <Link
                href="/admin/leaderboard"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin/leaderboard"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">leaderboard</span>
                Leaderboard
              </Link>
            </nav>
          </div>
        )}

        {/* OTHER Section */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-3">Other</h3>
          <nav className="space-y-1">
            {isSuperuser && (
              <Link
                href="/answers"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/answers"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">question_answer</span>
                View All Answers
                <span
                  className="material-icons text-xs ml-auto shrink-0 opacity-60"
                  aria-hidden="true"
                  title="Superuser only"
                >
                  lock
                </span>
              </Link>
            )}
            {isSuperuser && (
              <Link
                href="/admin/downvotes"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin/downvotes"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">thumb_down</span>
                Review Downvotes
                <span
                  className="material-icons text-xs ml-auto shrink-0 opacity-60"
                  aria-hidden="true"
                  title="Superuser only"
                >
                  lock
                </span>
              </Link>
            )}

            {loginRequired && isSuperuser && (
              <Link
                href="/admin/newsletters"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin/newsletters"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">email</span>
                Newsletter Management
                <span
                  className="material-icons text-xs ml-auto shrink-0 opacity-60"
                  aria-hidden="true"
                  title="Superuser only"
                >
                  lock
                </span>
              </Link>
            )}
            {emailBlacklistEnabled && isSuperuser && (
              <Link
                href="/admin/blacklist"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin/blacklist"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">block</span>
                Email Blacklist
                <span
                  className="material-icons text-xs ml-auto shrink-0 opacity-60"
                  aria-hidden="true"
                  title="Superuser only"
                >
                  lock
                </span>
              </Link>
            )}
            <Link
              href="/admin/model-performance"
              className={`flex items-center px-3 py-2 text-sm rounded-md ${
                router.pathname === "/admin/model-performance"
                  ? "bg-blue-100 text-blue-700 font-semibold"
                  : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              <span className="material-icons text-sm mr-2">speed</span>
              Model Performance
            </Link>
            <Link
              href="/stats"
              className={`flex items-center px-3 py-2 text-sm rounded-md ${
                router.pathname === "/stats"
                  ? "bg-blue-100 text-blue-700 font-semibold"
                  : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              <span className="material-icons text-sm mr-2">trending_up</span>
              Statistics
            </Link>
            {isSuperuser && (
              <Link
                href="/admin/cron-jobs"
                className={`flex items-center px-3 py-2 text-sm rounded-md ${
                  router.pathname === "/admin/cron-jobs"
                    ? "bg-blue-100 text-blue-700 font-semibold"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <span className="material-icons text-sm mr-2">schedule</span>
                Trigger Cron Jobs
                <span
                  className="material-icons text-xs ml-auto shrink-0 opacity-60"
                  aria-hidden="true"
                  title="Superuser only"
                >
                  lock
                </span>
              </Link>
            )}
          </nav>
        </div>
      </div>
    </div>
  );

  return (
    <SudoProvider disableChecks={loginRequired}>
      <div className="min-h-screen bg-white flex flex-col">
        {/* Site Header */}
        {renderHeader()}

        {/* Admin Content Area */}
        <div className="flex-1 flex flex-col">
          {/* Mobile Header */}
          <div className="lg:hidden flex items-center justify-between p-4 border-b-2 border-blue-600 bg-white">
            <div className="flex items-center">
              <button
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                className="p-2 rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                aria-label="Toggle navigation menu"
              >
                <span className="material-icons">{isMobileMenuOpen ? "close" : "menu"}</span>
              </button>
              <span className="material-icons text-blue-600 text-xl ml-2">admin_panel_settings</span>
              <h1 className="ml-2 text-lg font-semibold text-gray-900 flex items-center gap-1">
                {pageTitle || "Admin Dashboard"}
                {superuserOnly && (
                  <span
                    className="material-icons text-base text-purple-700 shrink-0"
                    aria-hidden="true"
                    title="Only superusers can access this page."
                  >
                    lock
                  </span>
                )}
              </h1>
            </div>
          </div>

          {/* Mobile Menu Overlay */}
          {isMobileMenuOpen && (
            <div
              className="lg:hidden fixed inset-0 z-50 bg-black bg-opacity-50"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <div
                className="fixed left-0 top-0 bottom-0 w-64 bg-white shadow-lg transform transition-transform duration-300 ease-in-out"
                onClick={(e) => e.stopPropagation()}
              >
                <LeftRail />
              </div>
            </div>
          )}

          {/* Desktop Layout */}
          <div className="flex">
            {/* Desktop Left Rail */}
            <div className="hidden lg:block">
              <LeftRail />
            </div>

            {/* Main Content */}
            <div className="flex-1 min-w-0">
              <div className="max-w-screen-2xl mx-auto p-6">
                {superuserOnly && (
                  <div className="mb-4">
                    <SuperuserOnlyBadge />
                  </div>
                )}
                {/* Access Guidelines Banner - Dismissible with localStorage persistence */}
                <AdminAccessGuidelines siteConfig={siteConfig} />
                {children}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <Footer siteConfig={siteConfig} />
      </div>
    </SudoProvider>
  );
}
