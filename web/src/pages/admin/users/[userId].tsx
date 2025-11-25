import React, { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { SiteConfig } from "@/types/siteConfig";
import type { GetServerSideProps, NextApiRequest } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isAdminPageAllowed } from "@/utils/server/adminPageGate";
import { AdminLayout } from "@/components/AdminLayout";
import { maskUserPII, isDemoModeEnabled } from "@/utils/client/demoMode";
import { formatFullName } from "@/utils/shared/nameUtils";
import { getToken, fetchWithAuth } from "@/utils/client/tokenManager";

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
  isApprover?: boolean;
  approverLocation?: string | null;
  approverRegion?: string | null;
}

interface PageProps {
  siteConfig: SiteConfig | null;
}

// Helper function to get display name
function getDisplayName(user: UserDetail): string {
  // Apply demo mode masking if enabled
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

export default function EditUserPage({ siteConfig }: PageProps) {
  const router = useRouter();
  const { userId } = router.query as { userId?: string };
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
  const [isApprover, setIsApprover] = useState<boolean>(false);
  const [approverLocation, setApproverLocation] = useState<string>("");
  const [approverRegion, setApproverRegion] = useState<string>("");
  const [approversPreview, setApproversPreview] = useState<{
    lastUpdated: string;
    regions: Array<{ name: string; admins: Array<{ name: string; email: string; location: string }> }>;
  } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<boolean>(false);

  useEffect(() => {
    async function getTokenAndRole() {
      try {
        const token = await getToken();

        // Fetch current user's role from profile
        const profileRes = await fetchWithAuth("/api/profile", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (profileRes.ok) {
          const profileData = await profileRes.json();
          setCurrentUserRole(profileData?.role || "user");
        }
      } catch (e) {}
    }
    getTokenAndRole();
  }, []);

  useEffect(() => {
    if (!userId) return;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Authentication required");
        }

        const res = await fetchWithAuth(`/api/admin/users/${encodeURIComponent(userId as string)}`, {
          headers: { Authorization: `Bearer ${token}` },
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
        setIsApprover(typeof u.isApprover === "boolean" ? u.isApprover : false);
        setApproverLocation(typeof u.approverLocation === "string" && u.approverLocation ? u.approverLocation : "");
        setApproverRegion(typeof u.approverRegion === "string" && u.approverRegion ? u.approverRegion : "");
      } catch (e: any) {
        setError(e?.message || "Failed to load user");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [userId]);

  // Fetch approver list preview when approver is enabled
  useEffect(() => {
    if (!isApprover) {
      setApproversPreview(null);
      setLoadingPreview(false);
      return;
    }

    async function fetchPreview() {
      setLoadingPreview(true);
      try {
        const token = await getToken();
        if (!token) {
          setApproversPreview(null);
          return;
        }

        const res = await fetchWithAuth("/api/admin/approvers", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();

        if (res.ok && data.regions) {
          // Add current user to preview if they have approver settings but aren't saved yet
          const previewData = { ...data };
          const currentUserEmail = email.toLowerCase();
          const isUserInPreview = previewData.regions.some((region: any) =>
            region.admins.some((admin: any) => admin.email.toLowerCase() === currentUserEmail)
          );

          if (!isUserInPreview && (approverRegion || approverLocation)) {
            // Construct name from firstName/lastName
            const displayName = firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || email;

            const currentUserRegion = approverRegion || "Global";
            const currentUserLocation = approverLocation || "";

            // Find or create the region
            let regionIndex = previewData.regions.findIndex((r: any) => r.name === currentUserRegion);
            if (regionIndex === -1) {
              previewData.regions.push({
                name: currentUserRegion,
                admins: [],
              });
              regionIndex = previewData.regions.length - 1;
            }

            // Add current user to the region
            previewData.regions[regionIndex].admins.push({
              name: displayName,
              email: currentUserEmail,
              location: currentUserLocation,
            });
          }

          // Sort regions: alphabetically, but "Global" always last
          previewData.regions.sort((a: any, b: any) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aIsGlobal = aName === "global";
            const bIsGlobal = bName === "global";

            if (aIsGlobal && !bIsGlobal) return 1;
            if (!aIsGlobal && bIsGlobal) return -1;
            return aName.localeCompare(bName);
          });

          setApproversPreview(previewData);
        } else {
          console.warn("Failed to fetch approvers preview:", data);
          setApproversPreview(null);
        }
      } catch (e) {
        console.error("Error fetching approvers preview:", e);
        setApproversPreview(null);
      } finally {
        setLoadingPreview(false);
      }
    }

    fetchPreview();
  }, [isApprover, email, firstName, lastName, approverRegion, approverLocation]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Authentication required");
      }

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

      // Include approver fields if current user is superuser
      if (currentUserRole === "superuser") {
        updates.isApprover = isApprover;
        updates.approverLocation = approverLocation.trim() || null;
        updates.approverRegion = approverRegion.trim() || null;
      }

      const res = await fetchWithAuth(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(updates),
      });
      const data = await res.json();

      if (!res.ok) {
        const errorMessage = data?.error || "Failed to save";
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
      setIsApprover(typeof updatedUser.isApprover === "boolean" ? updatedUser.isApprover : false);
      setApproverLocation(
        typeof updatedUser.approverLocation === "string" && updatedUser.approverLocation
          ? updatedUser.approverLocation
          : ""
      );
      setApproverRegion(
        typeof updatedUser.approverRegion === "string" && updatedUser.approverRegion ? updatedUser.approverRegion : ""
      );

      // Refresh approver preview if approver is enabled or if we just updated approver settings
      if (updatedUser.isApprover || isApprover) {
        try {
          // Small delay to ensure cache is cleared
          await new Promise((resolve) => setTimeout(resolve, 100));
          const previewToken = await getToken();
          if (previewToken) {
            const previewRes = await fetchWithAuth("/api/admin/approvers", {
              headers: { Authorization: `Bearer ${previewToken}` },
            });
            const previewData = await previewRes.json();
            if (previewRes.ok && previewData.regions) {
              setApproversPreview(previewData);
            }
          }
        } catch (e) {
          // Silently fail - preview is optional
        }
      } else if (!updatedUser.isApprover) {
        // Clear preview if approver was disabled
        setApproversPreview(null);
      }

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
    if (!user) return;
    setDeleting(true);
    setError(null);

    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Authentication required");
      }

      const res = await fetchWithAuth(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.message || "Failed to delete user");
      }

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
                className="w-full rounded border px-3 py-2 disabled:bg-gray-100 disabled:cursor-not-allowed"
                value={isDemoModeEnabled() ? maskUserPII({ email, uuid: user?.uuid }).email : email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isDemoModeEnabled()}
              />
              <p className="mt-1 text-xs text-gray-600">
                {isDemoModeEnabled()
                  ? "Email editing is disabled in demo mode."
                  : "Changing email keeps UUID and sessions intact."}
              </p>
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

            {/* Approver Settings Section - Only visible for admin/superuser roles */}
            {(role === "admin" || role === "superuser") && (
              <div className="rounded border bg-gray-50 p-4">
                <h3 className="text-base font-semibold mb-3">Approver Settings</h3>
                {currentUserRole === "superuser" ? (
                  <div className="space-y-4">
                    <div>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isApprover}
                          onChange={(e) => setIsApprover(e.target.checked)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium">Enable as Approver</span>
                      </label>
                      <p className="mt-1 text-xs text-gray-600">
                        When enabled, this admin will appear in the approver list for approval requests.
                      </p>
                    </div>
                    {isApprover && (
                      <>
                        <div>
                          <label htmlFor="approverRegion" className="block text-sm font-medium mb-1">
                            Region
                          </label>
                          <input
                            id="approverRegion"
                            className="w-full rounded border px-3 py-2"
                            value={approverRegion}
                            onChange={(e) => setApproverRegion(e.target.value)}
                            placeholder="e.g., United States"
                            maxLength={200}
                          />
                          <p className="mt-1 text-xs text-gray-600">
                            Region name used to group approvers in the approver list (e.g., &quot;United States&quot;,
                            &quot;Europe&quot;).
                          </p>
                        </div>
                        <div>
                          <label htmlFor="approverLocation" className="block text-sm font-medium mb-1">
                            Location
                          </label>
                          <input
                            id="approverLocation"
                            className="w-full rounded border px-3 py-2"
                            value={approverLocation}
                            onChange={(e) => setApproverLocation(e.target.value)}
                            placeholder="e.g., Nevada City, CA"
                            maxLength={200}
                          />
                          <p className="mt-1 text-xs text-gray-600">
                            Specific location shown next to your name in the approver list (e.g., &quot;Nevada City,
                            CA&quot;).
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-gray-600">
                    {isApprover ? (
                      <>
                        <div className="mb-2">
                          <span className="font-medium text-gray-700">Status:</span>{" "}
                          <span className="text-green-600">Enabled as Approver</span>
                        </div>
                        {approverRegion && (
                          <div className="mb-2">
                            <span className="font-medium text-gray-700">Region:</span> {approverRegion}
                          </div>
                        )}
                        {approverLocation && (
                          <div>
                            <span className="font-medium text-gray-700">Location:</span> {approverLocation}
                          </div>
                        )}
                        <p className="mt-2 text-xs text-gray-500">Only superusers can modify approver settings.</p>
                      </>
                    ) : (
                      <div>
                        <span className="text-gray-500">Not configured as approver</span>
                        <p className="mt-1 text-xs text-gray-500">Only superusers can enable approver settings.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

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

          {/* Approver List Preview - Only show when approver is enabled */}
          {isApprover && (
            <div className="mt-8 rounded border bg-gray-50 p-4">
              <h2 className="text-lg font-semibold mb-3">Approver List Preview</h2>
              <p className="text-sm text-gray-600 mb-4">
                This is how the approver list appears to users on the login page:
              </p>
              {loadingPreview ? (
                <div className="flex justify-center items-center py-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                </div>
              ) : approversPreview && approversPreview.regions.length > 0 ? (
                <div className="bg-white rounded border border-gray-300 p-4">
                  <label htmlFor="approver-preview-select" className="block text-sm font-medium text-gray-700 mb-2">
                    Select an admin to contact
                  </label>
                  <select
                    id="approver-preview-select"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-white text-gray-700 cursor-pointer"
                    defaultValue=""
                  >
                    <option value="">-- Select an admin --</option>
                    {approversPreview.regions.map((region) => {
                      if (region.admins.length === 0) return null;

                      return (
                        <optgroup key={region.name} label={region.name}>
                          {region.admins.map((admin) => {
                            const isCurrentUser = admin.email.toLowerCase() === email.toLowerCase();
                            return (
                              <option
                                key={admin.email}
                                value={`${admin.email}|${admin.name}|${admin.location}`}
                                style={isCurrentUser ? { fontWeight: "bold", backgroundColor: "#dbeafe" } : {}}
                              >
                                {admin.name} ({admin.location}){isCurrentUser ? " ← this user" : ""}
                              </option>
                            );
                          })}
                        </optgroup>
                      );
                    })}
                  </select>
                  {approversPreview.regions.some((region) =>
                    region.admins.some((admin) => admin.email.toLowerCase() === email.toLowerCase())
                  ) && (
                    <p className="mt-3 text-sm text-blue-600 font-medium">
                      ✓ Your entry is highlighted in the list above
                    </p>
                  )}
                </div>
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <p className="text-yellow-800 text-sm">
                    No approvers found. Make sure approver settings are saved and the user has admin/superuser role.
                  </p>
                </div>
              )}
            </div>
          )}
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
