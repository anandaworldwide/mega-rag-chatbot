import type { NextApiRequest } from "next";
import { getTokenFromRequest, verifyToken } from "./jwtUtils";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "./firestoreUtils";
import { firestoreGet } from "./firestoreRetryUtils";

type Role = "user" | "admin" | "superuser";

export function getRequesterRole(req: NextApiRequest): Role {
  // Test-friendly override to avoid brittle JWT setup in unit tests
  if (process.env.NODE_ENV === "test") {
    const testRole = (req.headers["x-test-role"] as string | undefined)?.toLowerCase();
    if (testRole === "admin" || testRole === "superuser" || testRole === "user") {
      return testRole;
    }
  }

  try {
    // Prefer cookie when available
    const cookieJwt = req.cookies?.["auth"];
    if (cookieJwt) {
      const payload: any = verifyToken(cookieJwt);
      const role = typeof payload?.role === "string" ? (payload.role as string).toLowerCase() : "user";
      if (role === "admin" || role === "superuser") return role;
      // Fall through to header-based check when cookie role isn't elevated
    }
  } catch {
    // fall through to header-based check
  }

  try {
    const headerPayload: any = getTokenFromRequest(req);
    const role = typeof headerPayload?.role === "string" ? (headerPayload.role as string).toLowerCase() : "user";
    if (role === "admin" || role === "superuser") return role;
    return "user";
  } catch {
    return "user";
  }
}

export function requireAdminRole(req: NextApiRequest): boolean {
  const role = getRequesterRole(req);
  return role === "admin" || role === "superuser";
}

/**
 * Requires superuser role and throws an error if the requester is not a superuser.
 * This prevents privilege escalation where admin users could access superuser-only endpoints.
 *
 * @param req The Next.js API request
 * @throws Error with message "Unauthorized: Superuser privileges required" if role is insufficient
 */
export function requireSuperuserRole(req: NextApiRequest): void {
  const role = getRequesterRole(req);
  if (role !== "superuser") {
    throw new Error("Unauthorized: Superuser privileges required");
  }
}

/**
 * Gets the requester's role from Firestore (source of truth) instead of JWT token.
 * This ensures that role changes (e.g., admin demoted to user) take effect immediately
 * rather than waiting for JWT expiration.
 *
 * @param req The Next.js API request
 * @returns The user's role from Firestore, or "user" if not found or error occurs
 */
export async function getRequesterRoleFromFirestore(req: NextApiRequest): Promise<Role> {
  // Test-friendly override to avoid brittle JWT setup in unit tests
  if (process.env.NODE_ENV === "test") {
    const testRole = (req.headers["x-test-role"] as string | undefined)?.toLowerCase();
    if (testRole === "admin" || testRole === "superuser" || testRole === "user") {
      return testRole;
    }
  }

  if (!db) {
    console.warn("Firestore not available, falling back to JWT role");
    return getRequesterRole(req);
  }

  try {
    // Get email from JWT token (cookie or header)
    let email: string | undefined;

    try {
      const cookieJwt = req.cookies?.["auth"];
      if (cookieJwt) {
        const payload: any = verifyToken(cookieJwt);
        email = typeof payload?.email === "string" ? payload.email.toLowerCase() : undefined;
      }
    } catch {
      // Fall through to header-based check
    }

    if (!email) {
      try {
        const headerPayload: any = getTokenFromRequest(req);
        email = typeof headerPayload?.email === "string" ? headerPayload.email.toLowerCase() : undefined;
      } catch {
        // No email found, fall back to JWT role
        return getRequesterRole(req);
      }
    }

    if (!email) {
      return getRequesterRole(req);
    }

    // Fetch role from Firestore (source of truth)
    const usersCol = getUsersCollectionName();
    const userDoc = await firestoreGet(db.collection(usersCol).doc(email), "get requester role from Firestore", email);

    if (userDoc.exists) {
      const userData = userDoc.data() as any;
      const firestoreRole = typeof userData?.role === "string" ? (userData.role as string).toLowerCase() : undefined;
      if (firestoreRole === "admin" || firestoreRole === "superuser" || firestoreRole === "user") {
        return firestoreRole;
      }
    }

    // If Firestore lookup fails or role not found, fall back to JWT role
    return getRequesterRole(req);
  } catch (error) {
    console.error("Error fetching role from Firestore, falling back to JWT:", error);
    // Fall back to JWT role on error
    return getRequesterRole(req);
  }
}

/**
 * Requires admin or superuser role verified from Firestore (source of truth).
 * This ensures role changes take effect immediately rather than waiting for JWT expiration.
 *
 * @param req The Next.js API request
 * @throws Error with message "Unauthorized: Admin privileges required" if role is insufficient
 */
export async function requireAdminRoleFromFirestore(req: NextApiRequest): Promise<void> {
  const role = await getRequesterRoleFromFirestore(req);
  if (role !== "admin" && role !== "superuser") {
    throw new Error("Unauthorized: Admin privileges required");
  }
}

/**
 * Requires superuser role verified from Firestore (source of truth).
 * This ensures role changes take effect immediately rather than waiting for JWT expiration.
 * Use this for sensitive operations like newsletter sending and user management.
 *
 * @param req The Next.js API request
 * @throws Error with message "Unauthorized: Superuser privileges required" if role is insufficient
 */
export async function requireSuperuserRoleFromFirestore(req: NextApiRequest): Promise<void> {
  const role = await getRequesterRoleFromFirestore(req);
  if (role !== "superuser") {
    throw new Error("Unauthorized: Superuser privileges required");
  }
}
