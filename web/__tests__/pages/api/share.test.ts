/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/share/[docId]";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreGet, firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockDb = db as any;

function makeChainableQuery() {
  const query: any = {};
  query.where = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.doc = jest.fn(() => query);
  return query;
}

describe("GET /api/share/{docId}", () => {
  let query: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    query = makeChainableQuery();
    mockDb.collection = jest.fn(() => query);
  });

  it("gives 404 for an unknown id", async () => {
    mockFirestoreGet.mockResolvedValue({ exists: false } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: "missing-doc" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res._getJSONData()).toEqual({ message: "Document not found" });
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("returns display turns with exact allowlist keys and no uuid, email, or ip", async () => {
    mockFirestoreGet.mockResolvedValue({
      exists: true,
      id: "share-doc",
      data: () => ({
        uuid: "secret-uuid",
        email: "owner@example.com",
        ip: "203.0.113.10",
        userAgent: "secret-agent",
        convId: "conv-1",
        question: "What is meditation?",
        answer: "A practice of inner stillness.",
        sources: "[]",
        timestamp: { seconds: 200 },
        title: "Meditation",
        collection: "whole_library",
        suggestions: [],
        model: "gpt-4o",
      }),
    } as any);

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "share-doc",
          data: () => ({
            uuid: "secret-uuid",
            email: "owner@example.com",
            ip: "203.0.113.10",
            question: "What is meditation?",
            answer: "A practice of inner stillness.",
            sources: "[]",
            timestamp: { seconds: 200 },
            title: "Meditation",
            collection: "whole_library",
            suggestions: [],
            model: "gpt-4o",
          }),
        },
      ],
    } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: "share-doc" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res._getJSONData();
    expect(Object.keys(body).sort()).toEqual(["id", "title", "turns"]);
    expect(body.id).toBe("share-doc");
    expect(body.title).toBe("Meditation");
    expect(body.turns).toHaveLength(1);
    expect(Object.keys(body.turns[0]).sort()).toEqual([
      "answer",
      "collection",
      "id",
      "model",
      "question",
      "sources",
      "suggestions",
      "timestamp",
      "title",
    ]);
    expect(body.turns[0]).toEqual({
      id: "share-doc",
      question: "What is meditation?",
      answer: "A practice of inner stillness.",
      sources: "[]",
      timestamp: { seconds: 200 },
      title: "Meditation",
      collection: "whole_library",
      suggestions: [],
      model: "gpt-4o",
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/secret-uuid/);
    expect(serialized).not.toMatch(/owner@example.com/);
    expect(serialized).not.toMatch(/203\.0\.113\.10/);
    expect(serialized).not.toMatch(/secret-agent/);
    expect(body).not.toHaveProperty("uuid");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("ip");
    expect(body.turns[0]).not.toHaveProperty("uuid");
    expect(body.turns[0]).not.toHaveProperty("email");
    expect(body.turns[0]).not.toHaveProperty("ip");
    expect(body.turns[0]).not.toHaveProperty("userAgent");
  });
});
