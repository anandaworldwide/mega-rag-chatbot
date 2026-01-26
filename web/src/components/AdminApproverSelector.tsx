import { useState, useEffect } from "react";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import { SiteConfig } from "@/types/siteConfig";

interface AdminApprover {
  name: string;
  email: string;
  location: string;
}

interface AdminApproverRegion {
  name: string;
  admins: AdminApprover[];
}

interface AdminApproversConfig {
  lastUpdated: string;
  regions: AdminApproverRegion[];
}

interface AdminApproverSelectorProps {
  requesterEmail: string;
  requesterName?: string;
  siteConfig?: SiteConfig | null;
  onSuccess?: () => void;
  onError?: (error: string) => void;
  onBack?: () => void;
}

export default function AdminApproverSelector({
  requesterEmail,
  requesterName: initialName,
  siteConfig,
  onSuccess,
  onError,
  onBack,
}: AdminApproverSelectorProps) {
  const [approversConfig, setApproversConfig] = useState<AdminApproversConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedAdmin, setSelectedAdmin] = useState<AdminApprover | null>(null);
  const [name, setName] = useState(initialName || "");
  const [referenceNote, setReferenceNote] = useState("");
  const [knowsAdmin, setKnowsAdmin] = useState<boolean | null>(null); // null = no selection
  const [nearestCenter, setNearestCenter] = useState("");
  const [connectionHistory, setConnectionHistory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Get config - prefer accessRequestConfig over deprecated accessRequestNoteLabel
  const accessConfig = siteConfig?.accessRequestConfig;
  const noteLabel = accessConfig?.noteLabel || siteConfig?.accessRequestNoteLabel;
  const showKnowsAdminQuestion = accessConfig?.showKnowsAdminQuestion ?? false;
  const unknownAdminFields = accessConfig?.unknownAdminFields;

  useEffect(() => {
    async function fetchApprovers() {
      try {
        const response = await fetchWithAuth("/api/admin/approvers", {
          method: "GET",
        });
        if (!response.ok) {
          throw new Error("Failed to fetch admin approvers");
        }
        const data = await response.json();
        setApproversConfig(data);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to load admin list";
        setError(errorMessage);
        onError?.(errorMessage);
      } finally {
        setLoading(false);
      }
    }

    fetchApprovers();
    // Only fetch once on mount - intentionally empty dependency array
    // eslint-disable-next-line
  }, []);

  const handleSelectChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (!value || !approversConfig) {
      setSelectedAdmin(null);
      return;
    }

    // Parse the value (format: "email|name|location")
    const [email, name, location] = value.split("|");
    setSelectedAdmin({ email, name, location });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!name.trim()) {
      setError("Please enter your full name");
      return;
    }

    if (!selectedAdmin) {
      setError("Please select an admin to contact");
      return;
    }

    // Only require reference note when it's visible (showKnowsAdminQuestion is false OR knowsAdmin is false)
    if (noteLabel && (!showKnowsAdminQuestion || knowsAdmin === false) && !referenceNote.trim()) {
      setError("Please provide a reference");
      return;
    }

    // Validate "Does this admin know you?" is answered
    if (showKnowsAdminQuestion && knowsAdmin === null) {
      setError("Please indicate whether this admin knows you");
      return;
    }

    // Validate additional fields when user doesn't know the admin
    if (showKnowsAdminQuestion && knowsAdmin === false && unknownAdminFields) {
      if (unknownAdminFields.nearestCenter?.required && !nearestCenter.trim()) {
        setError("Please select or enter your nearest center");
        return;
      }
      if (unknownAdminFields.connectionHistory?.required && !connectionHistory.trim()) {
        setError("Please describe your connection");
        return;
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetchWithAuth("/api/admin/requestApproval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requesterEmail,
          requesterName: name.trim(),
          adminEmail: selectedAdmin.email,
          adminName: selectedAdmin.name,
          adminLocation: selectedAdmin.location,
          // Only include referenceNote when it was shown (showKnowsAdminQuestion is false OR knowsAdmin is false)
          ...((!showKnowsAdminQuestion || knowsAdmin === false) &&
            referenceNote.trim() && {
              referenceNote: referenceNote.trim(),
            }),
          // Include additional context when "Does this admin know you?" is answered
          ...(showKnowsAdminQuestion &&
            knowsAdmin !== null && {
              knowsAdmin,
              ...(knowsAdmin === false && {
                nearestCenter: nearestCenter.trim() || undefined,
                connectionHistory: connectionHistory.trim() || undefined,
              }),
            }),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to submit approval request");
      }

      // Check if domain is whitelisted
      if (data.isWhitelisted && data.message === "activation-sent") {
        setInfo("Your email domain is approved. We're sending you an activation email immediately.");
        // Still call onSuccess since activation email was sent successfully
        setTimeout(() => {
          onSuccess?.();
        }, 2000); // Give user time to read the message
        return;
      }

      onSuccess?.();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to submit request";
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error && !approversConfig) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800 text-sm">{error}</p>
      </div>
    );
  }

  if (!approversConfig || approversConfig.regions.length === 0) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <p className="text-yellow-800 text-sm">No admin approvers are currently available. Please contact support.</p>
      </div>
    );
  }

  const hasAdmins = approversConfig.regions.some((region) => region.admins.length > 0);

  if (!hasAdmins) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <p className="text-yellow-800 text-sm">No admin approvers are currently available. Please contact support.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-blue-900 text-sm">
          Your email address is not recognized. Please enter your full name and select an admin from your region to
          request access.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="requester-name" className="block text-sm font-medium text-gray-700 mb-2">
            Full Name
          </label>
          <input
            id="requester-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            placeholder="Enter your full name"
            disabled={submitting}
            required
          />
        </div>

        <div>
          <label htmlFor="requester-email" className="block text-sm font-medium text-gray-700 mb-2">
            Email Address
          </label>
          <input
            id="requester-email"
            type="email"
            value={requesterEmail}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-100 text-gray-600"
            disabled
            readOnly
          />
        </div>

        <div>
          <label htmlFor="admin-selector" className="block text-sm font-medium text-gray-700 mb-2">
            Select an admin to contact
          </label>
          <select
            id="admin-selector"
            value={selectedAdmin ? `${selectedAdmin.email}|${selectedAdmin.name}|${selectedAdmin.location}` : ""}
            onChange={handleSelectChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            disabled={submitting}
            required
          >
            <option value="">-- Select an admin --</option>
            {approversConfig.regions.map((region) => {
              if (region.admins.length === 0) return null;

              return (
                <optgroup key={region.name} label={region.name}>
                  {region.admins.map((admin) => (
                    <option key={admin.email} value={`${admin.email}|${admin.name}|${admin.location}`}>
                      {admin.name} ({admin.location})
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>

        {/* "Does this admin know you?" radio buttons - only show when enabled and admin is selected */}
        {showKnowsAdminQuestion && selectedAdmin && (
          <div className="space-y-4">
            <fieldset>
              <legend className="block text-sm font-medium text-gray-700 mb-2">Does this admin know you?</legend>
              <div className="flex gap-6">
                <div className="flex items-center">
                  <input
                    id="knows-admin-yes"
                    name="knows-admin"
                    type="radio"
                    checked={knowsAdmin === true}
                    onChange={() => setKnowsAdmin(true)}
                    className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    disabled={submitting}
                  />
                  <label htmlFor="knows-admin-yes" className="ml-2 text-sm text-gray-700">
                    Yes
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    id="knows-admin-no"
                    name="knows-admin"
                    type="radio"
                    checked={knowsAdmin === false}
                    onChange={() => setKnowsAdmin(false)}
                    className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    disabled={submitting}
                  />
                  <label htmlFor="knows-admin-no" className="ml-2 text-sm text-gray-700">
                    No
                  </label>
                </div>
              </div>
            </fieldset>

            {/* Additional fields when admin doesn't know the user */}
            {knowsAdmin === false && unknownAdminFields && (
              <div className="pl-7 space-y-4 border-l-2 border-blue-200">
                {/* Nearest Center field */}
                {unknownAdminFields.nearestCenter && (
                  <div>
                    <label htmlFor="nearest-center" className="block text-sm font-medium text-gray-700 mb-2">
                      {unknownAdminFields.nearestCenter.label}
                    </label>
                    {unknownAdminFields.nearestCenter.type === "select" && unknownAdminFields.nearestCenter.options ? (
                      <select
                        id="nearest-center"
                        value={nearestCenter}
                        onChange={(e) => setNearestCenter(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        disabled={submitting}
                        required={unknownAdminFields.nearestCenter.required}
                      >
                        <option value="">-- Select --</option>
                        {unknownAdminFields.nearestCenter.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="nearest-center"
                        type="text"
                        value={nearestCenter}
                        onChange={(e) => setNearestCenter(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        placeholder={unknownAdminFields.nearestCenter.placeholder || "Enter your nearest center"}
                        disabled={submitting}
                        required={unknownAdminFields.nearestCenter.required}
                      />
                    )}
                  </div>
                )}

                {/* Connection History field */}
                {unknownAdminFields.connectionHistory && (
                  <div>
                    <label htmlFor="connection-history" className="block text-sm font-medium text-gray-700 mb-2">
                      {unknownAdminFields.connectionHistory.label}
                    </label>
                    <textarea
                      id="connection-history"
                      value={connectionHistory}
                      onChange={(e) => setConnectionHistory(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      placeholder={unknownAdminFields.connectionHistory.placeholder || ""}
                      rows={3}
                      disabled={submitting}
                      required={unknownAdminFields.connectionHistory.required}
                    />
                  </div>
                )}

                {/* Reference note - inside the indented section for "No" answers */}
                {noteLabel && (
                  <div>
                    <label htmlFor="reference-note" className="block text-sm font-medium text-gray-700 mb-2">
                      {noteLabel}
                    </label>
                    <textarea
                      id="reference-note"
                      value={referenceNote}
                      onChange={(e) => setReferenceNote(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Enter the name and location of someone who knows you"
                      rows={3}
                      disabled={submitting}
                      required
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Reference note - only show outside the indented section when showKnowsAdminQuestion is disabled (old behavior) */}
        {noteLabel && !showKnowsAdminQuestion && (
          <div>
            <label htmlFor="reference-note" className="block text-sm font-medium text-gray-700 mb-2">
              {noteLabel}
            </label>
            <textarea
              id="reference-note"
              value={referenceNote}
              onChange={(e) => setReferenceNote(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              placeholder="Enter the name and location of someone who knows you"
              rows={3}
              disabled={submitting}
              required
            />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-red-800 text-sm">{error}</p>
          </div>
        )}
        {info && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3" aria-live="polite">
            <p className="text-green-700 text-sm">{info}</p>
          </div>
        )}

        <div className="flex gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              disabled={submitting}
              className="px-6 py-2 border border-gray-300 text-gray-700 font-medium rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Change Email
            </button>
          )}
          <button
            type="submit"
            disabled={
              !name.trim() ||
              !selectedAdmin ||
              (noteLabel && (!showKnowsAdminQuestion || knowsAdmin === false) && !referenceNote.trim()) ||
              (showKnowsAdminQuestion && knowsAdmin === null) ||
              (showKnowsAdminQuestion &&
                knowsAdmin === false &&
                unknownAdminFields?.nearestCenter?.required &&
                !nearestCenter.trim()) ||
              (showKnowsAdminQuestion &&
                knowsAdmin === false &&
                unknownAdminFields?.connectionHistory?.required &&
                !connectionHistory.trim()) ||
              submitting
            }
            className="flex-1 bg-blue-500 text-white font-medium py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Submitting Request..." : "Request Access"}
          </button>
        </div>
      </form>

      {selectedAdmin && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-gray-700 text-sm">
            Your request will be sent to <strong>{selectedAdmin.name}</strong> in {selectedAdmin.location}. You&apos;ll
            receive a confirmation email and be notified once your request is reviewed.
          </p>
        </div>
      )}
    </div>
  );
}
