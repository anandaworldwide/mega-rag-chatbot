import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/leaderboard";
import { db } from "@/services/firebase";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";

// Mock firebase-admin Timestamp
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      fromDate: jest.fn((date: Date) => ({
        seconds: Math.floor(date.getTime() / 1000),
        nanoseconds: 0,
        toDate: jest.fn(() => date),
      })),
    },
  },
}));

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreQueryGet: jest.fn(),
}));

jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: (handler: any) => handler, // Pass through without auth for tests
}));

jest.mock("@/utils/server/authz", () => ({
  requireAdminRoleFromFirestore: jest.fn(), // Allow admin access for tests
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn(() => "test_chatLogs"),
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

const mockDb = db as any;
const mockGenericRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;

describe("/api/admin/leaderboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenericRateLimiter.mockResolvedValue(true);
    // Reset collection mock to return fresh mocks each time
    mockDb.collection.mockReset();
  });

  it("should return 405 for non-GET requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toEqual({ error: "Method not allowed" });
  });

  it.skip("should return 503 when database is not available", async () => {
    // This test is skipped because mocking db as null is complex in the test environment
    // The actual error handling is tested in integration tests
  });

  it("should return empty array when no users found", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection.mockReturnValue(mockUsersCollection);
    mockFirestoreQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({ users: [] });
  });

  it("should return leaderboard with top users sorted by question count", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    const mockAnswersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection
      .mockReturnValueOnce(mockUsersCollection) // First call for users
      .mockReturnValue(mockAnswersCollection); // Subsequent calls for questions

    // Mock query chain for questions (uuid filter, no timestamp filter for "all")
    mockAnswersCollection.where.mockReturnThis();

    // Mock users data
    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user1@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: "John",
            lastName: "Doe",
          }),
        },
        {
          id: "user2@example.com",
          data: () => ({
            uuid: "uuid-2",
            firstName: "Jane",
            lastName: "Smith",
          }),
        },
        {
          id: "user3@example.com",
          data: () => ({
            uuid: "uuid-3",
            firstName: null,
            lastName: null,
          }),
        },
      ],
    };

    // Mock question counts (user2 has most questions, user1 has some, user3 has none)
    const mockQuestionsSnapshots = [
      { docs: [{ id: "q1" }, { id: "q2" }] }, // user1: 2 questions
      { docs: [{ id: "q3" }, { id: "q4" }, { id: "q5" }] }, // user2: 3 questions
      { docs: [] }, // user3: 0 questions
    ];

    mockFirestoreQueryGet
      .mockResolvedValueOnce(mockUsersSnapshot) // Users query
      .mockResolvedValueOnce(mockQuestionsSnapshots[0]) // user1 questions
      .mockResolvedValueOnce(mockQuestionsSnapshots[1]) // user2 questions
      .mockResolvedValueOnce(mockQuestionsSnapshots[2]); // user3 questions

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.users).toHaveLength(2); // user3 excluded (0 questions)
    expect(responseData.users[0]).toEqual({
      email: "user2@example.com",
      firstName: "Jane",
      lastName: "Smith",
      uuid: "uuid-2",
      questionCount: 3,
      displayName: "Jane Smith",
    });
    expect(responseData.users[1]).toEqual({
      email: "user1@example.com",
      firstName: "John",
      lastName: "Doe",
      uuid: "uuid-1",
      questionCount: 2,
      displayName: "John Doe",
    });
  });

  it("should handle users with only first name", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    const mockAnswersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection.mockReturnValueOnce(mockUsersCollection).mockReturnValue(mockAnswersCollection);
    mockAnswersCollection.where.mockReturnThis();

    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: "John",
            lastName: null,
          }),
        },
      ],
    };

    const mockQuestionsSnapshot = {
      docs: [{ id: "q1" }],
    };

    mockFirestoreQueryGet.mockResolvedValueOnce(mockUsersSnapshot).mockResolvedValueOnce(mockQuestionsSnapshot);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.users[0].displayName).toBe("John");
  });

  it("should handle users with only last name", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    const mockAnswersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection.mockReturnValueOnce(mockUsersCollection).mockReturnValue(mockAnswersCollection);
    mockAnswersCollection.where.mockReturnThis();

    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: null,
            lastName: "Doe",
          }),
        },
      ],
    };

    const mockQuestionsSnapshot = {
      docs: [{ id: "q1" }],
    };

    mockFirestoreQueryGet.mockResolvedValueOnce(mockUsersSnapshot).mockResolvedValueOnce(mockQuestionsSnapshot);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.users[0].displayName).toBe("Doe");
  });

  it("should use email as display name when no first/last name", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    const mockAnswersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection.mockReturnValueOnce(mockUsersCollection).mockReturnValue(mockAnswersCollection);
    mockAnswersCollection.where.mockReturnThis();

    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: null,
            lastName: null,
          }),
        },
      ],
    };

    const mockQuestionsSnapshot = {
      docs: [{ id: "q1" }],
    };

    mockFirestoreQueryGet.mockResolvedValueOnce(mockUsersSnapshot).mockResolvedValueOnce(mockQuestionsSnapshot);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.users[0].displayName).toBe("user@example.com");
  });

  it("should limit results to top 20 users", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    const mockAnswersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection.mockReturnValueOnce(mockUsersCollection).mockReturnValue(mockAnswersCollection);
    mockAnswersCollection.where.mockReturnThis();

    // Create 25 users
    const mockUsers = Array.from({ length: 25 }, (_, i) => ({
      id: `user${i}@example.com`,
      data: () => ({
        uuid: `uuid-${i}`,
        firstName: `User${i}`,
        lastName: "Test",
      }),
    }));

    const mockUsersSnapshot = {
      empty: false,
      docs: mockUsers,
    };

    // Mock question counts (descending order)
    const mockQuestionCounts = Array.from({ length: 25 }, (_, i) => ({
      docs: Array.from({ length: 25 - i }, (_, j) => ({ id: `q${i}-${j}` })),
    }));

    mockFirestoreQueryGet.mockResolvedValueOnce(mockUsersSnapshot).mockImplementation((query, operation, context) => {
      if (operation === "admin leaderboard question count" && context) {
        const uuidMatch = context.match(/uuid: uuid-(\d+)/);
        if (uuidMatch) {
          const userIndex = parseInt(uuidMatch[1]);
          return Promise.resolve(mockQuestionCounts[userIndex]);
        }
      }
      return Promise.resolve({ docs: [] });
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.users).toHaveLength(20);
    expect(responseData.users[0].questionCount).toBe(25); // Highest count
    expect(responseData.users[19].questionCount).toBe(6); // 20th highest count
  });

  it("should handle rate limiting", async () => {
    mockGenericRateLimiter.mockResolvedValue(false);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    // Rate limiter handles the response, so we just verify it was called
    expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
      max: 6,
      windowMs: 60 * 1000,
      name: "admin-leaderboard",
    });
  });

  it("should handle database errors gracefully", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection.mockReturnValue(mockUsersCollection);
    mockFirestoreQueryGet.mockRejectedValue(new Error("Database connection failed"));

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getData())).toEqual({
      error: "Database connection failed",
    });
  });

  it("should handle question count fetch errors for individual users", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    const mockAnswersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    mockDb.collection.mockReturnValueOnce(mockUsersCollection).mockReturnValue(mockAnswersCollection);
    mockAnswersCollection.where.mockReturnThis();

    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user1@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: "John",
            lastName: "Doe",
          }),
        },
        {
          id: "user2@example.com",
          data: () => ({
            uuid: "uuid-2",
            firstName: "Jane",
            lastName: "Smith",
          }),
        },
      ],
    };

    mockFirestoreQueryGet
      .mockResolvedValueOnce(mockUsersSnapshot)
      .mockRejectedValueOnce(new Error("Question count failed")) // user1 fails
      .mockResolvedValueOnce({ docs: [{ id: "q1" }] }); // user2 succeeds

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    // Only user2 should be included (user1 excluded due to error)
    expect(responseData.users).toHaveLength(1);
    expect(responseData.users[0].email).toBe("user2@example.com");
  });

  it("should filter questions by timestamp when timePeriod is 7days", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    // Create a mock that properly chains where() calls
    const createMockAnswersCollection = () => {
      const mockCollection: any = {
        where: jest.fn(),
      };
      mockCollection.where.mockReturnValue(mockCollection);
      return mockCollection;
    };

    const mockAnswersCollection = createMockAnswersCollection();

    // Set up collection mocks - first call for users, subsequent for answers
    mockDb.collection
      .mockReturnValueOnce(mockUsersCollection) // First call: users collection
      .mockReturnValue(mockAnswersCollection); // Subsequent calls: answers collection

    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: "John",
            lastName: "Doe",
          }),
        },
      ],
    };

    const mockQuestionsSnapshot = {
      docs: [{ id: "q1" }],
    };

    mockFirestoreQueryGet.mockResolvedValueOnce(mockUsersSnapshot).mockResolvedValueOnce(mockQuestionsSnapshot);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: { timePeriod: "7days" },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // Verify that where was called twice (uuid filter + timestamp filter)
    expect(mockAnswersCollection.where).toHaveBeenCalledTimes(2);
    expect(mockAnswersCollection.where).toHaveBeenNthCalledWith(1, "uuid", "==", "uuid-1");
    expect(mockAnswersCollection.where).toHaveBeenNthCalledWith(2, "timestamp", ">=", expect.any(Object));
  });

  it("should filter questions by timestamp when timePeriod is 30days", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    // Create a mock that properly chains where() calls
    const createMockAnswersCollection = () => {
      const mockCollection: any = {
        where: jest.fn(),
      };
      mockCollection.where.mockReturnValue(mockCollection);
      return mockCollection;
    };

    const mockAnswersCollection = createMockAnswersCollection();

    // Set up collection mocks - first call for users, subsequent for answers
    mockDb.collection
      .mockReturnValueOnce(mockUsersCollection) // First call: users collection
      .mockReturnValue(mockAnswersCollection); // Subsequent calls: answers collection

    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: "John",
            lastName: "Doe",
          }),
        },
      ],
    };

    const mockQuestionsSnapshot = {
      docs: [{ id: "q1" }],
    };

    mockFirestoreQueryGet.mockResolvedValueOnce(mockUsersSnapshot).mockResolvedValueOnce(mockQuestionsSnapshot);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: { timePeriod: "30days" },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // Verify that where was called twice (uuid filter + timestamp filter)
    expect(mockAnswersCollection.where).toHaveBeenCalledTimes(2);
    expect(mockAnswersCollection.where).toHaveBeenNthCalledWith(1, "uuid", "==", "uuid-1");
    expect(mockAnswersCollection.where).toHaveBeenNthCalledWith(2, "timestamp", ">=", expect.any(Object));
  });

  it("should not filter by timestamp when timePeriod is all", async () => {
    const mockUsersCollection = {
      where: jest.fn().mockReturnThis(),
    };

    // Create a mock that properly chains where() calls
    const createMockAnswersCollection = () => {
      const mockCollection: any = {
        where: jest.fn(),
      };
      mockCollection.where.mockReturnValue(mockCollection);
      return mockCollection;
    };

    const mockAnswersCollection = createMockAnswersCollection();

    // Set up collection mocks - first call for users, subsequent for answers
    mockDb.collection
      .mockReturnValueOnce(mockUsersCollection) // First call: users collection
      .mockReturnValue(mockAnswersCollection); // Subsequent calls: answers collection

    const mockUsersSnapshot = {
      empty: false,
      docs: [
        {
          id: "user@example.com",
          data: () => ({
            uuid: "uuid-1",
            firstName: "John",
            lastName: "Doe",
          }),
        },
      ],
    };

    const mockQuestionsSnapshot = {
      docs: [{ id: "q1" }],
    };

    mockFirestoreQueryGet.mockResolvedValueOnce(mockUsersSnapshot).mockResolvedValueOnce(mockQuestionsSnapshot);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      env: {},
      headers: { authorization: "Bearer valid-jwt-token" },
      query: { timePeriod: "all" },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // Verify that where was called only once (uuid filter, no timestamp filter)
    expect(mockAnswersCollection.where).toHaveBeenCalledTimes(1);
    expect(mockAnswersCollection.where).toHaveBeenCalledWith("uuid", "==", "uuid-1");
  });
});
