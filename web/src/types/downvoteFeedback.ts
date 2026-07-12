export const DOWNVOTE_FEEDBACK_REASONS = [
  "Incorrect Information",
  "Off-Topic Response",
  "Bad Links",
  "Vague or Unhelpful",
  "Technical Issue",
  "Poor Style or Tone",
  "Other",
] as const;

export type DownvoteFeedbackReason = (typeof DOWNVOTE_FEEDBACK_REASONS)[number];

export const DOWNVOTE_IDENTITY_MODES = ["identified", "anonymous"] as const;
export type DownvoteIdentityMode = (typeof DOWNVOTE_IDENTITY_MODES)[number];

export const DOWNVOTE_TRIAGE_STATUSES = ["classified", "reviewed", "task_created", "ignored"] as const;
export type DownvoteTriageStatus = (typeof DOWNVOTE_TRIAGE_STATUSES)[number];

export const DOWNVOTE_TRIAGE_METHODS = ["heuristic", "llm"] as const;
export type DownvoteTriageMethod = (typeof DOWNVOTE_TRIAGE_METHODS)[number];

export const DOWNVOTE_TRIAGE_CATEGORIES = [
  "prompt_improvement",
  "retrieval_bug",
  "code_bug",
  "content_gap",
  "bad_source_link",
  "user_education",
  "style_tone",
  "no_action",
  "unclear",
] as const;

export type DownvoteTriageCategory = (typeof DOWNVOTE_TRIAGE_CATEGORIES)[number];

export const DOWNVOTE_OPERATOR_DECISIONS = ["accept", "modify", "reject", "no_action"] as const;
export type DownvoteOperatorDecision = (typeof DOWNVOTE_OPERATOR_DECISIONS)[number];

export type DownvoteGroupBy = "none" | "category" | "task";

export interface DownvoteFeedbackSampleIncident {
  answerDocId?: string;
  reason?: DownvoteFeedbackReason;
  question?: string;
  comment?: string;
}

export interface DownvoteFeedbackEvent {
  id?: string;
  answerDocId: string;
  answerTimestamp?: unknown;
  site: string;
  createdAt: unknown;
  feedbackTimestamp?: unknown;
  question: string;
  answer: string;
  collection?: string | null;
  sources?: unknown[];
  restatedQuestion?: string | null;
  model?: string | null;
  abTestModel?: string | null;
  feedbackReason: DownvoteFeedbackReason;
  feedbackComment: string;
  identityMode: DownvoteIdentityMode;
  identityShareRequested: boolean;
  identityConsentDefaulted: boolean;
  reporterUuid?: string;
  reporterEmail?: string;
  reporterDisplayName?: string;
  triageStatus: DownvoteTriageStatus;
  triageMethod: DownvoteTriageMethod;
  triageCategory: DownvoteTriageCategory;
  triageConfidence: number;
  triageSummary: string;
  recommendedAction: string;
  taskCandidateKey: string;
  notionTaskId?: string;
  notionTaskUrl?: string;
  operatorDecision?: DownvoteOperatorDecision;
  operatorReviewedAt?: unknown;
  operatorNote?: string;
}

export interface DownvoteFeedbackCluster {
  key: string;
  label: string;
  triageCategory: DownvoteTriageCategory;
  totalEvents: number;
  identifiedCount: number;
  taskCreatedCount: number;
  latestCreatedAt: string | null;
  sampleQuestions: string[];
  sampleComments: string[];
  sampleIncidents: DownvoteFeedbackSampleIncident[];
  notionTaskUrl?: string;
  averageConfidence: number;
  recommendedAction: string;
}

export interface DownvoteAnswerFilters {
  page?: number;
  triageStatus?: DownvoteTriageStatus | "all";
  triageCategory?: DownvoteTriageCategory | "all";
  feedbackReason?: DownvoteFeedbackReason | "all";
  identityMode?: DownvoteIdentityMode | "all";
  groupBy?: DownvoteGroupBy;
}
