import jwt from "jsonwebtoken";

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== name) {
      continue;
    }
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function emailFromAuthCookieHeader(cookieHeader: string | undefined): string | undefined {
  const token = readCookie(cookieHeader, "authToken");
  if (!token) {
    return undefined;
  }
  const jwtSecret = process.env.SECURE_TOKEN;
  if (!jwtSecret) {
    return undefined;
  }
  try {
    // Verify with jsonwebtoken only. Do not import jwtUtils: that module loads
    // firebase-admin, and a client import would then fail the Vercel compile.
    const payload = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
      issuer: "mega-rag-chatbot",
      audience: "mega-rag-chatbot-users",
    }) as { email?: string };
    return payload.email;
  } catch (error) {
    console.error("Library access gate could not read the auth cookie:", error);
    return undefined;
  }
}
