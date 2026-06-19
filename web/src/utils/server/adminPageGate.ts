/*
 * Admin page gating helper
 *
 * Purpose
 * - Enforce correct admin access model per site type.
 *
 * Rules
 * - Login sites (siteConfig.requireLogin === true):
 *     Require a valid auth JWT cookie with role of "admin" or "superuser".
 *     Sudo cookie is NOT used on these sites.
 * - No-login sites (siteConfig.requireLogin === false):
 *     Require a valid sudoCookie (set via the bless flow). There are no user logins,
 *     so JWT role checks are not applicable here.
 *
 * Usage
 * - Call from getServerSideProps for admin pages to return notFound when access is denied.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyToken } from "./jwtUtils";
import { getSudoCookie } from "./sudoCookieUtils";
import type { SiteConfig } from "@/types/siteConfig";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "./firestoreUtils";
import { firestoreGet } from "./firestoreRetryUtils";

export async function isAdminPageAllowed(
  req: NextApiRequest,
  res: NextApiResponse | undefined,
  siteConfig: SiteConfig | null
): Promise<boolean> {
  const requireLogin = !!siteConfig?.requireLogin;
  if (requireLogin) {
    try {
      const cookieJwt = req.cookies?.["authToken"];
      if (!cookieJwt) {
        console.log("[isAdminPageAllowed] No auth cookie found");
        return false;
      }
      const payload: any = verifyToken(cookieJwt);
      const role = typeof payload?.role === "string" ? (payload.role as string).toLowerCase() : "user";
      console.log(`[isAdminPageAllowed] JWT role: ${role}, email: ${payload?.email}`);
      if (role === "admin" || role === "superuser") return true;
      // Fallback to live Firestore role by email if present
      const email = typeof payload?.email === "string" ? payload.email.toLowerCase() : undefined;
      if (email && db) {
        try {
          const usersCol = getUsersCollectionName();
          const snap = await firestoreGet(db.collection(usersCol).doc(email), "gating: get user role", email);
          const liveRole = snap.exists ? ((snap.data() as any)?.role as string | undefined) : undefined;
          console.log(`[isAdminPageAllowed] Firestore role: ${liveRole}`);
          return liveRole === "admin" || liveRole === "superuser";
        } catch (error) {
          console.error("[isAdminPageAllowed] Firestore lookup error:", error);
          return false;
        }
      }
      console.log("[isAdminPageAllowed] No email in token or no db connection");
      return false;
    } catch (error) {
      console.error("[isAdminPageAllowed] Token verification error:", error);
      return false;
    }
  }

  const sudo = getSudoCookie(req, res);
  return !!sudo.sudoCookieValue;
}

export async function isSuperuserPageAllowed(
  req: NextApiRequest,
  res: NextApiResponse | undefined,
  siteConfig: SiteConfig | null
): Promise<boolean> {
  const requireLogin = !!siteConfig?.requireLogin;
  if (requireLogin) {
    try {
      const cookieJwt = req.cookies?.["authToken"];
      if (!cookieJwt) return false;
      const payload: any = verifyToken(cookieJwt);
      const role = typeof payload?.role === "string" ? (payload.role as string).toLowerCase() : "user";
      if (role === "superuser") return true;
      // Fallback to live Firestore role by email if present
      const email = typeof payload?.email === "string" ? payload.email.toLowerCase() : undefined;
      if (email && db) {
        try {
          const usersCol = getUsersCollectionName();
          const snap = await firestoreGet(db.collection(usersCol).doc(email), "gating: get user role", email);
          const liveRole = snap.exists ? ((snap.data() as any)?.role as string | undefined) : undefined;
          return liveRole === "superuser";
        } catch {
          return false;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  const sudo = getSudoCookie(req, res);
  return !!sudo.sudoCookieValue;
}
