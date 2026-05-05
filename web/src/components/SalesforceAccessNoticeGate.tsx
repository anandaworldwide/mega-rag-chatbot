import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import SalesforceAccessNoticeModal, {
  AdminApproverRegion,
  SalesforceAccessNoticeProfile,
} from "@/components/SalesforceAccessNoticeModal";
import { SiteConfig } from "@/types/siteConfig";
import { getEnableSalesforceAccessNotice } from "@/utils/client/siteConfig";

const SALESFORCE_ACCESS_NOTICE_VERSION = 1;
const NOTICE_SUPPRESSED_PATHS = ["/login", "/magic-login", "/forgot-password", "/reset-password", "/verify"];
const NOTICE_SUPPRESSED_PATH_PREFIXES = ["/answers/", "/share/"];

interface SalesforceAccessNoticeGateProps {
  siteConfig: SiteConfig | null;
}

interface ProfileResponse extends SalesforceAccessNoticeProfile {
  dismissedSalesforceAccessNotice?: boolean;
  dismissedSalesforceAccessNoticeVersion?: number | null;
  salesforceAccessVerificationDue?: boolean;
}

interface AdminApproversResponse {
  regions?: AdminApproverRegion[];
}

function shouldSuppressNoticeForPath(path: string): boolean {
  return NOTICE_SUPPRESSED_PATHS.includes(path) || NOTICE_SUPPRESSED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export default function SalesforceAccessNoticeGate({ siteConfig }: SalesforceAccessNoticeGateProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [adminRegions, setAdminRegions] = useState<AdminApproverRegion[]>([]);
  const [isLoadingAdmins, setIsLoadingAdmins] = useState(false);
  const [adminLoadError, setAdminLoadError] = useState<string | null>(null);
  const [hasCheckedProfile, setHasCheckedProfile] = useState(false);
  const hasStartedAdminRequestRef = useRef(false);
  const hasStartedSalesforceVerificationRef = useRef(false);

  const isFeatureEnabled = getEnableSalesforceAccessNotice(siteConfig);

  useEffect(() => {
    const currentPath = router.asPath.split("?")[0];
    const isSuppressedPath = shouldSuppressNoticeForPath(currentPath);
    if (!router.isReady || !isFeatureEnabled || hasCheckedProfile) return;

    if (isSuppressedPath) return;

    let isCancelled = false;

    async function fetchProfile(): Promise<ProfileResponse | null> {
      const response = await fetch("/api/profile", { credentials: "include" });
      if (!response.ok) return null;

      return (await response.json()) as ProfileResponse;
    }

    async function verifySalesforceAccess(): Promise<void> {
      try {
        await fetch("/api/salesforce/verifyAccess", {
          method: "POST",
          credentials: "include",
        });
      } catch {
        // Verification failures are recorded server-side; the notice can still show the last stored profile.
      }
    }

    async function loadProfile() {
      try {
        let data = await fetchProfile();
        if (!data || isCancelled) return;

        if (data.salesforceAccessVerificationDue === true && !hasStartedSalesforceVerificationRef.current) {
          hasStartedSalesforceVerificationRef.current = true;
          await verifySalesforceAccess();
          if (isCancelled) return;

          data = (await fetchProfile()) || data;
          if (isCancelled) return;
        }

        setProfile(data);
        const dismissedCurrentVersion =
          data.dismissedSalesforceAccessNotice === true ||
          (typeof data.dismissedSalesforceAccessNoticeVersion === "number" &&
            data.dismissedSalesforceAccessNoticeVersion >= SALESFORCE_ACCESS_NOTICE_VERSION);

        if (!dismissedCurrentVersion) {
          setIsOpen(true);
        }
      } catch {
        // The notice is informational; profile loading failures should not affect the app.
      } finally {
        if (!isCancelled) {
          setHasCheckedProfile(true);
        }
      }
    }

    loadProfile();

    return () => {
      isCancelled = true;
    };
  }, [hasCheckedProfile, isFeatureEnabled, router.asPath, router.isReady, siteConfig]);

  useEffect(() => {
    if (!isOpen || !profile || profile.salesforceMatchStatus === "matched") return;
    if (adminRegions.length > 0 || hasStartedAdminRequestRef.current || adminLoadError) return;

    let isCancelled = false;

    async function loadAdmins() {
      hasStartedAdminRequestRef.current = true;
      setIsLoadingAdmins(true);
      try {
        const response = await fetch("/api/admin/approvers", { credentials: "include" });
        if (!response.ok) {
          throw new Error("Failed to load Luca administrators.");
        }
        const data = (await response.json()) as AdminApproversResponse;
        if (!isCancelled) {
          setAdminRegions(Array.isArray(data.regions) ? data.regions : []);
        }
      } catch (error) {
        if (!isCancelled) {
          setAdminLoadError(error instanceof Error ? error.message : "Failed to load Luca administrators.");
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingAdmins(false);
        }
      }
    }

    loadAdmins();

    return () => {
      isCancelled = true;
    };
  }, [adminLoadError, adminRegions.length, isOpen, profile]);

  async function handleClose() {
    setIsOpen(false);

    try {
      await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          dismissedSalesforceAccessNoticeVersion: SALESFORCE_ACCESS_NOTICE_VERSION,
        }),
      });
    } catch {
      // If dismissal persistence fails, the notice can be shown again next time.
    }
  }

  if (!isFeatureEnabled) return null;

  return (
    <SalesforceAccessNoticeModal
      isOpen={isOpen}
      profile={profile}
      adminRegions={adminRegions}
      isLoadingAdmins={isLoadingAdmins}
      adminLoadError={adminLoadError}
      onClose={handleClose}
    />
  );
}
