// Lists active users for the current site for admin UI
//
// SCALABILITY NOTE: For large user bases (1000+ users), consider these optimizations:
// 1. Add computed 'displayName' field to user documents during creation/update
// 2. Create Firestore composite index on ['inviteStatus', 'displayName']
// 3. Use native Firestore orderBy('displayName') instead of in-memory sorting
// 4. Implement full-text search using Algolia or similar for advanced search features
// 5. Add database indexes for firstName, lastName, email for efficient search filtering
// 6. Consider cursor-based pagination for better performance with large datasets
//
// Current implementation fetches all users for name sorting (acceptable for <500 users)
// but will need optimization as user base grows beyond typical small-to-medium organizations.

import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { formatFullName } from "@/utils/shared/nameUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "admin_list_active_users",
  });
  if (!allowed) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) return res.status(503).json({ error: "Database not available" });

  const usersCol = getUsersCollectionName();

  // Parse pagination parameters
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const sortBy = (req.query.sortBy as string) || "login-desc";
  const searchQuery = (req.query.search as string) || "";
  const adminsOnly = req.query.adminsOnly === "true";

  try {
    // Helper function to get display name
    const getDisplayName = (user: any) => {
      const fullName = formatFullName(user.firstName, user.lastName);
      if (fullName) return fullName;
      return user.email || ""; // Use email field (which contains document ID)
    };

    // Helper function to check if user matches search query
    const matchesSearch = (user: any, query: string) => {
      if (!query) return true;
      const searchLower = query.toLowerCase();
      const displayName = (getDisplayName(user) || "").toLowerCase();
      const email = (user.email || "").toLowerCase(); // Email is stored in user.email field
      return displayName.includes(searchLower) || email.includes(searchLower);
    };

    // Helper function to check if user is admin or superuser
    const isAdminRole = (user: any) => {
      const role = (user.role || "").toLowerCase();
      return role === "admin" || role === "superuser";
    };

    let allUsers: any[] = [];
    let filteredUsers: any[] = [];
    let items: any[] = [];

    // Always fetch all users when we have search, admin filter, or name sorting
    if (searchQuery || adminsOnly || sortBy === "name-asc") {
      const allSnapshot = await db.collection(usersCol).where("inviteStatus", "==", "accepted").get();

      allUsers = allSnapshot.docs.map((d: any) => {
        const data = d.data() || {};
        return {
          email: d.id, // Email is stored as document ID
          firstName: data.firstName || null,
          lastName: data.lastName || null,
          uuid: data.uuid || null,
          role: data.role || undefined,
          verifiedAt: data.verifiedAt?.toDate?.() ?? null,
          lastLoginAt: data.lastLoginAt?.toDate?.() ?? null,
          entitlements: data.entitlements || {},
        };
      });

      // Apply search filter
      filteredUsers = searchQuery ? allUsers.filter((user) => matchesSearch(user, searchQuery)) : allUsers;

      // Apply admin-only filter
      if (adminsOnly) {
        filteredUsers = filteredUsers.filter((user) => isAdminRole(user));
      }

      // Apply sorting
      if (sortBy === "name-asc") {
        filteredUsers.sort((a, b) => {
          const nameA = getDisplayName(a).toLowerCase();
          const nameB = getDisplayName(b).toLowerCase();
          return nameA.localeCompare(nameB);
        });
      } else {
        // Sort by login desc
        filteredUsers.sort((a, b) => {
          if (!a.lastLoginAt && !b.lastLoginAt) return 0;
          if (!a.lastLoginAt) return 1;
          if (!b.lastLoginAt) return -1;
          return new Date(b.lastLoginAt).getTime() - new Date(a.lastLoginAt).getTime();
        });
      }
    } else {
      // Fetch all users and sort in memory to include users without lastLoginAt
      // This ensures all users are shown, not just those with login timestamps
      const allSnapshot = await db.collection(usersCol).where("inviteStatus", "==", "accepted").get();

      filteredUsers = allSnapshot.docs.map((d: any) => {
        const data = d.data() || {};
        return {
          email: d.id, // Email is stored as document ID
          firstName: data.firstName || null,
          lastName: data.lastName || null,
          uuid: data.uuid || null,
          role: data.role || undefined,
          verifiedAt: data.verifiedAt?.toDate?.() ?? null,
          lastLoginAt: data.lastLoginAt?.toDate?.() ?? null,
          entitlements: data.entitlements || {},
        };
      });

      // Sort by login desc (users without lastLoginAt go to the end)
      filteredUsers.sort((a, b) => {
        if (!a.lastLoginAt && !b.lastLoginAt) return 0;
        if (!a.lastLoginAt) return 1;
        if (!b.lastLoginAt) return -1;
        return new Date(b.lastLoginAt).getTime() - new Date(a.lastLoginAt).getTime();
      });
    }

    // Calculate pagination based on filtered results
    const totalCount = filteredUsers.length;
    items = filteredUsers.slice(offset, offset + limit);

    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json({
      items,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (err: any) {
    const safeMessage = getSafeErrorMessage(err, "Failed to list active users");
    return res.status(500).json({ error: safeMessage });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
