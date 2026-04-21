/**
 * Per-site email blacklist stored in S3 as plain text (newline-separated).
 * Only enforced when siteConfig.requireLogin is true.
 */

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { s3Client } from "@/utils/server/awsConfig";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { EMAIL_REGEX } from "@/utils/server/emailValidation";

const MAX_EMAIL_LENGTH = 254;

const CACHE_TTL_MS = 60_000;
const FAIL_OPEN_CACHE_TTL_MS = 5_000;

type BlacklistCacheEntry = {
  emails: Set<string>;
  loadedAt: number;
  ttlMs: number;
};

const cacheBySite = new Map<string, BlacklistCacheEntry>();

function getPromptEnvironment(): string {
  if (process.env.NODE_ENV === "test") {
    return "dev";
  }
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === "production" || process.env.VERCEL_ENV === "preview") {
    return "prod";
  }
  return "dev";
}

export function getBlacklistObjectKey(siteId: string): string {
  return `site-config/${getPromptEnvironment()}/blacklist/${siteId}.txt`;
}

function requireBucketName(): string {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME is not configured");
  }
  return bucket;
}

async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function isNoSuchKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

/**
 * Extract the de-duplicated, lowercased list of emails from blacklist file / textarea content.
 * Skips blank and # comment lines. Used by enforcement (the in-memory Set).
 * Does NOT validate email format — use validateBlacklistContent for that.
 */
export function parseBlacklistContent(raw: string): { emails: string[]; normalizedText: string } {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    emails.push(lower);
  }
  const normalizedText = emails.length > 0 ? `${emails.join("\n")}\n` : "";
  return { emails, normalizedText };
}

/**
 * Normalize the admin's raw textarea content for persistent storage while preserving
 * comments and blank lines. Email lines are lowercased and whitespace-trimmed.
 * Trailing whitespace is stripped from every line. Collapses trailing blank lines and
 * guarantees a single trailing newline when any content exists.
 */
export function normalizeBlacklistForStorage(raw: string): { text: string; emails: string[] } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const outLines: string[] = [];
  for (const original of raw.split(/\r?\n/)) {
    const trimmed = original.trim();
    if (!trimmed) {
      outLines.push("");
      continue;
    }
    if (trimmed.startsWith("#")) {
      outLines.push(original.replace(/\s+$/, ""));
      continue;
    }
    const lower = trimmed.toLowerCase();
    outLines.push(lower);
    if (!seen.has(lower)) {
      seen.add(lower);
      emails.push(lower);
    }
  }
  while (outLines.length > 0 && outLines[outLines.length - 1] === "") {
    outLines.pop();
  }
  const text = outLines.length > 0 ? `${outLines.join("\n")}\n` : "";
  return { text, emails };
}

export type BlacklistLineError = {
  line: number;
  content: string;
  reason: string;
};

/**
 * Validate blacklist textarea content line-by-line. Every non-empty, non-comment
 * line must be a well-formed email address. Blank lines and lines starting
 * with "#" are allowed and ignored. Returns the list of offending lines
 * (1-indexed) with a human-readable reason.
 */
export function validateBlacklistContent(raw: string): {
  valid: boolean;
  errors: BlacklistLineError[];
} {
  const errors: BlacklistLineError[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const trimmed = original.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.length > MAX_EMAIL_LENGTH) {
      errors.push({
        line: i + 1,
        content: original,
        reason: `Email exceeds ${MAX_EMAIL_LENGTH} characters`,
      });
      continue;
    }
    if (!EMAIL_REGEX.test(trimmed.toLowerCase())) {
      errors.push({
        line: i + 1,
        content: original,
        reason: "Not a valid email address",
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function invalidateBlacklistCache(siteId: string): void {
  cacheBySite.delete(siteId);
}

function isBlacklistEnforcedForSite(siteId: string): boolean {
  const siteConfig = loadSiteConfigSync(siteId);
  return !!siteConfig?.requireLogin;
}

type FetchResult = { emails: Set<string>; failed: boolean };

async function fetchBlacklistEmailsFromS3(siteId: string): Promise<FetchResult> {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    console.error("S3_BUCKET_NAME not configured; blacklist check skipped");
    return { emails: new Set(), failed: true };
  }

  const key = getBlacklistObjectKey(siteId);
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    if (!response.Body) {
      return { emails: new Set(), failed: false };
    }
    const raw = await streamToString(response.Body as Readable);
    const { emails } = parseBlacklistContent(raw);
    return { emails: new Set(emails), failed: false };
  } catch (error) {
    if (isNoSuchKeyError(error)) {
      return { emails: new Set(), failed: false };
    }
    console.error(`Blacklist S3 read failed: ${bucket}/${key}`, error);
    try {
      await sendOpsAlert("Blacklist S3 read failure", `Failed to load blacklist from S3: ${bucket}/${key}`, {
        error: error as Error,
        context: { operation: "blacklist_read", bucket, key, siteId },
        stack: (error as Error).stack,
      });
    } catch (alertErr) {
      console.error("Failed to send ops alert for blacklist error:", alertErr);
    }
    return { emails: new Set(), failed: true };
  }
}

async function getCachedBlacklistEmails(
  siteId: string
): Promise<{ emails: Set<string>; cacheHit: boolean; fetchMs: number }> {
  const now = Date.now();
  const cached = cacheBySite.get(siteId);
  if (cached && now - cached.loadedAt < cached.ttlMs) {
    return { emails: cached.emails, cacheHit: true, fetchMs: 0 };
  }
  const started = Date.now();
  const { emails, failed } = await fetchBlacklistEmailsFromS3(siteId);
  const fetchMs = Date.now() - started;
  const ttlMs = failed ? FAIL_OPEN_CACHE_TTL_MS : CACHE_TTL_MS;
  cacheBySite.set(siteId, { emails, loadedAt: now, ttlMs });
  return { emails, cacheHit: false, fetchMs };
}

export type BlacklistCheckResult = {
  blocked: boolean;
  skipped: boolean;
  cacheHit: boolean;
  fetchMs: number;
};

/**
 * Rich blacklist check used by session-revocation paths that want perf telemetry.
 * skipped=true when the site does not enforce login or inputs are empty (no work done).
 */
export async function checkEmailBlacklist(email: string, siteId: string): Promise<BlacklistCheckResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !siteId || !isBlacklistEnforcedForSite(siteId)) {
    return { blocked: false, skipped: true, cacheHit: false, fetchMs: 0 };
  }
  const { emails, cacheHit, fetchMs } = await getCachedBlacklistEmails(siteId);
  return { blocked: emails.has(normalized), skipped: false, cacheHit, fetchMs };
}

/**
 * Returns true if email is on the blacklist for this site. Always false if site does not require login.
 * On S3 errors (other than missing object), fails open (false) after ops alert.
 */
export async function isEmailBlacklisted(email: string, siteId: string): Promise<boolean> {
  const { blocked } = await checkEmailBlacklist(email, siteId);
  return blocked;
}

export type BlacklistTextResult = {
  text: string;
  emails: string[];
  updatedAt?: string;
};

/**
 * Load raw blacklist file from S3 for admin UI (bypasses TTL cache).
 */
export async function getBlacklistText(siteId: string): Promise<BlacklistTextResult> {
  requireBucketName();
  const bucket = process.env.S3_BUCKET_NAME!;
  const key = getBlacklistObjectKey(siteId);

  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    if (!response.Body) {
      return { text: "", emails: [] };
    }
    const raw = await streamToString(response.Body as Readable);
    const { emails } = parseBlacklistContent(raw);
    const updatedAt = response.LastModified?.toISOString();
    return { text: raw, emails, updatedAt };
  } catch (error) {
    if (isNoSuchKeyError(error)) {
      return { text: "", emails: [] };
    }
    throw error;
  }
}

/**
 * Write the admin's blacklist content to S3 (preserving comments and blanks)
 * and invalidate the local cache for this site.
 */
export async function setBlacklistText(text: string, siteId: string): Promise<{ text: string; emails: string[] }> {
  const bucket = requireBucketName();
  const { text: storedText, emails } = normalizeBlacklistForStorage(text);
  const key = getBlacklistObjectKey(siteId);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(storedText, "utf8"),
      ContentType: "text/plain; charset=utf-8",
    })
  );

  invalidateBlacklistCache(siteId);
  return { text: storedText, emails };
}
