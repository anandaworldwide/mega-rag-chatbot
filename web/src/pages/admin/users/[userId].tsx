import React, { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { SiteConfig } from "@/types/siteConfig";
import type { GetServerSideProps, NextApiRequest } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isAdminPageAllowed } from "@/utils/server/adminPageGate";
import { AdminLayout } from "@/components/AdminLayout";
import { maskUserPII } from "@/utils/client/demoMode";

interface UserDetail {
  id: string;
  email: string;
  uuid: string | null;
  role: string;
  verifiedAt: string | null;
  lastLoginAt: string | null;
  entitlements: Record<string, any>;
  firstName?: string | null;
  lastName?: string | null;
  conversationCount?: number;
  newsletterSubscribed?: boolean;
  addedBy?: string | null;
  addedAt?: string | null;
  passwordSet?: boolean;
  passwordSetAt?: string | null;
}

interface PageProps {
  siteConfig: SiteConfig | null;
}

// Helper function to get display name
function getDisplayName(user: UserDetail): string {
  // Apply demo mode masking if enabled
  const maskedUser = maskUserPII(user);
  const firstName = maskedUser.firstName?.trim() || "";
  const lastName = maskedUser.lastName?.trim() || "";

  if (firstName && lastName) {
    return `${firstName} ${lastName}`;
  } else if (firstName) {
    return firstName;
  } else if (lastName) {
    return lastName;
  } else {
    return maskedUser.email; // Email comes from API response mapping (doc.id)
  }
}

export default function EditUserPage({ siteConfig }: PageProps) {
  const router = useRouter();
  const { userId } = router.query as { userId?: string };
  const [jwt, setJwt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserDetail | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("user");
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [newsletterSubscribed, setNewsletterSubscribed] = useState<boolean>(true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [currentUserRole, setCurrentUserRole] = useState<string>("user");

  useEffect(() => {
    async function getTokenAndRole() {
      try {
        const res = await fetch("/api/web-token");
        const data = await res.json();
        if (res.ok && data?.token) setJwt(data.token);

        // Fetch current user's role from profile
        const profileRes = await fetch("/api/profile");
        if (profileRes.ok) {
          const profileData = await profileRes.json();
          setCurrentUserRole(profileData?.role || "user");
        }
      } catch (e) {}
    }
    getTokenAndRole();
  }, []);

  useEffect(() => {
    if (!jwt || !userId) return;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(userId as string)}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load user");
        const u = data.user as UserDetail;
        setUser(u);
        setEmail(u.email);
        setRole(u.role || "user");
        setFirstName(typeof u.firstName === "string" ? u.firstName : "");
        setLastName(typeof u.lastName === "string" ? u.lastName : "");
        setNewsletterSubscribed(typeof u.newsletterSubscribed === "boolean" ? u.newsletterSubscribed : true);
      } catch (e: any) {
        setError(e?.message || "Failed to load user");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [jwt, userId]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      // Build update payload - only include role if it has changed
      const updates: any = {
        email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        newsletterSubscribed,
      };

      // Only include role if it has changed from the original
      if (role !== user.role) {
        updates.role = role;
      }

      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        const errorMessage = data?.error || "Failed to save";
        // If role change was rejected, reset role to original value
        if (errorMessage.toLowerCase().includes("role")) {
          setRole(user.role);
        }
        throw new Error(errorMessage);
      }
      const updatedUser = data.user as UserDetail;
      setUser(updatedUser);
      // Update form fields with the returned data
      setEmail(updatedUser.email);
      setRole(updatedUser.role || "user");
      setFirstName(typeof updatedUser.firstName === "string" ? updatedUser.firstName : "");
      setLastName(typeof updatedUser.lastName === "string" ? updatedUser.lastName : "");
      setNewsletterSubscribed(
        typeof updatedUser.newsletterSubscribed === "boolean" ? updatedUser.newsletterSubscribed : true
      );

      if (updatedUser.id !== user.id) {
        // Email changed → navigate to new route
        router.replace(`/admin/users/${encodeURIComponent(updatedUser.id)}`);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to save");
      // Scroll to top to show error message
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!user || !jwt) return;
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to delete user");

      // Redirect to admin dashboard after successful deletion
      router.push("/admin");
    } catch (e: any) {
      setError(e?.message || "Failed to delete user");
      setShowDeleteModal(false);
    } finally {
      setDeleting(false);
    }
  }

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{user ? getDisplayName(user) : "User"}</h1>
        <p className="text-sm text-gray-600 mt-1">Manage user account details and settings</p>
      </div>

      {/* Error message - shown at top but doesn't hide the form */}
      {error && <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      {loading ? (
        <div>Loading…</div>
      ) : !user ? (
        <div className="text-sm text-gray-700">User not found</div>
      ) : (
        <>
          {/* User Information Section */}
          <div className="mb-6 rounded border bg-gray-50 p-4">
            <h2 className="text-lg font-semibold mb-3">User Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium text-gray-700">UUID:</span>
                <div className="mt-1 font-mono text-xs bg-white p-2 rounded border">{user.uuid || "–"}</div>
              </div>
              <div>
                <span className="font-medium text-gray-700">Verified:</span>
                <div className="mt-1">
                  {user.verifiedAt ? (
                    <span className="text-green-600">✓ {new Date(user.verifiedAt).toLocaleString()}</span>
                  ) : (
                    <span className="text-gray-500">Not verified</span>
                  )}
                </div>
              </div>
              <div>
                <span className="font-medium text-gray-700">Last Login:</span>
                <div className="mt-1">
                  {user.lastLoginAt ? (
                    new Date(user.lastLoginAt).toLocaleString()
                  ) : (
                    <span className="text-gray-500">Never</span>
                  )}
                </div>
              </div>
              <div>
                <span className="font-medium text-gray-700">Added/Approved By:</span>
                <div className="mt-1">
                  {user.addedBy ? (
                    <>
                      <div className="font-medium text-gray-900">{user.addedBy}</div>
                      {user.addedAt && (
                        <div className="text-xs text-gray-500 mt-0.5">{new Date(user.addedAt).toLocaleString()}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-gray-500">Unknown</span>
                  )}
                </div>
              </div>
              <div>
                <span className="font-medium text-gray-700">Password:</span>
                <div className="mt-1">
                  {user.passwordSet ? (
                    <>
                      <span className="text-green-600">✓ Set</span>
                      {user.passwordSetAt && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          {new Date(user.passwordSetAt).toLocaleString()}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-gray-500">Not set - using magic link</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Question Activity Section */}
          <div className="mb-6 rounded border bg-gray-50 p-4">
            <h2 className="text-lg font-semibold mb-3">Questions Asked</h2>
            <div className="text-3xl font-bold text-blue-600">{user.conversationCount || 0}</div>
          </div>

          <form onSubmit={onSave} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="firstName" className="block text-sm font-medium mb-1">
                  First name
                </label>
                <input
                  id="firstName"
                  className="w-full rounded border px-3 py-2"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First name"
                />
              </div>
              <div>
                <label htmlFor="lastName" className="block text-sm font-medium mb-1">
                  Last name
                </label>
                <input
                  id="lastName"
                  className="w-full rounded border px-3 py-2"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Last name"
                />
              </div>
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="w-full rounded border px-3 py-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="mt-1 text-xs text-gray-600">Changing email keeps UUID and sessions intact.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              {currentUserRole === "superuser" ? (
                <>
                  <select className="rounded border px-3 py-2" value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                    <option value="superuser">superuser</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-600">Only superusers can change roles.</p>
                </>
              ) : (
                <>
                  <div className="w-full rounded border px-3 py-2 bg-gray-100 text-gray-700">{role}</div>
                  <p className="mt-1 text-xs text-gray-600">Only superusers can change roles.</p>
                </>
              )}
            </div>
            <div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={newsletterSubscribed}
                  onChange={(e) => setNewsletterSubscribed(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium">Newsletter subscription</span>
              </label>
            </div>
            <div className="flex justify-between">
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save Changes"}
                </button>
                <button type="button" className="rounded px-4 py-2 border" onClick={() => router.push("/admin")}>
                  Back
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowDeleteModal(true)}
                className="inline-flex items-center rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700 transition-colors"
              >
                Delete User
              </button>
            </div>
          </form>
        </>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && user && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Delete User</h3>
            <p className="text-sm text-gray-600 mb-6">
              Are you sure you want to delete <strong>{getDisplayName(user)}</strong> ({maskUserPII(user).email})?
              <br />
              <br />
              <span className="text-red-600 font-medium">This action cannot be undone.</span>
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="px-4 py-2 border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete User"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      <Head>
        <title>Admin · Edit User</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle={`Edit User: ${user ? getDisplayName(user) : "User"}`}>
        <div className="max-w-4xl">{mainContent}</div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async ({ req }) => {
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
