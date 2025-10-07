import React, { useEffect, useState } from "react";
import Head from "next/head";
import { SiteConfig } from "@/types/siteConfig";
import type { GetServerSideProps, NextApiRequest, NextApiResponse } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isAdminPageAllowed } from "@/utils/server/adminPageGate";
import { AdminLayout } from "@/components/AdminLayout";
import Link from "next/link";
import { getToken } from "@/utils/client/tokenManager";
import { maskUserPII } from "@/utils/client/demoMode";

interface LeaderboardUser {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  uuid: string;
  questionCount: number;
  displayName: string;
}

interface AdminLeaderboardPageProps {
  siteConfig: SiteConfig | null;
  isSudoAdmin: boolean;
}

export default function AdminLeaderboardPage({ siteConfig }: AdminLeaderboardPageProps) {
  const [users, setUsers] = useState<LeaderboardUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /*
   * Fetch JWT and leaderboard in a single effect to avoid chained effect
   * timing issues that caused intermittent test instability.
   */
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // 1. Retrieve JWT
        const token = await getToken();
        if (!token) throw new Error("Missing authentication token");

        // 2. Fetch leaderboard
        const response = await fetch("/api/admin/leaderboard", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          if (response.status === 403) {
            throw new Error("Access denied. Admin privileges required.");
          }
          throw new Error(`Failed to fetch leaderboard: ${response.status}`);
        }

        const data = await response.json();
        setUsers(data.users || []);
      } catch (err) {
        console.error("Error loading leaderboard:", err);
        setError(err instanceof Error ? err.message : "Failed to load leaderboard");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">User Leaderboard</h1>
        <p className="text-sm text-gray-600 mt-1">Top 20 users by number of questions asked</p>
      </div>

      <div className="bg-white rounded-lg shadow-sm border">
        <div className="p-6">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="text-gray-500">Loading leaderboard...</div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <div className="text-red-800 text-sm">{error}</div>
            </div>
          )}

          {!loading && !error && users.length === 0 && (
            <div className="text-center py-8 text-gray-500">No users with questions found.</div>
          )}

          {!loading && !error && users.length > 0 && (
            <>
              {/* Mobile Card View */}
              <div className="lg:hidden space-y-3">
                {users.map((user, index) => (
                  <div
                    key={user.uuid}
                    className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-bold text-gray-900">#{index + 1}</span>
                        {index === 0 && <span className="text-yellow-500 material-icons text-xl">emoji_events</span>}
                        {index === 1 && <span className="text-gray-400 material-icons text-xl">emoji_events</span>}
                        {index === 2 && <span className="text-amber-600 material-icons text-xl">emoji_events</span>}
                      </div>
                      <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                        {user.questionCount.toLocaleString()} questions
                      </span>
                    </div>
                    <Link
                      href={`/admin/users/${encodeURIComponent(user.email)}`}
                      className="text-blue-600 hover:text-blue-800 font-semibold text-base block mb-2"
                    >
                      {user.displayName}
                    </Link>
                    <div className="flex items-start gap-2 text-sm">
                      <span className="material-icons text-gray-400 text-sm mt-0.5">email</span>
                      <span className="text-gray-600 break-all">{user.email}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop Table View */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Rank
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        User
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Email
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Questions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {users.map((user, index) => (
                      <tr key={user.uuid} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          <div className="flex items-center">
                            <span className="font-medium">#{index + 1}</span>
                            {index === 0 && (
                              <span className="ml-2 text-yellow-500 material-icons text-lg">emoji_events</span>
                            )}
                            {index === 1 && (
                              <span className="ml-2 text-gray-400 material-icons text-lg">emoji_events</span>
                            )}
                            {index === 2 && (
                              <span className="ml-2 text-amber-600 material-icons text-lg">emoji_events</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Link
                            href={`/admin/users/${encodeURIComponent(user.email)}`}
                            className="text-blue-600 hover:text-blue-800 font-medium"
                          >
                            {maskUserPII(user).firstName && maskUserPII(user).lastName
                              ? `${maskUserPII(user).firstName} ${maskUserPII(user).lastName}`
                              : maskUserPII(user).email}
                          </Link>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{maskUserPII(user).email}</td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                            {user.questionCount.toLocaleString()}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      <Head>
        <title>Admin · User Leaderboard</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="User Leaderboard">
        {mainContent}
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<AdminLeaderboardPageProps> = async (ctx) => {
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
  return { props: { isSudoAdmin: true, siteConfig } };
};
