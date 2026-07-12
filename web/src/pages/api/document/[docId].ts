/**
 * API endpoint to fetch a single document by ID
 * Used for URL navigation to determine conversation ID and ownership
 */

import { NextApiRequest, NextApiResponse } from "next";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { db } from "@/services/firebase";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

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
      return res.status(404).json({ message: "Document data not found" });
    }

    // Return full document data for share functionality
    return res.status(200).json({
      id: docSnapshot.id,
      uuid: data.uuid,
      convId: data.convId,
      timestamp: data.timestamp,
      question: data.question,
      answer: data.answer,
      title: data.title,
      history: data.history || [],
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
