// Admin Approvals page: Review and process pending access requests
import React, { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { SiteConfig } from "@/types/siteConfig";
import type { GetServerSideProps } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isAdminPageAllowed } from "@/utils/server/adminPageGate";
import { AdminLayout } from "@/components/AdminLayout";
import { Modal } from "@/components/ui/Modal";

interface ApprovalRequest {
  requestId: string;
  requesterEmail: string;
  requesterName: string;
  adminEmail: string;
  adminName: string;
  adminLocation: string;
  referenceNote?: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  updatedAt: string;
  adminMessage?: string;
  processedBy?: string;
}

interface AdminApprovalsPageProps {
  siteConfig: SiteConfig | null;
}

export default function AdminApprovalsPage({ siteConfig }: AdminApprovalsPageProps) {
  const router = useRouter();
  const { request: requestId } = router.query;
  const [jwt, setJwt] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<ApprovalRequest | null>(null);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"info" | "error" | "success">("info");
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState<"approve" | "deny" | null>(null);
  const [adminMessage, setAdminMessage] = useState("");
  const [showLoading, setShowLoading] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

  // Initialize JWT and get user role
  useEffect(() => {
    const initJwt = async () => {
      const tokenRes = await fetch("/api/web-token");
      if (tokenRes.ok) {
        const data = await tokenRes.json();
        setJwt(data.token);
        // Decode token to get role
        try {
          const payload = JSON.parse(atob(data.token.split(".")[1]));
          setUserRole(payload.role);
        } catch (error) {
          console.error("Error decoding token:", error);
        }
      } else {
        const fullPath = window.location.pathname + (window.location.search || "");
        window.location.href = `/login?redirect=${encodeURIComponent(fullPath)}`;
      }
    };
    initJwt();
  }, []);

  // Fetch requests (pending by default; also fetch recently approved)
  useEffect(() => {
    if (!jwt) return;

    const fetchRequests = async () => {
      setLoading(true);
      setDataLoaded(false);

      // Show loading spinner only after 2 seconds
      const loadingTimer = setTimeout(() => {
        setShowLoading(true);
      }, 2000);

      try {
        const res = await fetch("/api/admin/pendingRequests", {
          headers: {
            Authorization: `Bearer ${jwt}`,
          },
        });

        const data = await res.json();

        if (!res.ok) {
          // Check if this is a Firestore index error
          if (data.type === "firestore_index_error") {
            const adminMessage = data.adminMessage || "Database configuration required";
            const indexUrl = data.indexUrl;
            const errorMessage = indexUrl ? `${adminMessage}\n\nFirebase Console: ${indexUrl}` : adminMessage;

            setMessage(errorMessage);
            setMessageType("error");
            return;
          }

          throw new Error(data.error || "Failed to fetch pending requests");
        }

        const pendingList = data.requests || [];
        // Additionally fetch recently approved for the "Recently Approved" section
        let approvedList: ApprovalRequest[] = [];
        try {
          const approvedRes = await fetch("/api/admin/pendingRequests?status=approved&limit=10", {
            headers: { Authorization: `Bearer ${jwt}` },
          });
          const approvedData = await approvedRes.json();
          if (!approvedRes.ok) {
            if (approvedData?.type === "firestore_index_error") {
              const adminMsg = approvedData.adminMessage || "Database configuration required";
              const idxUrl = approvedData.indexUrl;
              const composed = idxUrl ? `${adminMsg}\n\nFirebase Console: ${idxUrl}` : adminMsg;
              setMessage((prev) => (prev ? prev : composed));
              setMessageType("error");
            }
          } else {
            approvedList = approvedData.requests || [];
          }
        } catch (e) {
          // non-fatal
        }

        setRequests([...pendingList, ...approvedList]);

        // If there's a specific request ID in the URL, select it
        if (requestId && typeof requestId === "string") {
          const specificRequest = data.requests.find((r: ApprovalRequest) => r.requestId === requestId);
          if (specificRequest) {
            setSelectedRequest(specificRequest);
          }
        }
      } catch (error) {
        console.error("Error fetching requests:", error);
        setMessage("Failed to load pending requests");
        setMessageType("error");
      } finally {
        clearTimeout(loadingTimer);
        setLoading(false);
        setShowLoading(false);
        setDataLoaded(true);
      }
    };

    fetchRequests();
  }, [jwt, requestId]);

  const handleOpenActionModal = (request: ApprovalRequest, action: "approve" | "deny") => {
    setSelectedRequest(request);
    setActionType(action);
    setAdminMessage("");
    setShowActionModal(true);
  };

  const handleProcessRequest = async () => {
    if (!selectedRequest || !actionType || !jwt) return;

    setProcessing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/pendingRequests", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: selectedRequest.requestId,
          action: actionType,
          message: adminMessage.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to process request");
      }

      // Update the local state
      setRequests((prev) =>
        prev.map((req) =>
          req.requestId === selectedRequest.requestId
            ? { ...req, status: actionType === "approve" ? "approved" : "denied", updatedAt: new Date().toISOString() }
            : req
        )
      );

      setMessage(`Successfully ${actionType === "approve" ? "approved" : "denied"} the request`);
      setMessageType("success");
      setShowActionModal(false);
      setSelectedRequest(null);
      setAdminMessage("");
    } catch (error) {
      console.error("Error processing request:", error);
      setMessage(error instanceof Error ? error.message : "Failed to process request");
      setMessageType("error");
      // Close modal so user can see error message
      setShowActionModal(false);
      setSelectedRequest(null);
      setAdminMessage("");
    } finally {
      setProcessing(false);
    }
  };

  const pendingRequests = requests.filter((r) => r.status === "pending");
  const processedRequests = requests.filter((r) => r.status !== "pending");
  const recentlyApproved = processedRequests
    .filter((r) => r.status === "approved")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Pending Access Requests</h1>
        <p className="text-sm text-gray-600 mt-1">Review and process pending access requests</p>
      </div>

      {message && (
        <div
          className={`p-4 mb-6 rounded-md whitespace-pre-line ${
            messageType === "error"
              ? "bg-red-50 text-red-800"
              : messageType === "success"
                ? "bg-green-50 text-green-800"
                : "bg-blue-50 text-blue-800"
          }`}
        >
          {message}
        </div>
      )}

      {loading && showLoading && (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading requests...</p>
        </div>
      )}

      {dataLoaded && pendingRequests.length === 0 && (
        <div className="bg-gray-50 rounded-lg p-8 text-center">
          <p className="text-gray-600">No pending requests</p>
        </div>
      )}

      {dataLoaded && pendingRequests.length > 0 && (
        <div className="space-y-4">
          {pendingRequests.map((request) => (
            <div
              key={request.requestId}
              className={`bg-white border rounded-lg p-6 shadow-sm ${
                requestId === request.requestId ? "border-blue-500 border-2" : "border-gray-200"
              }`}
            >
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{request.requesterName}</h3>
                  <p className="text-sm text-gray-600">{request.requesterEmail}</p>
                </div>
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                  Pending
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
                <div>
                  <span className="text-gray-500">Requested:</span>
                  <span className="ml-2 text-gray-900">{new Date(request.createdAt).toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-gray-500">Location:</span>
                  <span className="ml-2 text-gray-900">{request.adminLocation}</span>
                </div>
              </div>

              {request.referenceNote && (
                <div className="mb-4 p-3 bg-gray-50 rounded-md text-sm">
                  <span className="text-gray-700 font-medium">Reference: </span>
                  <span className="text-gray-900">{request.referenceNote}</span>
                </div>
              )}

              {userRole === "superuser" && (
                <div className="mb-4 p-3 bg-blue-50 rounded-md text-sm">
                  <span className="text-blue-700 font-medium">Assigned to: </span>
                  <span className="text-blue-900">
                    {request.adminName} ({request.adminEmail})
                  </span>
                </div>
              )}

              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => handleOpenActionModal(request, "approve")}
                  className="flex-1 bg-green-500 text-white px-4 py-2 rounded-md hover:bg-green-600 transition-colors font-medium"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleOpenActionModal(request, "deny")}
                  className="flex-1 bg-red-500 text-white px-4 py-2 rounded-md hover:bg-red-600 transition-colors font-medium"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {dataLoaded &&
        ((userRole === "superuser" && recentlyApproved.length > 0) ||
          (userRole !== "superuser" && recentlyApproved.length > 0)) && (
          <div className="mt-8">
            <h2 className="text-2xl font-bold mb-4">Recently Approved</h2>
            <div className="space-y-4">
              {recentlyApproved.map((request) => (
                <div key={request.requestId} className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-semibold text-gray-900">{request.requesterName}</h3>
                      <p className="text-sm text-gray-600">{request.requesterEmail}</p>
                    </div>
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                      Approved
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm mt-2">
                    <div>
                      <span className="text-gray-500">Approved at:</span>
                      <span className="ml-2 text-gray-900">{new Date(request.updatedAt).toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Approved by:</span>
                      <span className="ml-2 text-gray-900">
                        {request.adminName} ({request.adminEmail})
                      </span>
                    </div>
                  </div>
                  {request.adminMessage && (
                    <p className="mt-2 text-sm text-gray-600 italic">&ldquo;{request.adminMessage}&rdquo;</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

      {/* Action Modal */}
      <Modal
        isOpen={showActionModal}
        onClose={() => {
          setShowActionModal(false);
          setAdminMessage("");
        }}
        title={actionType === "approve" ? "Approve Access Request" : "Deny Access Request"}
      >
        {selectedRequest && (
          <div className="space-y-4">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600 mb-1">Requester</p>
              <p className="font-semibold">{selectedRequest.requesterName}</p>
              <p className="text-sm text-gray-600">{selectedRequest.requesterEmail}</p>
              {selectedRequest.referenceNote && (
                <>
                  <p className="text-sm text-gray-600 mt-3 mb-1">Reference</p>
                  <p className="text-sm text-gray-900">{selectedRequest.referenceNote}</p>
                </>
              )}
            </div>

            <div>
              <label htmlFor="admin-message" className="block text-sm font-medium text-gray-700 mb-2">
                Message to User (Optional)
              </label>
              <textarea
                id="admin-message"
                value={adminMessage}
                onChange={(e) => setAdminMessage(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
                placeholder={
                  actionType === "approve" ? "Add a welcome message..." : "Optionally explain why access was denied..."
                }
              />
            </div>

            <div className="flex gap-3 pt-4">
              <button
                onClick={() => {
                  setShowActionModal(false);
                  setAdminMessage("");
                }}
                disabled={processing}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleProcessRequest}
                disabled={processing}
                className={`flex-1 px-4 py-2 text-white rounded-md transition-colors disabled:opacity-50 ${
                  actionType === "approve" ? "bg-green-500 hover:bg-green-600" : "bg-red-500 hover:bg-red-600"
                }`}
              >
                {processing ? "Processing..." : actionType === "approve" ? "Approve Request" : "Deny Request"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );

  return (
    <>
      <Head>
        <title>Pending Approvals - Admin</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="Pending Approvals">
        <div className="max-w-4xl">{mainContent}</div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const siteConfig = await loadSiteConfig();

  // Require login and admin access
  if (!(await isAdminPageAllowed(context.req as any, context.res as any, siteConfig))) {
    // Preserve the current URL for redirect after login
    const fullPath = context.resolvedUrl;
    return {
      redirect: {
        destination: `/login?redirect=${encodeURIComponent(fullPath)}`,
        permanent: false,
      },
    };
  }

  return {
    props: {
      siteConfig: JSON.parse(JSON.stringify(siteConfig)),
    },
  };
};
