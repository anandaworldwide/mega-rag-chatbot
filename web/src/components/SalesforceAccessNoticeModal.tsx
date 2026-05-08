export interface SalesforceAccessNoticeProfile {
  accessLevelLabel?: string | null;
  accessLevelSource?: "superuser" | "salesforce" | "manual" | "default" | string | null;
  manualAccessLevelLabel?: string | null;
  salesforceAccessLevelLabel?: string | null;
  salesforceId?: string | null;
  salesforceMatchStatus?: string | null;
  salesforceContactEmail?: string | null;
}

export interface AdminApprover {
  name: string;
  email: string;
  location: string;
}

export interface AdminApproverRegion {
  name: string;
  admins: AdminApprover[];
}

interface SalesforceAccessNoticeModalProps {
  isOpen: boolean;
  profile: SalesforceAccessNoticeProfile | null;
  adminRegions: AdminApproverRegion[];
  isLoadingAdmins: boolean;
  adminLoadError: string | null;
  onClose: () => void;
}

function getDisplayLevel(profile: SalesforceAccessNoticeProfile | null): string {
  return profile?.accessLevelLabel || "Public";
}

function isSalesforceConnected(profile: SalesforceAccessNoticeProfile | null): boolean {
  return profile?.salesforceMatchStatus === "matched" && Boolean(profile?.salesforceId);
}

export default function SalesforceAccessNoticeModal({
  isOpen,
  profile,
  adminRegions,
  isLoadingAdmins,
  adminLoadError,
  onClose,
}: SalesforceAccessNoticeModalProps) {
  if (!isOpen) return null;

  const salesforceConnected = isSalesforceConnected(profile);
  const effectiveLevel = getDisplayLevel(profile);
  const salesforceLevel = profile?.salesforceAccessLevelLabel || effectiveLevel;
  const salesforceContactEmail = profile?.salesforceContactEmail?.trim() || null;
  const regionsWithAdmins = adminRegions.filter((region) => region.admins.length > 0);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="salesforce-access-notice-title"
      >
        <div className="border-b border-blue-100 bg-blue-50 px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-blue-700">Library access update</p>
              <h2 id="salesforce-access-notice-title" className="mt-1 text-xl font-semibold text-gray-900">
                Your Luca access level
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-gray-500 hover:bg-white hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Close"
            >
              <span className="material-icons" aria-hidden="true">
                close
              </span>
            </button>
          </div>
        </div>

        <div className="space-y-5 px-6 py-5">
          <p className="text-sm leading-6 text-gray-700">
            Luca is starting to use Ananda&apos;s centralized membership records—the same information Ananda maintains for
            programs across the organization—to decide which library materials can appear in your search and chat
            results.
          </p>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <p className="text-sm text-gray-600">Current access level</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{effectiveLevel}</p>
          </div>

          {salesforceConnected ? (
            <div className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm font-semibold text-green-900">Membership records: linked</p>
              <p className="text-sm text-green-900">
                Your centralized membership shows your access level as: <strong className="font-semibold">{salesforceLevel}</strong>.
              </p>
              <p className="text-sm leading-6 text-green-900">
                If this does not look right,{" "}
                {salesforceContactEmail ? (
                  <>
                    contact{" "}
                    <a className="font-medium underline" href={`mailto:${salesforceContactEmail}`}>
                      {salesforceContactEmail}
                    </a>
                  </>
                ) : (
                  "contact Ananda membership support"
                )}{" "}
                so your membership record can be updated.
              </p>
            </div>
          ) : (
            <div className="space-y-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm font-semibold text-blue-900">Membership records: not linked yet</p>
              <p className="text-sm leading-6 text-blue-900">
                If this does not look right, contact a Luca administrator you know and ask them to set your level
                appropriately.
              </p>

              <details className="rounded-lg border border-blue-100 bg-white p-4">
                <summary className="cursor-pointer text-sm font-semibold text-gray-900 marker:text-blue-700">
                  Luca administrators
                </summary>
                {isLoadingAdmins && <p className="mt-2 text-sm text-gray-600">Loading administrators...</p>}
                {adminLoadError && <p className="mt-2 text-sm text-red-700">{adminLoadError}</p>}
                {!isLoadingAdmins && !adminLoadError && regionsWithAdmins.length === 0 && (
                  <p className="mt-2 text-sm text-gray-600">No Luca administrators are currently listed.</p>
                )}
                {!isLoadingAdmins && !adminLoadError && regionsWithAdmins.length > 0 && (
                  <div className="mt-3 space-y-4">
                    {regionsWithAdmins.map((region) => (
                      <section key={region.name}>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{region.name}</h4>
                        <ul className="mt-2 space-y-2">
                          {region.admins.map((admin) => (
                            <li key={admin.email} className="rounded-md border border-gray-200 p-3">
                              <p className="text-sm font-medium text-gray-900">{admin.name}</p>
                              <p className="text-sm text-gray-600">{admin.location}</p>
                              <a className="text-sm font-medium text-blue-700 underline" href={`mailto:${admin.email}`}>
                                {admin.email}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
              </details>
            </div>
          )}

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm leading-6 text-amber-900">
            We are still adding access-level metadata across the library. If you have a higher level of access, such as
            Kriyaban, you will gradually start seeing more of that material in results as content is tagged.
            </p>
          </div>
        </div>

        <div className="border-t border-gray-200 bg-gray-50 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
