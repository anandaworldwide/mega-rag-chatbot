import { OpenAI } from "openai";
import { db } from "@/services/firebase";
import { DownvoteFeedbackEvent, DOWNVOTE_TRIAGE_CATEGORIES } from "@/types/downvoteFeedback";
import { DownvoteFeedbackService } from "@/utils/server/downvoteFeedbackService";
import { getAnswersCollectionName, getDownvoteFeedbackEventsCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";

type TriageResult = Pick<
  DownvoteFeedbackEvent,
  "triageStatus" | "triageMethod" | "triageCategory" | "triageConfidence" | "triageSummary" | "recommendedAction" | "taskCandidateKey"
>;

export class DownvoteFeedbackTriageService {
  private readonly openaiClient: OpenAI | null;

  constructor(openaiClient?: OpenAI | null) {
    this.openaiClient =
      openaiClient === undefined
        ? process.env.OPENAI_API_KEY
          ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
          : null
        : openaiClient;
  }

  private buildFallback(event: Pick<DownvoteFeedbackEvent, "question" | "feedbackReason" | "feedbackComment">): TriageResult {
    return DownvoteFeedbackService.buildInitialTriage(event.question, event.feedbackReason, event.feedbackComment);
  }

  private sanitizeModelResponse(rawContent: string, fallback: TriageResult): TriageResult {
    try {
      const parsed = JSON.parse(rawContent) as Partial<Record<keyof TriageResult, unknown>>;
      const category = DOWNVOTE_TRIAGE_CATEGORIES.includes(parsed.triageCategory as any)
        ? (parsed.triageCategory as TriageResult["triageCategory"])
        : fallback.triageCategory;
      const confidence =
        typeof parsed.triageConfidence === "number" && Number.isFinite(parsed.triageConfidence)
          ? Math.max(0, Math.min(1, parsed.triageConfidence))
          : fallback.triageConfidence;
      const summary =
        typeof parsed.triageSummary === "string" && parsed.triageSummary.trim()
          ? parsed.triageSummary.trim()
          : fallback.triageSummary;
      const action =
        typeof parsed.recommendedAction === "string" && parsed.recommendedAction.trim()
          ? parsed.recommendedAction.trim()
          : fallback.recommendedAction;
      const taskCandidateKey =
        typeof parsed.taskCandidateKey === "string" && parsed.taskCandidateKey.trim()
          ? DownvoteFeedbackService.normalizeTaskCandidateKey(parsed.taskCandidateKey)
          : fallback.taskCandidateKey;

      return {
        triageStatus: "classified",
        triageMethod: "llm",
        triageCategory: category,
        triageConfidence: confidence,
        triageSummary: summary,
        recommendedAction: action,
        taskCandidateKey,
      };
    } catch (error) {
      console.warn("Failed to parse downvote triage response:", error);
      return fallback;
    }
  }

  async classifyEvent(event: Pick<DownvoteFeedbackEvent, "question" | "feedbackReason" | "feedbackComment" | "answer">): Promise<TriageResult> {
    const fallback = this.buildFallback(event);
    if (!this.openaiClient) {
      return fallback;
    }

    try {
      const completion = await this.openaiClient.chat.completions.create({
        model: process.env.DOWNVOTE_TRIAGE_MODEL || "gpt-4.1-mini",
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: "json_object" } as any,
        messages: [
          {
            role: "system",
            content:
              "Classify user downvote feedback for a production RAG chatbot. " +
              "Return valid JSON with keys: triageCategory, triageConfidence, triageSummary, recommendedAction, taskCandidateKey. " +
              "Allowed triageCategory values: prompt_improvement, retrieval_bug, code_bug, content_gap, bad_source_link, user_education, style_tone, no_action, unclear. " +
              "Use short, operator-friendly text. taskCandidateKey should be a short snake_case issue label.",
          },
          {
            role: "user",
            content: JSON.stringify({
              question: event.question,
              answer: event.answer.slice(0, 2500),
              feedbackReason: event.feedbackReason,
              feedbackComment: event.feedbackComment,
              fallback,
            }),
          },
        ],
      });

      const rawContent = completion.choices[0]?.message?.content?.trim();
      if (!rawContent) {
        return fallback;
      }

      return this.sanitizeModelResponse(rawContent, fallback);
    } catch (error) {
      console.warn("LLM downvote triage failed, using heuristic fallback:", error);
      return fallback;
    }
  }

  async enrichFeedbackEvent(eventId: string, answerDocId?: string): Promise<TriageResult | null> {
    if (!db) {
      return null;
    }

    const eventRef = db.collection(getDownvoteFeedbackEventsCollectionName()).doc(eventId);
    const eventDoc = await firestoreGet(eventRef, "get downvote feedback event", eventId);
    if (!eventDoc.exists) {
      return null;
    }

    const eventData = eventDoc.data() as DownvoteFeedbackEvent;
    const triage = await this.classifyEvent({
      question: eventData.question,
      answer: eventData.answer,
      feedbackReason: eventData.feedbackReason,
      feedbackComment: eventData.feedbackComment,
    });

    await firestoreUpdate(
      eventRef,
      {
        triageStatus: triage.triageStatus,
        triageMethod: triage.triageMethod,
        triageCategory: triage.triageCategory,
        triageConfidence: triage.triageConfidence,
        triageSummary: triage.triageSummary,
        recommendedAction: triage.recommendedAction,
        taskCandidateKey: triage.taskCandidateKey,
      },
      "update downvote feedback triage",
      eventId
    );

    if (answerDocId) {
      const answerRef = db.collection(getAnswersCollectionName()).doc(answerDocId);
      await firestoreUpdate(
        answerRef,
        {
          feedbackTriageStatus: triage.triageStatus,
          feedbackTriageMethod: triage.triageMethod,
          feedbackTriageCategory: triage.triageCategory,
          feedbackTriageConfidence: triage.triageConfidence,
          feedbackTriageSummary: triage.triageSummary,
          feedbackRecommendedAction: triage.recommendedAction,
          feedbackTaskCandidateKey: triage.taskCandidateKey,
        },
        "mirror downvote feedback triage",
        answerDocId
      );
    }

    return triage;
  }

  async enrichRecentHeuristicEvents(limit: number = 25): Promise<number> {
    if (!db) {
      return 0;
    }

    const snapshot = await firestoreQueryGet(
      db.collection(getDownvoteFeedbackEventsCollectionName()).orderBy("createdAt", "desc").limit(limit),
      "recent downvote feedback events",
      `limit=${limit}`
    );

    let processed = 0;
    for (const doc of snapshot.docs) {
      const event = doc.data() as DownvoteFeedbackEvent;
      if (event.triageMethod === "llm") {
        continue;
      }

      await this.enrichFeedbackEvent(doc.id, event.answerDocId);
      processed += 1;
    }

    return processed;
  }
}
