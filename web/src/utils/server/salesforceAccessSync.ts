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
}

interface SalesforceLookupResponse {
  salesforce_18_id?: string;
  luca_access_level?: string | number;
  [key: string]: unknown;
}

const SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL_ENV = "SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL";

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
  if (!webhookUrl) {
    const error = "Salesforce access webhook URL is not configured";
    await writeSalesforceSyncFailure(normalizedEmail, error);
    return { matched: false, error };
  }

  try {
    const payload = buildSalesforceLookupPayload(normalizedEmail, userData, siteConfig);
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
    await writeSalesforceSyncFailure(normalizedEmail, message);
    return { matched: false, error: message };
  }
}

function buildSalesforceLookupPayload(
  email: string,
  userData: Record<string, any>,
  siteConfig: SiteConfig
): SalesforceLookupPayload {
  const salesforceId =
    typeof userData.salesforceId === "string" && userData.salesforceId.trim().length > 0
      ? userData.salesforceId.trim()
      : "NA";

  return {
    first_name: typeof userData.firstName === "string" ? userData.firstName : "",
    last_name: typeof userData.lastName === "string" ? userData.lastName : "",
    email,
    salesforce_id: salesforceId,
    origin_url: siteConfig.accessControl?.originUrl || siteConfig.parent_site_url || "",
  };
}

function getSalesforceWebhookUrl(): string | null {
  return process.env[SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL_ENV]?.trim() || null;
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
