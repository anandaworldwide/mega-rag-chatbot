import { db } from "@/services/firebase";
import type { AccessControlConfig, AccessControlLevelConfig, SiteConfig } from "@/types/siteConfig";
import type { User } from "@/types/user";
import { getUsersCollectionName } from "./firestoreUtils";
import { firestoreGet } from "./firestoreRetryUtils";

export type AccessLevelSource = "superuser" | "salesforce" | "manual" | "default";

export interface EffectiveAccessLevel {
  level: number;
  label: string;
  source: AccessLevelSource;
}

export interface ManualAccessLevelValidationResult {
  valid: boolean;
  level?: number;
  error?: string;
}

type PineconeFilterClause = Record<string, any>;

const FALLBACK_LEVELS: AccessControlLevelConfig[] = [{ key: "public", label: "Public", value: 0 }];

function getAccessControl(siteConfig: SiteConfig | null | undefined): AccessControlConfig | null {
  const accessControl = siteConfig?.accessControl;
  if (!accessControl?.enabled || !Array.isArray(accessControl.levels) || accessControl.levels.length === 0) {
    return null;
  }
  return accessControl;
}

export function isAccessControlEnabled(siteConfig: SiteConfig | null | undefined): boolean {
  return getAccessControl(siteConfig) !== null;
}

export function getConfiguredAccessLevels(siteConfig: SiteConfig | null | undefined): AccessControlLevelConfig[] {
  const accessControl = getAccessControl(siteConfig);
  const levels = accessControl?.levels || FALLBACK_LEVELS;
  return [...levels].sort((a, b) => a.value - b.value);
}

export function getDefaultAccessLevel(siteConfig: SiteConfig | null | undefined): number {
  const accessControl = getAccessControl(siteConfig);
  return normalizeAccessLevelValue(accessControl?.defaultLevel, siteConfig) ?? 0;
}

export function getSuperuserAccessLevel(siteConfig: SiteConfig | null | undefined): number {
  const accessControl = getAccessControl(siteConfig);
  if (!accessControl) return 0;
  const configured = normalizeAccessLevelValue(accessControl.superuserLevel, siteConfig);
  if (configured !== null) return configured;
  return Math.max(...getConfiguredAccessLevels(siteConfig).map((level) => level.value));
}

export function normalizeAccessLevelValue(value: unknown, siteConfig: SiteConfig | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) return null;

    const numericValue = Number(trimmedValue);
    if (Number.isFinite(numericValue)) {
      return Math.trunc(numericValue);
    }

    return getAccessLevelValueForKey(trimmedValue, siteConfig);
  }

  return null;
}

export function getAccessLevelLabel(value: unknown, siteConfig: SiteConfig | null | undefined): string {
  const normalizedValue = normalizeAccessLevelValue(value, siteConfig);
  if (normalizedValue === null) return "Public";

  if (isAccessControlEnabled(siteConfig) && normalizedValue === getSuperuserAccessLevel(siteConfig)) {
    return "Superuser";
  }

  const exactLevel = getConfiguredAccessLevels(siteConfig).find((level) => level.value === normalizedValue);
  if (exactLevel) return exactLevel.label;

  return `Level ${normalizedValue}`;
}

export function getAccessLevelValueForKey(value: string, siteConfig: SiteConfig | null | undefined): number | null {
  const normalizedKey = normalizeAccessLevelKey(value);
  for (const level of getConfiguredAccessLevels(siteConfig)) {
    const acceptedKeys = [level.key, level.label].map(normalizeAccessLevelKey);
    if (acceptedKeys.includes(normalizedKey)) {
      return level.value;
    }
  }

  return null;
}

export function resolveEffectiveAccessLevel(
  user:
    | Pick<
        User,
        "role" | "manualAccessLevel" | "salesforceAccessLevel" | "accessLevel" | "salesforceId" | "salesforceMatchStatus"
      >
    | Record<string, any>
    | null,
  siteConfig: SiteConfig | null | undefined
): EffectiveAccessLevel {
  if (!isAccessControlEnabled(siteConfig)) {
    return {
      level: getDefaultAccessLevel(siteConfig),
      label: getAccessLevelLabel(getDefaultAccessLevel(siteConfig), siteConfig),
      source: "default",
    };
  }

  const role = typeof user?.role === "string" ? user.role.toLowerCase() : "user";
  if (role === "superuser") {
    const level = getSuperuserAccessLevel(siteConfig);
    return { level, label: getAccessLevelLabel(level, siteConfig), source: "superuser" };
  }

  const salesforceLevel = hasValidSalesforceMatch(user)
    ? normalizeAccessLevelValue(user?.salesforceAccessLevel, siteConfig)
    : null;
  if (salesforceLevel !== null) {
    return { level: salesforceLevel, label: getAccessLevelLabel(salesforceLevel, siteConfig), source: "salesforce" };
  }

  const manualLevel = normalizeAccessLevelValue(user?.manualAccessLevel ?? user?.accessLevel, siteConfig);
  if (manualLevel !== null) {
    return { level: manualLevel, label: getAccessLevelLabel(manualLevel, siteConfig), source: "manual" };
  }

  const defaultLevel = getDefaultAccessLevel(siteConfig);
  return { level: defaultLevel, label: getAccessLevelLabel(defaultLevel, siteConfig), source: "default" };
}

export async function resolveEffectiveAccessLevelForEmail(
  email: string | null | undefined,
  siteConfig: SiteConfig | null | undefined
): Promise<EffectiveAccessLevel> {
  if (!email || !db || !isAccessControlEnabled(siteConfig)) {
    return resolveEffectiveAccessLevel(null, siteConfig);
  }

  const userDoc = await firestoreGet(
    db.collection(getUsersCollectionName()).doc(email.toLowerCase()),
    "get user for access level",
    email.toLowerCase()
  );

  if (!userDoc.exists) {
    return resolveEffectiveAccessLevel(null, siteConfig);
  }

  return resolveEffectiveAccessLevel(userDoc.data() || {}, siteConfig);
}

export function validateManualAccessLevel(
  requestedLevel: unknown,
  requesterRole: string,
  siteConfig: SiteConfig | null | undefined
): ManualAccessLevelValidationResult {
  if (!isAccessControlEnabled(siteConfig)) {
    return { valid: true, level: normalizeAccessLevelValue(requestedLevel, siteConfig) ?? 0 };
  }

  const level = normalizeAccessLevelValue(requestedLevel, siteConfig);
  if (level === null) {
    return { valid: false, error: "Invalid access level" };
  }

  const configuredValues = new Set(getConfiguredAccessLevels(siteConfig).map((configuredLevel) => configuredLevel.value));
  if (!configuredValues.has(level)) {
    return { valid: false, error: "Access level is not configured for this site" };
  }

  const accessControl = getAccessControl(siteConfig);
  const salesforceOnlyLevels = new Set(accessControl?.salesforceOnlyLevels || []);
  const normalizedRequesterRole = requesterRole.toLowerCase();

  if (normalizedRequesterRole !== "superuser" && salesforceOnlyLevels.has(level)) {
    return { valid: false, error: "This access level can only come from Salesforce" };
  }

  if (normalizedRequesterRole === "admin") {
    const adminMaxLevel = accessControl?.manualAssignmentCaps?.userAdminMaxLevel ?? getDefaultAccessLevel(siteConfig);
    if (level > adminMaxLevel) {
      return { valid: false, error: `User admins can only assign access levels up to ${adminMaxLevel}` };
    }
  } else if (normalizedRequesterRole === "superuser") {
    const superuserMaxLevel = accessControl?.manualAssignmentCaps?.superuserMaxLevel ?? getSuperuserAccessLevel(siteConfig);
    if (level > superuserMaxLevel) {
      return { valid: false, error: `Superusers can only assign access levels up to ${superuserMaxLevel}` };
    }
  } else {
    return { valid: false, error: "Admin privileges required to assign access levels" };
  }

  return { valid: true, level };
}

export function buildPineconeAccessFilter(
  effectiveAccessLevel: number,
  siteConfig: SiteConfig | null | undefined
): PineconeFilterClause | null {
  if (!isAccessControlEnabled(siteConfig)) {
    return null;
  }

  const blockedLegacyLevels = getConfiguredAccessLevels(siteConfig)
    .filter((level) => level.value > effectiveAccessLevel)
    .map((level) => level.key);

  const clauses: PineconeFilterClause[] = [
    {
      $or: [
        { required_access_level: { $exists: false } },
        { required_access_level: { $lte: effectiveAccessLevel } },
      ],
    },
  ];

  if (blockedLegacyLevels.length > 0) {
    clauses.push({ access_level: { $nin: Array.from(new Set(blockedLegacyLevels)) } });
  }

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

export function buildAccessLevelResponseFields(
  user: Record<string, any>,
  siteConfig: SiteConfig | null | undefined
): Record<string, any> {
  const effectiveAccess = resolveEffectiveAccessLevel(user, siteConfig);
  const hasSalesforceMatch = hasValidSalesforceMatch(user);
  const salesforceAccessLevel = hasSalesforceMatch ? normalizeAccessLevelValue(user?.salesforceAccessLevel, siteConfig) : null;
  const salesforceId = getValidSalesforceId(user?.salesforceId);
  const salesforceMatchStatus =
    typeof user?.salesforceMatchStatus === "string"
      ? user.salesforceMatchStatus === "matched" && !salesforceId
        ? "not_found"
        : user.salesforceMatchStatus
      : null;
  return {
    accessLevel: effectiveAccess.level,
    accessLevelLabel: effectiveAccess.label,
    accessLevelSource: effectiveAccess.source,
    manualAccessLevel: normalizeAccessLevelValue(user?.manualAccessLevel, siteConfig),
    manualAccessLevelLabel:
      normalizeAccessLevelValue(user?.manualAccessLevel, siteConfig) === null
        ? null
        : getAccessLevelLabel(user.manualAccessLevel, siteConfig),
    salesforceAccessLevel,
    salesforceAccessLevelLabel:
      salesforceAccessLevel === null
        ? null
        : getAccessLevelLabel(salesforceAccessLevel, siteConfig),
    lastSalesforceSyncAt: user?.lastSalesforceSyncAt?.toDate?.() ?? user?.lastSalesforceSyncAt ?? null,
    salesforceId,
    salesforceMatchStatus,
    salesforceLastLookupError:
      typeof user?.salesforceLastLookupError === "string" ? user.salesforceLastLookupError : null,
  };
}

function hasValidSalesforceMatch(user: Record<string, any> | null): boolean {
  return user?.salesforceMatchStatus === "matched" && getValidSalesforceId(user?.salesforceId) !== null;
}

function getValidSalesforceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) return null;
  const normalizedValue = trimmedValue.toLowerCase();
  if (["na", "n/a", "none", "null", "not_found", "not found"].includes(normalizedValue)) {
    return null;
  }
  return trimmedValue;
}

function normalizeAccessLevelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
