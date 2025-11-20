import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { db } from "@/services/firebase";
import { getAnswersCollectionName, getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as fbadmin from "firebase-admin";

interface LeaderboardUser {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  uuid: string;
  questionCount: number;
  displayName: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    max: 6,
    windowMs: 60 * 1000, // 1 minute
    name: "admin-leaderboard",
  });
  if (!isAllowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    // Parse time period from query parameter
    const timePeriod = req.query.timePeriod as string | undefined;
    let startDate: fbadmin.firestore.Timestamp | null = null;

    if (timePeriod === "7days") {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      startDate = fbadmin.firestore.Timestamp.fromDate(sevenDaysAgo);
    } else if (timePeriod === "30days") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      startDate = fbadmin.firestore.Timestamp.fromDate(thirtyDaysAgo);
    }
    // If timePeriod is "all" or undefined, startDate remains null (no filter)

    // Get all users with UUIDs (only users with UUIDs can have questions)
    const usersCollection = getUsersCollectionName();
    const usersQuery = db.collection(usersCollection).where("uuid", "!=", null);

    const usersSnapshot = await firestoreQueryGet(usersQuery, "admin leaderboard users", "users with uuid");

    if (usersSnapshot.empty) {
      return res.status(200).json({ users: [] });
    }

    // Get question counts for all users in parallel
    const leaderboardPromises = usersSnapshot.docs.map(async (userDoc: QueryDocumentSnapshot) => {
      const userData = userDoc.data();
      const email = userDoc.id; // Email is stored as document ID
      const uuid = userData.uuid;

      if (!uuid) {
        return null; // Skip users without UUID
      }

      try {
        // Build query for questions with optional time filter
        let questionsQuery = db!.collection(getAnswersCollectionName()).where("uuid", "==", uuid);

        if (startDate) {
          questionsQuery = questionsQuery.where("timestamp", ">=", startDate);
        }

        const questionsSnapshot = await firestoreQueryGet(
          questionsQuery,
          "admin leaderboard question count",
          `uuid: ${uuid}${startDate ? `, since: ${startDate.toDate().toISOString()}` : ""}`
        );

        const questionCount = questionsSnapshot.docs.length;

        // Only include users with at least 1 question
        if (questionCount === 0) {
          return null;
        }

        // Create display name
        const firstName = userData.firstName?.trim() || "";
        const lastName = userData.lastName?.trim() || "";
        let displayName: string;

        if (firstName && lastName) {
          displayName = `${firstName} ${lastName}`;
        } else if (firstName) {
          displayName = firstName;
        } else if (lastName) {
          displayName = lastName;
        } else {
          displayName = email;
        }

        return {
          email,
          firstName: userData.firstName || null,
          lastName: userData.lastName || null,
          uuid,
          questionCount,
          displayName,
        } as LeaderboardUser;
      } catch (error) {
        console.warn(`Failed to fetch question count for user ${email}:`, error);
        return null;
      }
    });

    // Wait for all promises to resolve and filter out nulls
    const leaderboardResults = await Promise.all(leaderboardPromises);
    const validUsers = leaderboardResults.filter((user): user is LeaderboardUser => user !== null);

    // Sort by question count descending, then by display name ascending for ties
    const sortedUsers = validUsers.sort((a, b) => {
      if (b.questionCount !== a.questionCount) {
        return b.questionCount - a.questionCount;
      }
      return a.displayName.localeCompare(b.displayName);
    });

    // Return top 20 users
    const top20Users = sortedUsers.slice(0, 20);

    return res.status(200).json({ users: top20Users });
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Something went wrong",
    });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
