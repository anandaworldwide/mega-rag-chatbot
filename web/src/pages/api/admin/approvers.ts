import { NextApiRequest, NextApiResponse } from "next";
import { s3Client } from "@/utils/server/awsConfig";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getFromCache, setInCache } from "@/utils/server/redisUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isDevelopment } from "@/utils/env";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";

interface AdminApproverSource {
  name: string;
  uuid: string;
  location: string;
}

interface AdminApprover {
  name: string;
  email: string;
  location: string;
}

interface Region {
  name: string;
  admins: AdminApprover[];
}

interface RegionSource {
  name: string;
  admins: AdminApproverSource[];
}

interface AdminApproversData {
  lastUpdated: string;
  regions: Region[];
}

interface AdminApproversSourceData {
  lastUpdated: string;
  regions: RegionSource[];
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Apply rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "admin_approvers",
  });
  if (!allowed) return;

  try {
    // Load site configuration
    const siteConfig = await loadSiteConfig();
    if (!siteConfig?.siteId) {
      return res.status(500).json({ error: "Site configuration not available" });
    }

    const siteId = siteConfig.siteId;
    const cacheKey = `admin_approvers_${siteId}`;

    // Try to get from cache first (5-minute TTL)
    const cachedData = await getFromCache<AdminApproversData>(cacheKey);
    if (cachedData) {
      return res.status(200).json(cachedData);
    }

    // Fetch from S3
    const bucketName = process.env.NEXT_PUBLIC_S3_BUCKET_NAME || "ananda-chatbot";

    // Use dev- prefix for development environments
    const s3EnvPrefix = isDevelopment() ? "dev-" : "";
    const key = `site-config/admin-approvers/${s3EnvPrefix}${siteId}-admin-approvers.json`;

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
      return res.status(404).json({ error: "Admin approvers configuration not found" });
    }

    // Read the stream
    const streamToString = (stream: any): Promise<string> => {
      return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
    };

    const bodyContents = await streamToString(response.Body);
    const sourceData: AdminApproversSourceData = JSON.parse(bodyContents);

    // Validate the data structure
    if (!sourceData.regions || !Array.isArray(sourceData.regions)) {
      return res.status(500).json({ error: "Invalid admin approvers data structure" });
    }

    // Validate UUID format
    for (const region of sourceData.regions) {
      for (const admin of region.admins || []) {
        if (!admin.uuid || typeof admin.uuid !== "string" || admin.uuid.length !== 36) {
          return res.status(500).json({
            error: `Invalid UUID format for admin ${admin.name}. Expected 36-character UUID.`,
          });
        }
      }
    }

    // Look up emails from user records by UUID
    const usersCol = getUsersCollectionName();
    const envPrefix = isDevelopment() ? "dev_" : "prod_";
    const uuidIndexCol = `${envPrefix}uuid_index`;

    // Convert UUID-based data to email-based for API response
    const missingUuids: Array<{ name: string; uuid: string; location: string }> = [];
    const regions: Region[] = await Promise.all(
      sourceData.regions.map(async (region) => {
        const admins: AdminApprover[] = await Promise.all(
          region.admins.map(async (admin) => {
            // Look up user by UUID to get email
            let email = "";
            let found = false;

            if (db) {
              try {
                // Query users collection for UUID match
                const usersSnapshot = await db.collection(usersCol).where("uuid", "==", admin.uuid).limit(1).get();

                if (!usersSnapshot.empty) {
                  const userDoc = usersSnapshot.docs[0];
                  email = userDoc.id; // Email is the document ID
                  found = true;
                } else {
                  // Try UUID index collection
                  const uuidDoc = await firestoreGet(
                    db.collection(uuidIndexCol).doc(admin.uuid),
                    "lookup email by uuid",
                    admin.uuid
                  );
                  if (uuidDoc.exists) {
                    email = uuidDoc.data()?.email || "";
                    found = !!email;
                  }
                }
              } catch (error) {
                console.error(`Error looking up email for UUID ${admin.uuid}:`, error);
              }
            }

            if (!found || !email) {
              console.warn(`Could not find email for UUID ${admin.uuid}, admin ${admin.name}`);
              missingUuids.push({
                name: admin.name,
                uuid: admin.uuid,
                location: admin.location,
              });
              // Return admin without email - will be filtered out
              return {
                name: admin.name,
                email: "",
                location: admin.location,
              };
            }

            return {
              name: admin.name,
              email: email.toLowerCase(),
              location: admin.location,
            };
          })
        );

        // Filter out admins without emails
        return {
          name: region.name,
          admins: admins.filter((admin) => admin.email),
        };
      })
    );

    // Send ops alert if any UUIDs could not be converted to emails
    if (missingUuids.length > 0) {
      const siteId = siteConfig?.siteId || "unknown";
      const missingList = missingUuids
        .map((admin) => `  - ${admin.name} (UUID: ${admin.uuid}, Location: ${admin.location})`)
        .join("\n");

      await sendOpsAlert(
        "Admin Approver UUID Lookup Failed",
        `Failed to find email addresses for ${missingUuids.length} admin approver(s) in site "${siteId}". These admins will be excluded from the approver list.\n\nMissing UUIDs:\n${missingList}\n\nPlease verify these UUIDs exist in Firestore user records.`,
        {
          context: {
            siteId,
            missingCount: missingUuids.length,
            missingUuids: missingUuids.map((a) => ({ name: a.name, uuid: a.uuid })),
          },
        }
      );
    }

    const approversData: AdminApproversData = {
      lastUpdated: sourceData.lastUpdated,
      regions,
    };

    // Cache the result for 5 minutes (300 seconds)
    await setInCache(cacheKey, approversData, 300);

    return res.status(200).json(approversData);
  } catch (error: any) {
    // Handle specific S3 errors
    if (error.name === "NoSuchKey" || error.name === "NoSuchBucket") {
      // Log as warning since this is expected fallback behavior
      console.warn("No admin approvers configuration found, using fallback Support admin");

      // Return fallback admin approver using CONTACT_EMAIL
      const contactEmail = process.env.CONTACT_EMAIL;
      if (!contactEmail) {
        return res
          .status(404)
          .json({ error: "Admin approvers configuration not found for this site and CONTACT_EMAIL not configured" });
      }

      console.error("Error fetching admin approvers:", error);

      const fallbackData: AdminApproversData = {
        lastUpdated: new Date().toISOString(),
        regions: [
          {
            name: "General",
            admins: [
              {
                name: "Support",
                email: contactEmail.toLowerCase(),
                location: "Global Support Team",
              },
            ],
          },
        ],
      };

      return res.status(200).json(fallbackData);
    }

    if (error.name === "AccessDenied" || error.name === "Forbidden") {
      return res.status(403).json({ error: "Access denied to admin approvers configuration" });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
