import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import {
  isAnswersViewerPasswordConfigured,
  passwordsMatchConstantTime,
  setAnswersViewerCookie,
} from "@/utils/server/answersViewerAuth";

function readPasswordFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const password = (body as { password?: unknown }).password;
  return typeof password === "string" ? password : null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (typeof req.query.password !== "undefined") {
    return res.status(400).json({ error: "Password must be sent in the request body" });
  }

  if (!isAnswersViewerPasswordConfigured()) {
    return res.status(403).json({ error: "Viewer access is not enabled" });
  }

  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 15 * 60 * 1000,
    max: 8,
    name: "answers_viewer_password",
  });
  if (!isAllowed) {
    return;
  }

  const password = readPasswordFromBody(req.body);
  if (password === null || password.length === 0) {
    return res.status(400).json({ error: "Password is required" });
  }

  if (!passwordsMatchConstantTime(password)) {
    return res.status(401).json({ error: "Invalid password" });
  }

  setAnswersViewerCookie(req, res);
  return res.status(200).json({ ok: true });
}

export default withApiMiddleware(handler, { skipAuth: true });
