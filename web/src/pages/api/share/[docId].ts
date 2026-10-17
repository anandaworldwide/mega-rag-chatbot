/**
 * Public, read-only share payload.
 * Reads the shared document, then returns display fields for turns in that
 * convId up to the shared timestamp. No uuid, email, IP, or other user data.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

const SHARE_TURN_LIMIT = 200;

export type PublicShareTurn = {
  id: string;
  question: string;
  answer: string;
  sources: unknown;
  timestamp: unknown;
  title: string | null;
  collection: string | null;
  suggestions: unknown;
  model: string | null;
};

export type PublicSharePayload = {
  id: string;
  title: string | null;
  turns: PublicShareTurn[];
};

function timestampSeconds(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed / 1000;
  }
  if (typeof value === "object") {
    const record = value as { seconds?: unknown; _seconds?: unknown };
    if (typeof record.seconds === "number") {
      return record.seconds;
    }
    if (typeof record._seconds === "number") {
      return record._seconds;
    }
  }
  return null;
}

function toPublicTurn(id: string, data: Record<string, unknown>): PublicShareTurn {
  return {
    id,
    question: typeof data.question === "string" ? data.question : "",
    answer: typeof data.answer === "string" ? data.answer : "",
    sources: data.sources ?? null,
    timestamp: data.timestamp ?? null,
    title: typeof data.title === "string" ? data.title : null,
    collection: typeof data.collection === "string" ? data.collection : null,
    suggestions: data.suggestions ?? [],
    model: typeof data.model === "string" ? data.model : null,
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ message: "Method not allowed" });
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 60,
    name: "share-api",
  });
  if (!allowed) {
    return;
  }

  const { docId } = req.query;
  if (!docId || typeof docId !== "string") {
    return res.status(400).json({ message: "Invalid document ID" });
  }

  if (!db) {
    return res.status(500).json({ message: "Database connection not available" });
  }

  try {
    const collectionName = getAnswersCollectionName();
    const docSnapshot = await firestoreGet(
      db.collection(collectionName).doc(docId),
      "share document get",
      `docId: ${docId}`
    );

    if (!docSnapshot?.exists) {
      return res.status(404).json({ message: "Document not found" });
    }

    const data = docSnapshot.data() as Record<string, unknown> | undefined;
    if (!data) {
      return res.status(404).json({ message: "Document not found" });
    }

    const sharedTurn = toPublicTurn(docSnapshot.id, data);
    let turns: PublicShareTurn[] = [sharedTurn];

    const convId = data.convId;
    if (typeof convId === "string" && convId.length > 0) {
      const query = db
        .collection(collectionName)
        .where("convId", "==", convId)
        .orderBy("timestamp", "asc")
        .limit(SHARE_TURN_LIMIT);

      const snapshot = await firestoreQueryGet(query, "share conversation turns", `convId: ${convId}`);
      const shareSeconds = timestampSeconds(data.timestamp);
      const convTurns = (snapshot?.docs || [])
        .map((doc: { id: string; data: () => Record<string, unknown> }) => toPublicTurn(doc.id, doc.data() || {}))
        .filter((turn: PublicShareTurn) => {
          if (shareSeconds == null) {
            return true;
          }
          const turnSeconds = timestampSeconds(turn.timestamp);
          return turnSeconds == null || turnSeconds <= shareSeconds;
        });

      if (convTurns.length > 0) {
        turns = convTurns;
        if (!turns.some((turn) => turn.id === sharedTurn.id)) {
          turns.push(sharedTurn);
        }
      }
    }

    const payload: PublicSharePayload = {
      id: docSnapshot.id,
      title: sharedTurn.title,
      turns,
    };
    return res.status(200).json(payload);
  } catch (error) {
    console.error("Error fetching shared conversation:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

export default handler;
