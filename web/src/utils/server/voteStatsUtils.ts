import { isClaudeAbTestComparableAnswer } from "@/utils/server/claudeAbTest";

export type VoteStatsLookbackDays = 7 | 30;

export type VoteStatsAnswerDoc = {
  id: string;
  question?: string | null;
  vote?: number | null;
  model?: string | null;
  abTestModel?: string | null;
  isLocationQuery?: boolean | null;
  feedbackReason?: string | null;
  feedbackComment?: string | null;
  timestamp?: { toDate?: () => Date; _seconds?: number; seconds?: number } | Date | string | null;
  feedbackTimestamp?: { toDate?: () => Date; _seconds?: number; seconds?: number } | Date | string | null;
};

export type VoteStatsDownvoteEventDoc = {
  id: string;
  answerDocId?: string | null;
  question?: string | null;
  feedbackReason?: string | null;
  feedbackComment?: string | null;
  model?: string | null;
  abTestModel?: string | null;
  triageCategory?: string | null;
  triageStatus?: string | null;
  createdAt?: { toDate?: () => Date; _seconds?: number; seconds?: number } | Date | string | null;
};

export type VoteStatsArmSummary = {
  arm: string;
  answers: number;
  comparableAnswers: number;
  upvotes: number;
  downvotes: number;
  comparableUpvotes: number;
  comparableDownvotes: number;
  geoOrOverrideVotes: number;
};

export type VoteStatsRecentVote = {
  id: string;
  vote: 1 | -1;
  model: string | null;
  abTestModel: string | null;
  isLocationQuery: boolean;
  comparable: boolean;
  question: string;
  feedbackReason: string | null;
  feedbackComment: string | null;
  timestamp: string | null;
};

export type VoteStatsSummary = {
  answersInWindow: number;
  answersWithModel: number;
  answersWithAbTestModel: number;
  answersWithoutAbTestModel: number;
  geoAnswers: number;
  upvotes: number;
  downvotes: number;
  comparableVotes: number;
  comparableUpvotes: number;
  comparableDownvotes: number;
  downvoteEventsInWindow: number;
};

export type VoteStatsResult = {
  summary: VoteStatsSummary;
  arms: VoteStatsArmSummary[];
  modelCounts: Array<{ model: string; count: number }>;
  recentVotes: VoteStatsRecentVote[];
  recentDownvoteEvents: Array<{
    id: string;
    answerDocId: string | null;
    question: string;
    reason: string | null;
    comment: string | null;
    model: string | null;
    abTestModel: string | null;
    triageCategory: string | null;
    triageStatus: string | null;
    createdAt: string | null;
  }>;
};

function toIso(value: VoteStatsAnswerDoc["timestamp"]): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value.toDate === "function") {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }
  const seconds = value._seconds ?? value.seconds;
  if (typeof seconds === "number") {
    return new Date(seconds * 1000).toISOString();
  }
  return null;
}

function truncate(text: string | null | undefined, max = 120): string {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function emptyArm(arm: string): VoteStatsArmSummary {
  return {
    arm,
    answers: 0,
    comparableAnswers: 0,
    upvotes: 0,
    downvotes: 0,
    comparableUpvotes: 0,
    comparableDownvotes: 0,
    geoOrOverrideVotes: 0,
  };
}

/**
 * Aggregate chat-log answers + downvote events for the admin vote / A/B dashboard.
 * Votes are attributed to answers created in the lookback window (upvote has no vote timestamp).
 */
export function aggregateVoteStats(
  answers: VoteStatsAnswerDoc[],
  downvoteEvents: VoteStatsDownvoteEventDoc[] = []
): VoteStatsResult {
  const armMap = new Map<string, VoteStatsArmSummary>();
  const modelMap = new Map<string, number>();
  const recentVotes: VoteStatsRecentVote[] = [];

  let answersWithModel = 0;
  let answersWithAbTestModel = 0;
  let geoAnswers = 0;
  let upvotes = 0;
  let downvotes = 0;
  let comparableVotes = 0;
  let comparableUpvotes = 0;
  let comparableDownvotes = 0;

  for (const answer of answers) {
    const model = typeof answer.model === "string" && answer.model.trim() ? answer.model.trim() : null;
    const abTestModel =
      typeof answer.abTestModel === "string" && answer.abTestModel.trim() ? answer.abTestModel.trim() : null;
    const isLocationQuery = answer.isLocationQuery === true;
    const comparable = isClaudeAbTestComparableAnswer({
      model,
      abTestModel,
      isLocationQuery,
    });
    const vote = answer.vote === 1 || answer.vote === -1 ? answer.vote : 0;
    const armKey = abTestModel || "(no abTestModel)";

    if (model) answersWithModel += 1;
    if (abTestModel) answersWithAbTestModel += 1;
    if (isLocationQuery) geoAnswers += 1;

    const modelKey = model || "(none)";
    modelMap.set(modelKey, (modelMap.get(modelKey) || 0) + 1);

    const arm = armMap.get(armKey) || emptyArm(armKey);
    arm.answers += 1;
    if (comparable) arm.comparableAnswers += 1;

    if (vote === 1 || vote === -1) {
      if (vote === 1) {
        upvotes += 1;
        arm.upvotes += 1;
      } else {
        downvotes += 1;
        arm.downvotes += 1;
      }

      if (comparable) {
        comparableVotes += 1;
        if (vote === 1) {
          comparableUpvotes += 1;
          arm.comparableUpvotes += 1;
        } else {
          comparableDownvotes += 1;
          arm.comparableDownvotes += 1;
        }
      }

      if (isLocationQuery || (model && abTestModel && model !== abTestModel)) {
        arm.geoOrOverrideVotes += 1;
      }

      recentVotes.push({
        id: answer.id,
        vote,
        model,
        abTestModel,
        isLocationQuery,
        comparable,
        question: truncate(answer.question),
        feedbackReason: typeof answer.feedbackReason === "string" ? answer.feedbackReason : null,
        feedbackComment: truncate(answer.feedbackComment, 160) || null,
        timestamp: toIso(answer.timestamp) || toIso(answer.feedbackTimestamp),
      });
    }

    armMap.set(armKey, arm);
  }

  recentVotes.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

  const arms = Array.from(armMap.values()).sort((a, b) => {
    if (a.arm === "(no abTestModel)") return 1;
    if (b.arm === "(no abTestModel)") return -1;
    return b.answers - a.answers;
  });

  const modelCounts = Array.from(modelMap.entries())
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);

  const recentDownvoteEvents = downvoteEvents
    .map((event) => ({
      id: event.id,
      answerDocId: typeof event.answerDocId === "string" ? event.answerDocId : null,
      question: truncate(event.question),
      reason: typeof event.feedbackReason === "string" ? event.feedbackReason : null,
      comment: truncate(event.feedbackComment, 160) || null,
      model: typeof event.model === "string" ? event.model : null,
      abTestModel: typeof event.abTestModel === "string" ? event.abTestModel : null,
      triageCategory: typeof event.triageCategory === "string" ? event.triageCategory : null,
      triageStatus: typeof event.triageStatus === "string" ? event.triageStatus : null,
      createdAt: toIso(event.createdAt),
    }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return {
    summary: {
      answersInWindow: answers.length,
      answersWithModel,
      answersWithAbTestModel,
      answersWithoutAbTestModel: answers.length - answersWithAbTestModel,
      geoAnswers,
      upvotes,
      downvotes,
      comparableVotes,
      comparableUpvotes,
      comparableDownvotes,
      downvoteEventsInWindow: downvoteEvents.length,
    },
    arms,
    modelCounts,
    recentVotes: recentVotes.slice(0, 50),
    recentDownvoteEvents: recentDownvoteEvents.slice(0, 50),
  };
}

export function parseVoteStatsLookbackDays(raw: string | string[] | undefined): VoteStatsLookbackDays {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "30" ? 30 : 7;
}
