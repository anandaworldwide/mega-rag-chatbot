import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";

export const CLAUDE_AB_TEST_TREATMENT_MODEL = "claude-fable-5";
const DEFAULT_AB_TEST_PERCENT = 30;

export type ClaudeAbTestAssignment = {
  model: string;
  abTestModel: string;
};

function parseAbTestPercent(): number {
  const raw = process.env.CLAUDE_AB_TEST_PERCENT;
  if (raw === undefined || raw === "") {
    return DEFAULT_AB_TEST_PERCENT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_AB_TEST_PERCENT;
  }
  return Math.max(0, Math.min(100, parsed));
}

/**
 * Resolves the sticky Claude A/B arm for a conversation.
 * Force env and percent kill-switch apply only when assigning a new conversation.
 *
 * A/B success measurement: only count votes where model === abTestModel (exclude geo
 * overrides where execution model differs from the sticky arm, typically isLocationQuery).
 */
export async function resolveClaudeAbTestModel(options: {
  enabled: boolean;
  controlModel: string;
  convId?: string;
}): Promise<ClaudeAbTestAssignment | null> {
  if (!options.enabled) {
    return null;
  }

  const controlModel = options.controlModel || "gpt-4o";

  if (options.convId) {
    const sticky = await loadStickyAbTestModel(options.convId);
    if (sticky) {
      return { model: sticky, abTestModel: sticky };
    }
  }

  const forced = process.env.CLAUDE_AB_TEST_FORCE_MODEL?.trim();
  if (forced) {
    return { model: forced, abTestModel: forced };
  }

  const percent = parseAbTestPercent();
  const treatment = percent > 0 && Math.random() * 100 < percent;
  const assigned = treatment ? CLAUDE_AB_TEST_TREATMENT_MODEL : controlModel;
  return { model: assigned, abTestModel: assigned };
}

/** True when this answer should count toward Claude A/B success rates (model matches sticky arm). */
export function isClaudeAbTestComparableAnswer(answer: {
  model?: string | null;
  abTestModel?: string | null;
  isLocationQuery?: boolean | null;
}): boolean {
  if (answer.isLocationQuery) {
    return false;
  }
  const model = typeof answer.model === "string" ? answer.model.trim() : "";
  const abTestModel = typeof answer.abTestModel === "string" ? answer.abTestModel.trim() : "";
  return Boolean(model && abTestModel && model === abTestModel);
}

async function loadStickyAbTestModel(convId: string): Promise<string | null> {
  if (!db) {
    return null;
  }

  try {
    const snapshot = await db.collection(getAnswersCollectionName()).where("convId", "==", convId).limit(10).get();

    for (const doc of snapshot.docs) {
      const abTestModel = doc.data()?.abTestModel;
      if (typeof abTestModel === "string" && abTestModel.trim()) {
        return abTestModel.trim();
      }
    }
  } catch (error) {
    console.error("Failed to load sticky Claude A/B assignment:", error);
  }

  return null;
}
