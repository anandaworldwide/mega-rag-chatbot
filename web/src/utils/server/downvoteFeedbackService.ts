import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import {
  DownvoteFeedbackCluster,
  DownvoteFeedbackEvent,
  DownvoteFeedbackReason,
  DownvoteIdentityMode,
  DownvoteTriageCategory,
  DOWNVOTE_FEEDBACK_REASONS,
} from "@/types/downvoteFeedback";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { getTokenFromRequest, JwtPayload } from "@/utils/server/jwtUtils";

type ReporterIdentity = {
  identityMode: DownvoteIdentityMode;
  identityShareRequested: boolean;
  identityConsentDefaulted: boolean;
  reporterUuid?: string;
  reporterEmail?: string;
  reporterDisplayName?: string;
};

type InitialTriage = Pick<
  DownvoteFeedbackEvent,
  "triageStatus" | "triageMethod" | "triageCategory" | "triageConfidence" | "triageSummary" | "recommendedAction" | "taskCandidateKey"
>;

type BuildEventParams = {
  answerDocId: string;
  answerData: Record<string, any>;
  feedbackReason: DownvoteFeedbackReason;
  feedbackComment: string;
  reporterIdentity: ReporterIdentity;
};

export class DownvoteFeedbackService {
  static readonly llmUpgradeTimeoutMs = 3500;
  static readonly taskCreationThreshold = 2;

  static isValidFeedbackReason(value: string): value is DownvoteFeedbackReason {
    return (DOWNVOTE_FEEDBACK_REASONS as readonly string[]).includes(value);
  }

  static getCategoryLabel(category: DownvoteTriageCategory): string {
    const labels: Record<DownvoteTriageCategory, string> = {
      prompt_improvement: "Prompt improvement",
      retrieval_bug: "Retrieval or ranking issue",
      code_bug: "Application code change",
      content_gap: "Content gap",
      bad_source_link: "Bad source link",
      user_education: "User education",
      style_tone: "Style or tone adjustment",
      no_action: "No action",
      unclear: "Needs review",
    };

    return labels[category];
  }

  static normalizeTaskCandidateKey(rawValue: string): string {
    const normalized = rawValue
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    return normalized || "general_feedback_review";
  }

  static toIsoString(timestamp: unknown): string | null {
    if (!timestamp) {
      return null;
    }

    if (timestamp instanceof Date) {
      return timestamp.toISOString();
    }

    if (typeof timestamp === "string") {
      const parsed = new Date(timestamp);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }

    const firestoreTimestamp = timestamp as { toDate?: () => Date; _seconds?: number };
    if (typeof firestoreTimestamp.toDate === "function") {
      return firestoreTimestamp.toDate().toISOString();
    }

    if (typeof firestoreTimestamp._seconds === "number") {
      return new Date(firestoreTimestamp._seconds * 1000).toISOString();
    }

    return null;
  }

  static buildReporterDisplayName(firstName?: string | null, lastName?: string | null, email?: string): string | undefined {
    const name = [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ").trim();
    if (name) {
      return name;
    }

    if (email?.trim()) {
      return email.split("@")[0];
    }

    return undefined;
  }

  static async resolveReporterIdentity(
    req: NextApiRequest,
    res: NextApiResponse,
    shareIdentity: boolean
  ): Promise<ReporterIdentity> {
    let payload: JwtPayload | null = null;
    try {
      payload = getTokenFromRequest(req);
    } catch {
      payload = null;
    }

    const uuidResult = getSecureUUID(req, res, payload ?? undefined);
    const reporterUuid = uuidResult.success ? uuidResult.uuid : undefined;

    let reporterEmail: string | undefined;
    let reporterDisplayName: string | undefined;

    if (payload?.email && db) {
      reporterEmail = payload.email.toLowerCase();

      try {
        const userDoc = await firestoreGet(
          db.collection(getUsersCollectionName()).doc(reporterEmail),
          "get downvote reporter identity",
          reporterEmail
        );
        if (userDoc.exists) {
          const userData = userDoc.data() as { firstName?: string | null; lastName?: string | null } | undefined;
          reporterDisplayName = this.buildReporterDisplayName(userData?.firstName, userData?.lastName, reporterEmail);
        }
      } catch (error) {
        console.warn("Failed to load downvote reporter identity:", error);
      }
    }

    const canIdentify = Boolean(reporterDisplayName || reporterEmail || reporterUuid);

    if (!shareIdentity || !canIdentify) {
      return {
        identityMode: "anonymous",
        identityShareRequested: shareIdentity,
        identityConsentDefaulted: true,
      };
    }

    return {
      identityMode: "identified",
      identityShareRequested: true,
      identityConsentDefaulted: true,
      reporterUuid,
      reporterEmail,
      reporterDisplayName: reporterDisplayName || (reporterUuid ? `User ${reporterUuid.slice(0, 8)}` : undefined),
    };
  }

  static buildInitialTriage(question: string, feedbackReason: DownvoteFeedbackReason, feedbackComment: string): InitialTriage {
    const normalizedComment = feedbackComment.trim().toLowerCase();
    const normalizedQuestion = question.trim().toLowerCase();
    const searchableText = `${normalizedQuestion} ${normalizedComment}`.trim();

    let triageCategory: DownvoteTriageCategory = "unclear";
    let triageConfidence = 0.58;
    let recommendedAction = "Review this feedback manually and decide whether it belongs with an existing issue cluster.";
    let triageSummary = "This feedback needs manual review before routing.";
    let taskCandidateKey = "general_feedback_review";

    if (feedbackReason === "Bad Links" || /\b(404|broken link|dead link|bad link|wrong link|source link)\b/.test(searchableText)) {
      triageCategory = "bad_source_link";
      triageConfidence = 0.94;
      recommendedAction = "Verify the cited links and source references, then repair or suppress broken source links.";
      triageSummary = "The user reported a broken or incorrect source link.";
      taskCandidateKey = "broken_source_links";
    } else if (
      feedbackReason === "Technical Issue" ||
      /\b(location|nearest|near me|close to me|center|centers|distance|map|button|modal|crash|bug|error|filter)\b/.test(
        searchableText
      )
    ) {
      triageCategory = /\b(location|nearest|near me|center|centers|distance|map)\b/.test(searchableText)
        ? "code_bug"
        : "code_bug";
      triageConfidence = /\b(location|nearest|near me|center|centers|distance|map)\b/.test(searchableText) ? 0.93 : 0.88;
      recommendedAction = /\b(location|nearest|near me|center|centers|distance|map)\b/.test(searchableText)
        ? "Inspect the location intent and center lookup flow for a code-level fix."
        : "Reproduce the technical issue and fix the affected application flow.";
      triageSummary = /\b(location|nearest|near me|center|centers|distance|map)\b/.test(searchableText)
        ? "This looks like a location-intent or center-search code issue."
        : "The feedback points to an application bug rather than prompt quality.";
      taskCandidateKey = /\b(location|nearest|near me|center|centers|distance|map)\b/.test(searchableText)
        ? "location_intent_query"
        : "technical_issue";
    } else if (
      /\b(how do i|what can you do|where do i click|why are there no sources|how does this work|I expected)\b/.test(
        searchableText
      )
    ) {
      triageCategory = "user_education";
      triageConfidence = 0.78;
      recommendedAction = "Decide whether this should be handled with onboarding copy, tooltip guidance, or a short FAQ.";
      triageSummary = "The complaint appears to be an expectation or education gap rather than a system defect.";
      taskCandidateKey = "user_education_gap";
    } else if (
      feedbackReason === "Poor Style or Tone" ||
      /\b(tone|style|too wordy|too verbose|rude|harsh|blunt|format)\b/.test(searchableText)
    ) {
      triageCategory = "style_tone";
      triageConfidence = 0.86;
      recommendedAction = "Review the answer style and update formatting or tone guidance if the pattern repeats.";
      triageSummary = "The user disliked the tone, format, or writing style of the answer.";
      taskCandidateKey = "style_tone_adjustment";
    } else if (
      /\b(not in the library|missing content|does not cover|no source for|nothing on this topic|missing source)\b/.test(
        searchableText
      )
    ) {
      triageCategory = "content_gap";
      triageConfidence = 0.84;
      recommendedAction = "Check whether the content is missing from the corpus and whether ingestion or linking work is needed.";
      triageSummary = "The user appears to be asking for material the current corpus may not contain.";
      taskCandidateKey = "content_gap";
    } else if (
      feedbackReason === "Incorrect Information" ||
      /\b(incorrect|wrong|hallucinat|made up|not true|factually wrong|inaccurate)\b/.test(searchableText)
    ) {
      triageCategory = "retrieval_bug";
      triageConfidence = 0.82;
      recommendedAction = "Check retrieval quality, source grounding, and whether the answer should be constrained more tightly.";
      triageSummary = "The answer was reported as inaccurate or insufficiently grounded in the source material.";
      taskCandidateKey = "incorrect_information";
    } else if (
      feedbackReason === "Off-Topic Response" ||
      feedbackReason === "Vague or Unhelpful" ||
      /\b(off topic|irrelevant|did not answer|too vague|unhelpful|rambling|generic)\b/.test(searchableText)
    ) {
      triageCategory = "prompt_improvement";
      triageConfidence = 0.8;
      recommendedAction = "Review the prompt and answer-shaping instructions, then group similar misses into one prompt task.";
      triageSummary = "The answer missed the user intent or answered too vaguely, which usually points to prompt or response-shaping work.";
      taskCandidateKey = feedbackReason === "Off-Topic Response" ? "off_topic_response" : "vague_or_unhelpful";
    } else if (feedbackReason === "Other") {
      triageCategory = "unclear";
      triageConfidence = 0.56;
      recommendedAction = "Review the user comment and cluster it manually if a pattern emerges.";
      triageSummary = feedbackComment.trim()
        ? "The user chose Other, so this item needs manual review."
        : "The user downvoted without enough detail to classify automatically.";
      taskCandidateKey = "other_feedback";
    }

    if (triageCategory === "retrieval_bug" && /\b(link|source)\b/.test(searchableText)) {
      triageCategory = "bad_source_link";
      triageConfidence = 0.9;
      recommendedAction = "Inspect source link generation and fix incorrect or broken source references.";
      triageSummary = "The answer may be grounded poorly because the linked source references are wrong.";
      taskCandidateKey = "broken_source_links";
    }

    return {
      triageStatus: "classified",
      triageMethod: "heuristic",
      triageCategory,
      triageConfidence,
      triageSummary,
      recommendedAction,
      taskCandidateKey: this.normalizeTaskCandidateKey(taskCandidateKey),
    };
  }

  static buildEventRecord({ answerDocId, answerData, feedbackReason, feedbackComment, reporterIdentity }: BuildEventParams) {
    const createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const feedbackTimestamp =
      answerData.feedbackTimestamp ?? answerData.timestamp ?? firebase.firestore.FieldValue.serverTimestamp();
    const initialTriage = this.buildInitialTriage(answerData.question || "", feedbackReason, feedbackComment);

    const eventRecord: Omit<DownvoteFeedbackEvent, "id"> = {
      answerDocId,
      answerTimestamp: answerData.timestamp ?? null,
      site: process.env.SITE_ID || "default",
      createdAt,
      feedbackTimestamp,
      question: answerData.question || "",
      answer: answerData.answer || "",
      collection: answerData.collection || null,
      sources: Array.isArray(answerData.sources) ? answerData.sources : [],
      restatedQuestion: typeof answerData.restatedQuestion === "string" ? answerData.restatedQuestion : null,
      feedbackReason,
      feedbackComment,
      identityMode: reporterIdentity.identityMode,
      identityShareRequested: reporterIdentity.identityShareRequested,
      identityConsentDefaulted: reporterIdentity.identityConsentDefaulted,
      triageStatus: initialTriage.triageStatus,
      triageMethod: initialTriage.triageMethod,
      triageCategory: initialTriage.triageCategory,
      triageConfidence: initialTriage.triageConfidence,
      triageSummary: initialTriage.triageSummary,
      recommendedAction: initialTriage.recommendedAction,
      taskCandidateKey: initialTriage.taskCandidateKey,
    };

    if (reporterIdentity.identityMode === "identified") {
      if (reporterIdentity.reporterUuid) {
        eventRecord.reporterUuid = reporterIdentity.reporterUuid;
      }
      if (reporterIdentity.reporterEmail) {
        eventRecord.reporterEmail = reporterIdentity.reporterEmail;
      }
      if (reporterIdentity.reporterDisplayName) {
        eventRecord.reporterDisplayName = reporterIdentity.reporterDisplayName;
      }
    }

    return eventRecord;
  }

  static buildAnswerFeedbackMirror(eventId: string, eventRecord: Omit<DownvoteFeedbackEvent, "id">): Record<string, unknown> {
    return {
      feedbackEventId: eventId,
      feedbackIdentityMode: eventRecord.identityMode,
      feedbackIdentityShareRequested: eventRecord.identityShareRequested,
      feedbackReporterDisplayName:
        eventRecord.identityMode === "identified" ? eventRecord.reporterDisplayName || null : firebase.firestore.FieldValue.delete(),
      feedbackTriageStatus: eventRecord.triageStatus,
      feedbackTriageMethod: eventRecord.triageMethod,
      feedbackTriageCategory: eventRecord.triageCategory,
      feedbackTriageConfidence: eventRecord.triageConfidence,
      feedbackTriageSummary: eventRecord.triageSummary,
      feedbackRecommendedAction: eventRecord.recommendedAction,
      feedbackTaskCandidateKey: eventRecord.taskCandidateKey,
    };
  }

  private static cleanSampleText(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }

    return value
      .replace(/\s+/g, " ")
      .replace(/^[•\-–\d.)\s]+/, "")
      .trim();
  }

  private static isLowSignalSampleText(value: string): boolean {
    if (!value) {
      return true;
    }

    const normalized = value.toLowerCase();
    if (/^\d+$/.test(normalized)) {
      return true;
    }

    if (/^number\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\.?$/.test(normalized)) {
      return true;
    }

    return false;
  }

  static buildClusters(events: DownvoteFeedbackEvent[]): DownvoteFeedbackCluster[] {
    const clusters = new Map<string, DownvoteFeedbackEvent[]>();

    events.forEach((event) => {
      const key = this.normalizeTaskCandidateKey(event.taskCandidateKey || `${event.triageCategory}_${event.feedbackReason}`);
      const existing = clusters.get(key) || [];
      existing.push(event);
      clusters.set(key, existing);
    });

    return Array.from(clusters.entries())
      .map(([key, groupedEvents]) => {
        const sortedEvents = [...groupedEvents].sort((left, right) => {
          const leftTime = this.toIsoString(left.createdAt) || "";
          const rightTime = this.toIsoString(right.createdAt) || "";
          return rightTime.localeCompare(leftTime);
        });
        const latest = sortedEvents[0];
        const category = latest?.triageCategory || "unclear";
        const notionTaskUrl = sortedEvents.find((event) => event.notionTaskUrl)?.notionTaskUrl;
        const sampleIncidents = sortedEvents
          .map((event) => {
            const question = this.cleanSampleText(event.question);
            const comment = this.cleanSampleText(event.feedbackComment);
            const safeQuestion = this.isLowSignalSampleText(question) ? "" : question;
            const safeComment = this.isLowSignalSampleText(comment) ? "" : comment;

            if (!safeQuestion && !safeComment) {
              return null;
            }

            return {
              answerDocId: event.answerDocId,
              reason: event.feedbackReason,
              question: safeQuestion || undefined,
              comment: safeComment || undefined,
            };
          })
          .filter(Boolean)
          .slice(0, 3) as Array<{ answerDocId?: string; reason?: DownvoteFeedbackReason; question?: string; comment?: string }>;

        return {
          key,
          label: key.replace(/_/g, " "),
          triageCategory: category,
          totalEvents: sortedEvents.length,
          identifiedCount: sortedEvents.filter((event) => event.identityMode === "identified").length,
          taskCreatedCount: sortedEvents.filter((event) => Boolean(event.notionTaskUrl)).length,
          latestCreatedAt: this.toIsoString(latest?.createdAt),
          sampleQuestions: sortedEvents.slice(0, 3).map((event) => event.question).filter(Boolean),
          sampleComments: sortedEvents
            .map((event) => event.feedbackComment)
            .filter((comment) => Boolean(comment))
            .slice(0, 3),
          sampleIncidents,
          notionTaskUrl,
          averageConfidence:
            sortedEvents.reduce((total, event) => total + (Number.isFinite(event.triageConfidence) ? event.triageConfidence : 0), 0) /
            Math.max(sortedEvents.length, 1),
          recommendedAction: latest?.recommendedAction || "Review this cluster and decide whether it warrants action.",
        };
      })
      .sort((left, right) => {
        if (right.totalEvents !== left.totalEvents) {
          return right.totalEvents - left.totalEvents;
        }
        return (right.latestCreatedAt || "").localeCompare(left.latestCreatedAt || "");
      });
  }

  static shouldCreateNotionTask(cluster: DownvoteFeedbackCluster): boolean {
    if (cluster.triageCategory === "unclear" || cluster.triageCategory === "no_action" || cluster.triageCategory === "user_education") {
      return false;
    }

    if (cluster.totalEvents >= this.taskCreationThreshold) {
      return true;
    }

    if (cluster.triageCategory === "code_bug" || cluster.triageCategory === "bad_source_link") {
      return cluster.averageConfidence >= 0.88;
    }

    return false;
  }

  static buildNotionTitle(cluster: DownvoteFeedbackCluster): string {
    const categoryLabel = this.getCategoryLabel(cluster.triageCategory);
    return `${categoryLabel}: ${cluster.label}`;
  }
}
