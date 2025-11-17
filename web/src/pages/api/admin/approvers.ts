import { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { getFromCache, setInCache } from "@/utils/server/redisUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";

interface AdminApprover {
  name: string;
  email: string;
  location: string;
}

interface Region {
  name: string;
  admins: AdminApprover[];
}

interface AdminApproversData {
  lastUpdated: string;
  regions: Region[];
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

    if (!db) {
      return res.status(503).json({ error: "Database not available" });
    }

    // Query Firestore for approvers
    const usersCol = getUsersCollectionName();
    const approversQuery = db
      .collection(usersCol)
      .where("isApprover", "==", true)
      .where("role", "in", ["admin", "superuser"]);

    const approversSnapshot = await firestoreQueryGet(
      approversQuery,
      "fetch admin approvers",
      `site: ${siteId}`
    );

    // Group approvers by location (region)
    const regionMap = new Map<string, AdminApprover[]>();

    approversSnapshot.docs.forEach((doc: firebase.firestore.QueryDocumentSnapshot) => {
      const data = doc.data();
      const email = doc.id; // Email is the document ID
      // Construct name from firstName/lastName, fallback to email
      const firstName = data.firstName || "";
      const lastName = data.lastName || "";
      const approverName = firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || email;
      const approverLocation = data.approverLocation || "";
      const approverRegion = data.approverRegion || "Global";

      const approver: AdminApprover = {
        name: approverName,
        email: email.toLowerCase(),
        location: approverLocation,
      };

      // Group by region name
      const regionName = approverRegion;
      if (!regionMap.has(regionName)) {
        regionMap.set(regionName, []);
      }
      regionMap.get(regionName)!.push(approver);
    });

    // Convert map to regions array
    const regions: Region[] = Array.from(regionMap.entries()).map(([name, admins]) => ({
      name,
      admins,
    }));

    // Sort regions: alphabetically, but "Global" always last
    regions.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aIsGlobal = aName === "global";
      const bIsGlobal = bName === "global";

      if (aIsGlobal && !bIsGlobal) return 1;
      if (!aIsGlobal && bIsGlobal) return -1;
      return aName.localeCompare(bName);
    });

    // If no approvers found, use fallback
    if (regions.length === 0) {
      const contactEmail = process.env.CONTACT_EMAIL;
      if (!contactEmail) {
        return res.status(404).json({
          error: "No approvers configured for this site and CONTACT_EMAIL not configured",
        });
      }

      const fallbackData: AdminApproversData = {
        lastUpdated: new Date().toISOString(),
        regions: [
          {
            name: "Global",
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

      // Cache fallback for shorter duration (1 minute)
      await setInCache(cacheKey, fallbackData, 60);
      return res.status(200).json(fallbackData);
    }

    const approversData: AdminApproversData = {
      lastUpdated: new Date().toISOString(),
      regions,
    };

    // Cache the result for 5 minutes (300 seconds)
    await setInCache(cacheKey, approversData, 300);

    return res.status(200).json(approversData);
  } catch (error: any) {
    console.error("Error fetching admin approvers:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
