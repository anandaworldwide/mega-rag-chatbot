/**
 * API endpoint to fetch a single document by ID
 * Used for URL navigation to determine conversation ID for the owner
 */

import { NextApiRequest, NextApiResponse } from "next";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { db } from "@/services/firebase";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 60,
    name: "document-api",
  });
  if (!allowed) return;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authorization header required" });
  }

  const token = authHeader.substring(7);
  let userPayload: ReturnType<typeof verifyToken>;
  try {
    userPayload = verifyToken(token);
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  const uuidResult = getSecureUUID(req, res, userPayload);
  if (!uuidResult.success) {
    const status = uuidResult.statusCode === 503 ? 503 : 401;
    return res.status(status).json({ message: uuidResult.error });
  }
  const uuid = uuidResult.uuid;

  const { docId } = req.query;

  if (!docId || typeof docId !== "string") {
    return res.status(400).json({ message: "Invalid document ID" });
  }

  try {
    const collectionName = getAnswersCollectionName();
    if (!db) {
      return res.status(500).json({ message: "Database connection not available" });
    }
    const docRef = db.collection(collectionName).doc(docId);
    const docSnapshot = await docRef.get();

    if (!docSnapshot.exists) {
      return res.status(404).json({ message: "Document not found" });
    }

    const data = docSnapshot.data();
    if (!data) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (typeof data.uuid !== "string" || data.uuid !== uuid) {
      return res.status(404).json({ message: "Document not found" });
    }

    return res.status(200).json({
      id: docSnapshot.id,
      convId: data.convId,
      timestamp: data.timestamp,
      question: data.question,
      answer: data.answer,
      title: data.title,
      sources: data.sources,
      collection: data.collection,
      suggestions: data.suggestions || [],
      model: data.model || null,
    });
  } catch (error) {
    console.error("Error fetching document:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
