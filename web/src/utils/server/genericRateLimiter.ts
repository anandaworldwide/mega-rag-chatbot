import { db } from "@/services/firebase";
import { isDevelopment } from "@/utils/env";
import { NextApiRequest, NextApiResponse } from "next";
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/utils/server/ipUtils";
import { retryOnCode14, isCode14Error } from "@/utils/server/firestoreRetryUtils";

type RateLimitConfig = {
  windowMs: number;
  max: number;
  name: string;
  collectionPrefix?: string;
  message?: string; // User-friendly error message (defaults to generic message)
};

const defaultRateLimitConfig: Partial<RateLimitConfig> = {
  windowMs: isDevelopment() ? 180 * 1000 : 60 * 1000, // 3 minutes for dev, 1 minute for prod
  max: 25,
  collectionPrefix: isDevelopment() ? "dev" : "prod",
};

export async function genericRateLimiter(
  req: NextApiRequest | NextRequest,
  res: NextApiResponse | NextResponse | null,
  config: RateLimitConfig,
  ip?: string
): Promise<boolean> {
  // If db is not available, skip rate limiting
  if (!db) {
    console.warn("Firestore database not initialized, skipping rate limiting");
    return true;
  }

  const { windowMs, max, name, collectionPrefix, message } = {
    ...defaultRateLimitConfig,
    ...config,
  };

  const clientIP = ip || getClientIp(req) || "unknown";
  // Sanitize IP for use in Firestore document ID
  // Replace colons (IPv6), dots (IPv4), and slashes with underscores
  const sanitizedIP = clientIP.replace(/[:./]/g, "_");
  const docId = `${sanitizedIP}_${name}`;

  const now = Date.now();
  const rateLimitRef = db!.collection(`${collectionPrefix}_rateLimits`).doc(docId);

  try {
    const result = await retryOnCode14(
      async () => {
        const rateLimitDoc = await rateLimitRef.get();
        if (!rateLimitDoc.exists) {
          await rateLimitRef.set({
            ip: clientIP,
            sanitizedIP,
            category: name,
            count: 1,
            firstRequestTime: now,
            lastRequestTime: now,
          });
          return true;
        }

        const rateLimitData = rateLimitDoc.data();
        if (rateLimitData) {
          const { count, firstRequestTime } = rateLimitData;
          if (now - firstRequestTime < windowMs) {
            if (count >= max) {
              console.log(`Rate limit exceeded for IP ${clientIP}, category: ${name}`);
              if (res) {
                if ("status" in res && typeof res.status === "function") {
                  res.status(429).json({
                    error: message || `Too many ${name} requests. Please wait a moment and try again.`,
                  });
                } else if (res instanceof NextResponse) {
                  return false;
                }
              }
              return false;
            }
            await rateLimitRef.update({
              count: count + 1,
              lastRequestTime: now,
            });
          } else {
            await rateLimitRef.set({
              ip: clientIP,
              sanitizedIP,
              category: name,
              count: 1,
              firstRequestTime: now,
              lastRequestTime: now,
            });
          }
          return true;
        }
        return true;
      },
      "rate limiting",
      `IP: ${clientIP}, category: ${name}`
    );

    return result;
  } catch (error) {
    if (isCode14Error(error)) {
      console.error("Google Cloud policy checks failed after 3 attempts, allowing request as fallback:", error);
    } else {
      console.error("RateLimiterError:", error);
    }
    return true; // Allow the request in case of an error
  }
}

export async function deleteRateLimitCounter(req: NextApiRequest, name: string): Promise<void> {
  // If db is not available, skip deletion
  if (!db) {
    console.warn("Firestore database not initialized, skipping rate limit counter deletion");
    return;
  }

  const ip = getClientIp(req);
  // Sanitize IP for use in Firestore document ID
  // Replace colons (IPv6), dots (IPv4), and slashes with underscores
  const sanitizedIP = ip.replace(/[:./]/g, "_");
  const docId = `${sanitizedIP}_${name}`;
  const collectionName = `${defaultRateLimitConfig.collectionPrefix}_rateLimits`;

  try {
    await retryOnCode14(
      async () => {
        const docRef = db!.collection(collectionName).doc(docId);
        const doc = await docRef.get();

        if (doc.exists) {
          await docRef.delete();
        } else {
          console.warn(`No rate limit counter found for IP ${ip}, category: ${name}. Nothing to delete.`);
        }
      },
      "rate limit deletion",
      `IP: ${ip}, category: ${name}`
    );
  } catch (error) {
    if (isCode14Error(error)) {
      console.error("Google Cloud policy checks failed after 3 attempts for rate limit deletion:", error);
    } else {
      console.error(`Error deleting rate limit counter for IP ${ip}, category: ${name}:`, error);
    }
  }
}
