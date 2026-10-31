import jwt from "jsonwebtoken";
import { cookieValuesNamed } from "@/utils/server/cookieHeader";

export function emailFromAuthCookieHeader(cookieHeader: string | undefined): string | undefined {
  const jwtSecret = process.env.SECURE_TOKEN;
  if (!jwtSecret) {
    return undefined;
  }

  const tokens = cookieValuesNamed(cookieHeader, "authToken");
  if (tokens.length === 0) {
    return undefined;
  }

  // Prefer the last verifiable token. Browsers send a parent-domain
  // `.ananda.org` authToken before the host token (`cookieHeader.test.ts`).
  let email: string | undefined;
  for (const token of tokens) {
    try {
      // Verify with jsonwebtoken only. Do not import jwtUtils: that module loads
      // firebase-admin, and a client import would then fail the Vercel compile.
      const payload = jwt.verify(token, jwtSecret, {
        algorithms: ["HS256"],
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      }) as { email?: string };
      if (payload.email) {
        email = payload.email;
      }
    } catch {
      // A parent-domain authToken can sit in front of the host token.
    }
  }

  return email;
}
