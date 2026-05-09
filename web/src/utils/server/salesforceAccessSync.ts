import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import type { SiteConfig } from "@/types/siteConfig";
import { getUsersCollectionName } from "./firestoreUtils";
import { firestoreGet, firestoreSet } from "./firestoreRetryUtils";
import { normalizeAccessLevelValue } from "./accessLevelUtils";

export interface SalesforceAccessSyncResult {
  matched: boolean;
  salesforceId?: string | null;
  salesforceAccessLevel?: number | null;
  error?: string;
}

interface SalesforceLookupPayload {
  first_name: string;
  last_name: string;
  email: string;
  salesforce_id: string;
  origin_url: string;
  [key: string]: string;
}

interface SalesforceLookupResponse {
  salesforce_18_id?: string;
  luca_access_level?: string | number;
  [key: string]: unknown;
}

const SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL_ENV = "SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL";
const SALESFORCE_API_KEY_ENV = "SALESFORCE_API_KEY";
const SALESFORCE_API_FIELD_NAME_ENV = "SALESFORCE_API_FIELD_NAME";
export const SALESFORCE_ACCESS_VERIFICATION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

interface SalesforceApiAuthParameter {
  fieldName: string;
  apiKey: string;
}

export function isSalesforceAccessVerificationDue(
  userData: Record<string, any> | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!userData) return false;

  if (userData.inviteStatus !== "accepted") {
    return false;
  }

  const lastSync = toDate(userData.lastSalesforceSyncAt);
  if (!lastSync) return true;

  return lastSync.getTime() <= nowMs - SALESFORCE_ACCESS_VERIFICATION_MAX_AGE_MS;
}

export async function syncUserAccessLevelFromSalesforce(
  email: string,
  siteConfig: SiteConfig
): Promise<SalesforceAccessSyncResult> {
  if (!db) {
    return { matched: false, error: "Database not available" };
  }

  const normalizedEmail = email.toLowerCase();
  const userRef = db.collection(getUsersCollectionName()).doc(normalizedEmail);
  const userDoc = await firestoreGet(userRef, "get user for Salesforce access sync", normalizedEmail);
  if (!userDoc.exists) {
    return { matched: false, error: "User not found" };
  }

  const userData = userDoc.data() || {};
  const webhookUrl = getSalesforceWebhookUrl();
  const apiAuthParameter = getSalesforceApiAuthParameter();
  if (!webhookUrl) {
    const error = "Salesforce access webhook URL is not configured";
    logSalesforceSyncFailure(normalizedEmail, error);
    await writeSalesforceSyncFailure(normalizedEmail, error);
    return { matched: false, error };
  }

  if (!apiAuthParameter) {
    const error = "Salesforce API key or API field name is not configured";
    logSalesforceSyncFailure(normalizedEmail, error);
    await writeSalesforceSyncFailure(normalizedEmail, error);
    return { matched: false, error };
  }

  try {
    const payload = buildSalesforceLookupPayload(normalizedEmail, userData, siteConfig, apiAuthParameter);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([payload]),
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }

    const responseBody = (await response.json()) as SalesforceLookupResponse | SalesforceLookupResponse[];
    const lookupResult = Array.isArray(responseBody) ? responseBody[0] : responseBody;
    const salesforceAccessLevel = normalizeAccessLevelValue(lookupResult?.luca_access_level, siteConfig);
    const salesforceId = normalizeSalesforceId(lookupResult?.salesforce_18_id);

    if (!salesforceId) {
      const updates = {
        salesforceMatchStatus: "not_found",
        lastSalesforceSyncAt: firebase.firestore.Timestamp.now(),
        salesforceLastLookupError: null,
        salesforceId: null,
        salesforceAccessLevel: null,
      };
      await firestoreSet(userRef, updates, { merge: true }, "mark Salesforce access not found", normalizedEmail);
      return { matched: false, salesforceId: null, salesforceAccessLevel: null };
    }

    const updates: Record<string, unknown> = {
      salesforceMatchStatus: "matched",
      lastSalesforceSyncAt: firebase.firestore.Timestamp.now(),
      salesforceLastLookupError: null,
    };

    updates.salesforceId = salesforceId;
    updates.salesforceAccessLevel = salesforceAccessLevel;

    await firestoreSet(userRef, updates, { merge: true }, "sync Salesforce access level", normalizedEmail);

    return {
      matched: true,
      salesforceId,
      salesforceAccessLevel,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Salesforce lookup failed";
    logSalesforceSyncFailure(normalizedEmail, message);
    await writeSalesforceSyncFailure(normalizedEmail, message);
    return { matched: false, error: message };
  }
}

function buildSalesforceLookupPayload(
  email: string,
  userData: Record<string, any>,
  siteConfig: SiteConfig,
  apiAuthParameter: SalesforceApiAuthParameter
): SalesforceLookupPayload {
  const salesforceId =
    typeof userData.salesforceId === "string" && userData.salesforceId.trim().length > 0
      ? userData.salesforceId.trim()
      : "NA";

  const payload: SalesforceLookupPayload = {
    first_name: typeof userData.firstName === "string" ? userData.firstName : "",
    last_name: typeof userData.lastName === "string" ? userData.lastName : "",
    email,
    salesforce_id: salesforceId,
    origin_url: siteConfig.accessControl?.originUrl || siteConfig.parent_site_url || "",
  };

  payload[apiAuthParameter.fieldName] = apiAuthParameter.apiKey;
  return payload;
}

function getSalesforceWebhookUrl(): string | null {
  return process.env[SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL_ENV]?.trim() || null;
}

function getSalesforceApiAuthParameter(): SalesforceApiAuthParameter | null {
  const apiKey = process.env[SALESFORCE_API_KEY_ENV]?.trim();
  const fieldName = process.env[SALESFORCE_API_FIELD_NAME_ENV]?.trim();
  if (!apiKey || !fieldName) return null;
  return { apiKey, fieldName };
}

function normalizeSalesforceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) return null;
  const normalizedValue = trimmedValue.toLowerCase();
  if (["na", "n/a", "none", "null", "not_found", "not found"].includes(normalizedValue)) {
    return null;
  }
  return trimmedValue;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function logSalesforceSyncFailure(email: string, error: string): void {
  console.error("Salesforce access sync failed", {
    email,
    error,
  });
}

async function writeSalesforceSyncFailure(email: string, error: string): Promise<void> {
  if (!db) return;
  const userRef = db.collection(getUsersCollectionName()).doc(email);
  await firestoreSet(
    userRef,
    {
      salesforceMatchStatus: "error",
      lastSalesforceSyncAt: firebase.firestore.Timestamp.now(),
      salesforceLastLookupError: error,
    },
    { merge: true },
    "write Salesforce access sync failure",
    email
  );
}
