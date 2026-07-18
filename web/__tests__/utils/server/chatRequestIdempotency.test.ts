/** @jest-environment node */
import {
  acquireChatRequestLock,
  buildChatRequestLockKey,
  isValidClientRequestId,
  releaseChatRequestLock,
} from "@/utils/server/chatRequestIdempotency";
import { __setGlobalRedisClientForTesting } from "@/utils/server/redisUtils";

describe("chatRequestIdempotency", () => {
  afterEach(() => {
    __setGlobalRedisClientForTesting(null);
  });

  it("validates client request IDs as UUID v4", () => {
    expect(isValidClientRequestId("423e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isValidClientRequestId("not-a-uuid")).toBe(false);
    expect(isValidClientRequestId(undefined)).toBe(false);
    expect(isValidClientRequestId(null)).toBe(false);
    expect(isValidClientRequestId(123)).toBe(false);
    expect(isValidClientRequestId("   ")).toBe(false);
    expect(isValidClientRequestId("423e4567-e89b-12d3-a456-426614174000")).toBe(false);
  });

  it("builds stable lock keys and sanitizes siteId", () => {
    expect(buildChatRequestLockKey("ananda-public", "423E4567-E89B-42D3-A456-426614174000")).toBe(
      "chat:req:ananda-public:423e4567-e89b-42d3-a456-426614174000"
    );
    expect(buildChatRequestLockKey("ananda/../evil:x", "423e4567-e89b-42d3-a456-426614174000")).toBe(
      "chat:req:ananda_evil_x:423e4567-e89b-42d3-a456-426614174000"
    );
  });

  it("acquires and releases a chat request lock", async () => {
    const store = new Map<string, string>();
    __setGlobalRedisClientForTesting({
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, options?: { ex?: number; nx?: boolean }) => {
        if (options?.nx && store.has(key)) {
          return null;
        }
        store.set(key, value);
        return "OK";
      }),
      del: jest.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      ping: jest.fn(async () => "PONG"),
    });

    const clientRequestId = "423e4567-e89b-42d3-a456-426614174000";
    await expect(acquireChatRequestLock("ananda-public", clientRequestId)).resolves.toBe("acquired");
    await expect(acquireChatRequestLock("ananda-public", clientRequestId)).resolves.toBe("duplicate");

    await releaseChatRequestLock("ananda-public", clientRequestId);
    await expect(acquireChatRequestLock("ananda-public", clientRequestId)).resolves.toBe("acquired");
  });

  it("skips locking when clientRequestId is absent", async () => {
    await expect(acquireChatRequestLock("ananda-public", undefined)).resolves.toBe("skipped");
  });

  it("under concurrent acquire only one caller wins the NX lock", async () => {
    const store = new Map<string, string>();
    let setCalls = 0;
    __setGlobalRedisClientForTesting({
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, options?: { ex?: number; nx?: boolean }) => {
        setCalls += 1;
        if (options?.nx && store.has(key)) {
          return null;
        }
        store.set(key, value);
        return "OK";
      }),
      del: jest.fn(async () => 1),
      ping: jest.fn(async () => "PONG"),
    });

    const clientRequestId = "423e4567-e89b-42d3-a456-426614174000";
    const results = await Promise.all([
      acquireChatRequestLock("ananda-public", clientRequestId),
      acquireChatRequestLock("ananda-public", clientRequestId),
      acquireChatRequestLock("ananda-public", clientRequestId),
    ]);

    expect(results.filter((r) => r === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(2);
    expect(setCalls).toBe(3);
  });
});
