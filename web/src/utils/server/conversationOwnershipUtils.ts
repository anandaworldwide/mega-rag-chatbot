import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";

/** Returns true when at least one answers document matches convId and uuid. */
export async function conversationBelongsToUuid(convId: string, uuid: string): Promise<boolean> {
  if (!db) {
    return false;
  }

  const ownershipQuery = db
    .collection(getAnswersCollectionName())
    .where("convId", "==", convId)
    .where("uuid", "==", uuid)
    .limit(1);

  const ownershipDocs = await firestoreQueryGet(
    ownershipQuery,
    "verify conversation ownership",
    `convId: ${convId}, uuid: ${uuid}`
  );

  return !ownershipDocs.empty;
}
