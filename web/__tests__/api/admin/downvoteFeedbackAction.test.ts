import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Mock firebase-admin for FieldValue.delete()/serverTimestamp() references in the handler
jest.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: {
        delete: jest.fn(() => "__DELETE__"),
        serverTimestamp: jest.fn(() => "__SERVER_TIMESTAMP__"),
      },
    },
  },
  firestore: {
    FieldValue: {
      delete: jest.fn(() => "__DELETE__"),
      serverTimestamp: jest.fn(() => "__SERVER_TIMESTAMP__"),
    },
  },
}));

// Minimal Firestore mock: collection().doc() returns a reference object whose identity is preserved
const answerRef = { __ref: "answer" };
const eventRef = { __ref: "event" };

let answerDocData: Record<string, any> = {};
let eventDocData: Record<string, any> = {};

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn((name: string) => ({
      doc: jest.fn(() => (name.includes("downvote_feedback_events") ? eventRef : answerRef)),
      where: jest.fn(() => ({})),
    })),
  },
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((handler) => handler),
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(() => ({ requireLogin: false })),
}));

jest.mock("@/utils/server/sudoCookieUtils", () => ({
  getSudoCookie: jest.fn(() => ({ sudoCookieValue: "ok" })),
}));

jest.mock("@/utils/server/authz", () => ({
  requireSuperuserRoleFromFirestore: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn(() => "answers"),
  getDownvoteFeedbackEventsCollectionName: jest.fn(() => "downvote_feedback_events"),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
  firestoreQueryGet: jest.fn(),
  firestoreUpdate: jest.fn(),
}));

jest.mock("@/utils/server/downvoteFeedbackService", () => ({
  DownvoteFeedbackService: {
    buildClusters: jest.fn(() => []),
    toIsoString: jest.fn(() => ""),
  },
}));

jest.mock("@/utils/server/notionTaskClient", () => ({
  NotionTaskClient: jest.fn().mockImplementation(() => ({
    isConfigured: jest.fn(() => true),
    findReusableTask: jest.fn(() => undefined),
    createDraftTask: jest.fn(() => undefined),
  })),
}));

jest.mock("@/utils/server/errorSanitization", () => ({
  getSafeErrorMessage: jest.fn((_err, fallback) => fallback),
}));

import handler from "@/pages/api/admin/downvoteFeedbackAction";

describe("/api/admin/downvoteFeedbackAction", () => {
  const firestoreRetryUtils = jest.requireMock("@/utils/server/firestoreRetryUtils");

  beforeEach(() => {
    jest.clearAllMocks();
    answerDocData = { feedbackEventId: "event-123" };
    eventDocData = {};

    firestoreRetryUtils.firestoreGet.mockImplementation((ref: any) => {
      if (ref === answerRef) {
        return Promise.resolve({ exists: true, data: () => answerDocData });
      }
      return Promise.resolve({ exists: true, data: () => eventDocData });
    });
    firestoreRetryUtils.firestoreUpdate.mockResolvedValue(undefined);
  });

  it("closes event as ignored when operator picks no_action, even if event has an existing notionTaskUrl", async () => {
    // Event was previously routed to a Notion task; operator now chooses Close - no action.
    eventDocData = {
      taskCandidateKey: "abc",
      notionTaskUrl: "https://notion.so/previously-linked-task",
      notionTaskId: "notion-id-1",
      triageStatus: "task_created",
    };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        answerDocId: "answer-1",
        operatorDecision: "no_action",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);

    // First firestoreUpdate is the event doc, second is the answer doc
    const calls = firestoreRetryUtils.firestoreUpdate.mock.calls;
    expect(calls.length).toBe(2);

    const [eventUpdateRef, eventUpdatePayload] = calls[0];
    const [answerUpdateRef, answerUpdatePayload] = calls[1];

    expect(eventUpdateRef).toBe(eventRef);
    expect(answerUpdateRef).toBe(answerRef);

    // Bug: current code overrides triageStatus back to "task_created" because the
    // event still has a notionTaskUrl, which contradicts the operator's explicit decision.
    expect(eventUpdatePayload.triageStatus).toBe("ignored");
    expect(eventUpdatePayload.operatorDecision).toBe("no_action");
    expect(answerUpdatePayload.feedbackTriageStatus).toBe("ignored");
    expect(answerUpdatePayload.feedbackOperatorDecision).toBe("no_action");
  });

  it("marks event as reviewed when operator picks accept without linking a task, even if event has an existing notionTaskUrl", async () => {
    // Operator uses "Reviewed - no task" on an event that was previously linked.
    eventDocData = {
      taskCandidateKey: "abc",
      notionTaskUrl: "https://notion.so/previously-linked-task",
      notionTaskId: "notion-id-1",
      triageStatus: "task_created",
    };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        answerDocId: "answer-1",
        operatorDecision: "accept",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);

    const calls = firestoreRetryUtils.firestoreUpdate.mock.calls;
    expect(calls.length).toBe(2);
    const [, eventUpdatePayload] = calls[0];
    const [, answerUpdatePayload] = calls[1];

    expect(eventUpdatePayload.triageStatus).toBe("reviewed");
    expect(answerUpdatePayload.feedbackTriageStatus).toBe("reviewed");
  });

  it("still records task_created when operator explicitly links a new Notion task via body", async () => {
    eventDocData = { taskCandidateKey: "abc" };

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        answerDocId: "answer-1",
        operatorDecision: "accept",
        notionTaskUrl: "https://notion.so/new-link",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const calls = firestoreRetryUtils.firestoreUpdate.mock.calls;
    const [, eventUpdatePayload] = calls[0];
    const [, answerUpdatePayload] = calls[1];
    expect(eventUpdatePayload.triageStatus).toBe("task_created");
    expect(eventUpdatePayload.notionTaskUrl).toBe("https://notion.so/new-link");
    expect(answerUpdatePayload.feedbackTriageStatus).toBe("task_created");
    expect(answerUpdatePayload.feedbackNotionTaskUrl).toBe("https://notion.so/new-link");
  });
});
