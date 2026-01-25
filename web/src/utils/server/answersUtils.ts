// This file contains utility functions for handling answers and related operations

import { db } from "@/services/firebase";
import firebase from "firebase-admin";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { getEnvName } from "@/utils/env";
import { getFromCache, setInCache, CACHE_EXPIRATION } from "@/utils/server/redisUtils";
import { Answer } from "@/types/answer";
import { Document } from "@langchain/core/documents";
import { DocMetadata } from "@/types/DocMetadata";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";

// Fetches answers from Firestore based on an array of IDs
// Uses batching to optimize database queries
export async function getAnswersByIds(ids: string[]): Promise<Answer[]> {
  // Check if db is available
  if (!db) {
    throw new Error("Database not available");
  }

  const answers: Answer[] = [];
  const chunkSize = 10;

  // Process IDs in chunks to avoid Firestore's 'in' query limit of 10
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);

    const snapshot = await firestoreQueryGet(
      db.collection(getAnswersCollectionName()).where(firebase.firestore.FieldPath.documentId(), "in", chunk),
      "answers batch query",
      `chunk ${Math.floor(i / chunkSize) + 1}, ids: ${chunk.join(", ")}`
    );

    snapshot.forEach((doc: any) => {
      const data = doc.data() as Omit<Answer, "id">;
      // Parse and clean up sources data
      data.sources = parseAndRemoveWordsFromSources(data.sources as string | Document<DocMetadata>[] | undefined);

      // Remove deprecated related questions fields if present
      if ("related_questions" in data) {
        delete data.related_questions;
      }
      if ("relatedQuestionsV2" in data) {
        delete data.relatedQuestionsV2;
      }

      answers.push({
        id: doc.id,
        ...data,
        // Explicitly include feedback fields from data if they exist
        feedbackReason: data.feedbackReason,
        feedbackComment: data.feedbackComment,
        feedbackTimestamp: data.feedbackTimestamp,
      });
    });
  }

  return answers;
}

// Parses and cleans up the sources data, removing unnecessary information
export function parseAndRemoveWordsFromSources(
  sources: string | Document<DocMetadata>[] | undefined
): Document<DocMetadata>[] {
  if (!sources) {
    return [];
  }

  let parsedSources: Document<DocMetadata>[] = [];
  if (typeof sources === "string") {
    try {
      const tempSources = JSON.parse(sources);
      parsedSources = Array.isArray(tempSources) ? tempSources : [];
    } catch (error) {
      console.error("parseAndRemoveWordsFromSources: Error parsing sources:", error);
    }
  } else if (Array.isArray(sources)) {
    parsedSources = sources;
  }

  // Remove 'full_info' from metadata and return cleaned up sources
  return parsedSources.map(({ pageContent, metadata }) => {
    const cleanedMetadata = { ...metadata };
    if (cleanedMetadata && "full_info" in cleanedMetadata) {
      delete cleanedMetadata.full_info;
    }
    return {
      pageContent,
      metadata: cleanedMetadata as DocMetadata,
    };
  });
}

// Generates a unique cache key for document count based on environment and site ID
function getCacheKeyForDocumentCount(): string {
  const envName = getEnvName();
  const siteId = process.env.SITE_ID || "default";
  return `${envName}_${siteId}_answers_count`;
}

// Retrieves the total number of documents in the answers collection
// Uses caching to improve performance for repeated calls
export async function getTotalDocuments(): Promise<number> {
  const cacheKey = getCacheKeyForDocumentCount();

  // Try to get the count from cache
  const cachedCount = await getFromCache<string>(cacheKey);
  if (cachedCount !== null) {
    return parseInt(cachedCount, 10);
  }

  // Check if db is available
  if (!db) {
    throw new Error("Database not available");
  }

  // Use the optimized count() method directly instead of streaming
  try {
    const snapshot = await db.collection(getAnswersCollectionName()).count().get();
    const count = snapshot.data().count;

    // Cache the result for future use
    await setInCache(cacheKey, count.toString(), CACHE_EXPIRATION);

    return count;
  } catch (_error) {
    // Fall back to the streaming method with timeout protection only if direct count fails
    let count = 0;
    try {
      const stream = db.collection(getAnswersCollectionName()).stream();
      // Count documents using a stream to handle large collections efficiently
      for await (const _ of stream) {
        count++;
      }

      // Cache the result for future use
      await setInCache(cacheKey, count.toString(), CACHE_EXPIRATION);
      return count;
    } catch (streamError) {
      console.error("Error counting documents:", streamError);
      // If all else fails, return 0 to prevent API timeout
      return 0;
    }
  }
}
