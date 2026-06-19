/** @jest-environment node */

jest.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(
    () => ({}),
    {
      FieldValue: {
        serverTimestamp: jest.fn(() => "SERVER_TIMESTAMP"),
        delete: jest.fn(() => "DELETE_SENTINEL"),
      },
    }
  ),
}));

import { DownvoteFeedbackService } from "@/utils/server/downvoteFeedbackService";
import type { DownvoteFeedbackEvent } from "@/types/downvoteFeedback";

describe("DownvoteFeedbackService static helpers", () => {
  describe("isValidFeedbackReason", () => {
    it("accepts known feedback reasons", () => {
      expect(DownvoteFeedbackService.isValidFeedbackReason("Incorrect Information")).toBe(true);
    });

    it("rejects unknown feedback reasons", () => {
      expect(DownvoteFeedbackService.isValidFeedbackReason("made_up_reason")).toBe(false);
    });
  });

  describe("getCategoryLabel", () => {
    it("returns human-readable labels", () => {
      expect(DownvoteFeedbackService.getCategoryLabel("retrieval_bug")).toBe("Retrieval or ranking issue");
      expect(DownvoteFeedbackService.getCategoryLabel("no_action")).toBe("No action");
    });
  });

  describe("normalizeTaskCandidateKey", () => {
    it("normalizes strings to snake_case keys", () => {
      expect(DownvoteFeedbackService.normalizeTaskCandidateKey("Bad Source Link!")).toBe("bad_source_link");
    });

    it("falls back to general key for empty input", () => {
      expect(DownvoteFeedbackService.normalizeTaskCandidateKey("---")).toBe("general_feedback_review");
    });
  });

  describe("toIsoString", () => {
    it("handles Date objects", () => {
      const date = new Date("2024-01-15T12:00:00.000Z");
      expect(DownvoteFeedbackService.toIsoString(date)).toBe("2024-01-15T12:00:00.000Z");
    });

    it("handles ISO strings", () => {
      expect(DownvoteFeedbackService.toIsoString("2024-01-15T12:00:00.000Z")).toBe(
        "2024-01-15T12:00:00.000Z"
      );
    });

    it("handles Firestore-like timestamps", () => {
      expect(
        DownvoteFeedbackService.toIsoString({ _seconds: 1705320000 })
      ).toBe(new Date(1705320000 * 1000).toISOString());
    });

    it("returns null for invalid values", () => {
      expect(DownvoteFeedbackService.toIsoString(null)).toBeNull();
      expect(DownvoteFeedbackService.toIsoString("not-a-date")).toBeNull();
    });
  });

  describe("buildReporterDisplayName", () => {
    it("prefers first and last name", () => {
      expect(DownvoteFeedbackService.buildReporterDisplayName("Alice", "Smith", "alice@example.com")).toBe(
        "Alice Smith"
      );
    });

    it("falls back to email local part", () => {
      expect(DownvoteFeedbackService.buildReporterDisplayName(null, null, "alice@example.com")).toBe("alice");
    });

    it("returns undefined when no identity available", () => {
      expect(DownvoteFeedbackService.buildReporterDisplayName(null, null)).toBeUndefined();
    });
  });

  describe("buildInitialTriage", () => {
    it("classifies bad source links", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("question", "Bad Links", "");
      expect(result.triageCategory).toBe("bad_source_link");
      expect(result.triageMethod).toBe("heuristic");
      expect(result.taskCandidateKey).toBe("broken_source_links");
    });

    it("classifies location technical issues as code bugs", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("Where is the nearest center?", "Technical Issue", "");
      expect(result.triageCategory).toBe("code_bug");
      expect(result.taskCandidateKey).toBe("location_intent_query");
    });

    it("classifies user education gaps", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("how do i use this", "Other", "");
      expect(result.triageCategory).toBe("user_education");
    });

    it("classifies style and tone complaints", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("answer", "Poor Style or Tone", "");
      expect(result.triageCategory).toBe("style_tone");
    });

    it("classifies content gaps", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("topic", "Other", "this is missing content entirely");
      expect(result.triageCategory).toBe("content_gap");
    });

    it("classifies incorrect information as retrieval bug", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("topic", "Incorrect Information", "");
      expect(result.triageCategory).toBe("retrieval_bug");
    });

    it("upgrades retrieval bug to bad source link when links are mentioned", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("topic", "Incorrect Information", "the source link is wrong");
      expect(result.triageCategory).toBe("bad_source_link");
    });

    it("classifies off-topic and vague responses as prompt improvements", () => {
      expect(DownvoteFeedbackService.buildInitialTriage("q", "Off-Topic Response", "").taskCandidateKey).toBe(
        "off_topic_response"
      );
      expect(DownvoteFeedbackService.buildInitialTriage("q", "Vague or Unhelpful", "").taskCandidateKey).toBe(
        "vague_or_unhelpful"
      );
    });

    it("defaults Other with no detail to unclear", () => {
      const result = DownvoteFeedbackService.buildInitialTriage("", "Other", "");
      expect(result.triageCategory).toBe("unclear");
      expect(result.taskCandidateKey).toBe("other_feedback");
    });
  });

  describe("buildEventRecord", () => {
    const baseParams = {
      answerDocId: "ans-1",
      answerData: { question: "What is meditation?", answer: "It is calm.", timestamp: "2024-01-01", sources: [] },
      feedbackReason: "Incorrect Information" as const,
      feedbackComment: "wrong",
    };

    it("omits reporter fields for anonymous identity", () => {
      const record = DownvoteFeedbackService.buildEventRecord({
        ...baseParams,
        reporterIdentity: { identityMode: "anonymous", identityShareRequested: false, identityConsentDefaulted: true },
      });
      expect(record.identityMode).toBe("anonymous");
      expect(record.reporterEmail).toBeUndefined();
      expect(record.triageCategory).toBe("retrieval_bug");
    });

    it("includes reporter fields for identified identity", () => {
      const record = DownvoteFeedbackService.buildEventRecord({
        ...baseParams,
        reporterIdentity: {
          identityMode: "identified",
          identityShareRequested: true,
          identityConsentDefaulted: true,
          reporterUuid: "uuid-1",
          reporterEmail: "a@b.com",
          reporterDisplayName: "Alice",
        },
      });
      expect(record.reporterUuid).toBe("uuid-1");
      expect(record.reporterEmail).toBe("a@b.com");
      expect(record.reporterDisplayName).toBe("Alice");
    });
  });

  describe("buildAnswerFeedbackMirror", () => {
    it("includes display name for identified reporters", () => {
      const mirror = DownvoteFeedbackService.buildAnswerFeedbackMirror("evt-1", {
        identityMode: "identified",
        reporterDisplayName: "Alice",
        identityShareRequested: true,
        triageStatus: "classified",
        triageMethod: "heuristic",
        triageCategory: "retrieval_bug",
        triageConfidence: 0.8,
        triageSummary: "summary",
        recommendedAction: "action",
        taskCandidateKey: "key",
      } as Omit<DownvoteFeedbackEvent, "id">);
      expect(mirror.feedbackEventId).toBe("evt-1");
      expect(mirror.feedbackReporterDisplayName).toBe("Alice");
    });

    it("deletes display name for anonymous reporters", () => {
      const mirror = DownvoteFeedbackService.buildAnswerFeedbackMirror("evt-2", {
        identityMode: "anonymous",
        identityShareRequested: false,
        triageStatus: "classified",
        triageMethod: "heuristic",
        triageCategory: "unclear",
        triageConfidence: 0.5,
        triageSummary: "s",
        recommendedAction: "a",
        taskCandidateKey: "k",
      } as Omit<DownvoteFeedbackEvent, "id">);
      expect(mirror.feedbackReporterDisplayName).toBe("DELETE_SENTINEL");
    });
  });

  describe("buildClusters", () => {
    const makeEvent = (overrides: Partial<DownvoteFeedbackEvent>): DownvoteFeedbackEvent =>
      ({
        id: Math.random().toString(),
        answerDocId: "ans",
        question: "Real question about meditation",
        feedbackComment: "Helpful comment here",
        feedbackReason: "Incorrect Information",
        triageCategory: "retrieval_bug",
        triageConfidence: 0.8,
        taskCandidateKey: "incorrect_information",
        identityMode: "anonymous",
        createdAt: "2024-01-01T00:00:00.000Z",
        ...overrides,
      }) as DownvoteFeedbackEvent;

    it("groups events by task candidate key and sorts by frequency", () => {
      const clusters = DownvoteFeedbackService.buildClusters([
        makeEvent({ taskCandidateKey: "incorrect_information" }),
        makeEvent({ taskCandidateKey: "incorrect_information" }),
        makeEvent({ taskCandidateKey: "style_tone_adjustment", triageCategory: "style_tone" }),
      ]);
      expect(clusters[0].key).toBe("incorrect_information");
      expect(clusters[0].totalEvents).toBe(2);
      expect(clusters[0].label).toBe("incorrect information");
    });

    it("filters low-signal sample incidents", () => {
      const clusters = DownvoteFeedbackService.buildClusters([
        makeEvent({ question: "42", feedbackComment: "1", taskCandidateKey: "k1" }),
      ]);
      expect(clusters[0].sampleIncidents).toHaveLength(0);
    });
  });

  describe("shouldCreateNotionTask", () => {
    const makeCluster = (overrides: Partial<import("@/types/downvoteFeedback").DownvoteFeedbackCluster>) =>
      ({
        key: "k",
        label: "l",
        triageCategory: "retrieval_bug",
        totalEvents: 1,
        averageConfidence: 0.5,
        ...overrides,
      }) as import("@/types/downvoteFeedback").DownvoteFeedbackCluster;

    it("never creates tasks for unclear/no_action/user_education", () => {
      expect(DownvoteFeedbackService.shouldCreateNotionTask(makeCluster({ triageCategory: "unclear" }))).toBe(false);
      expect(DownvoteFeedbackService.shouldCreateNotionTask(makeCluster({ triageCategory: "no_action" }))).toBe(false);
      expect(DownvoteFeedbackService.shouldCreateNotionTask(makeCluster({ triageCategory: "user_education" }))).toBe(false);
    });

    it("creates tasks once the event threshold is met", () => {
      expect(DownvoteFeedbackService.shouldCreateNotionTask(makeCluster({ totalEvents: 2 }))).toBe(true);
    });

    it("creates high-confidence code bug and bad link tasks below threshold", () => {
      expect(
        DownvoteFeedbackService.shouldCreateNotionTask(
          makeCluster({ triageCategory: "code_bug", totalEvents: 1, averageConfidence: 0.9 })
        )
      ).toBe(true);
      expect(
        DownvoteFeedbackService.shouldCreateNotionTask(
          makeCluster({ triageCategory: "bad_source_link", totalEvents: 1, averageConfidence: 0.5 })
        )
      ).toBe(false);
    });
  });

  describe("buildNotionTitle", () => {
    it("combines category label and cluster label", () => {
      const title = DownvoteFeedbackService.buildNotionTitle({
        triageCategory: "retrieval_bug",
        label: "incorrect information",
      } as import("@/types/downvoteFeedback").DownvoteFeedbackCluster);
      expect(title).toBe("Retrieval or ranking issue: incorrect information");
    });
  });
});
