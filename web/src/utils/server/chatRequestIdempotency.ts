import { deleteFromCache, setInCacheIfNotExists } from "@/utils/server/redisUtils";

/** Max time a chat request lock may be held while in-flight (seconds). */
export const CHAT_REQUEST_LOCK_TTL_SECONDS = 300;

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ChatRequestLockResult = "acquired" | "duplicate" | "skipped";

export function isValidClientRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_REGEX.test(value.trim());
}

export function buildChatRequestLockKey(siteId: string, clientRequestId: string): string {
  return `chat:req:${siteId}:${clientRequestId.trim().toLowerCase()}`;
}

export async function acquireChatRequestLock(
  siteId: string,
  clientRequestId: string | undefined
): Promise<ChatRequestLockResult> {
  if (!clientRequestId || !isValidClientRequestId(clientRequestId)) {
    return "skipped";
  }

  const acquired = await setInCacheIfNotExists(
    buildChatRequestLockKey(siteId, clientRequestId),
    "processing",
    CHAT_REQUEST_LOCK_TTL_SECONDS
  );

  return acquired ? "acquired" : "duplicate";
}

export async function releaseChatRequestLock(
  siteId: string,
  clientRequestId: string | undefined
): Promise<void> {
  if (!clientRequestId || !isValidClientRequestId(clientRequestId)) {
    return;
  }

  await deleteFromCache(buildChatRequestLockKey(siteId, clientRequestId));
}
