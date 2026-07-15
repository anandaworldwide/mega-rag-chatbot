import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { isDevelopment } from "@/utils/env";

/** Primary A/B treatment (Grok via xAI). */
export const AB_TEST_GROK_MODEL = "grok-4.5";
/** Tiny Claude Fable holdout for calibration against Anthropic. */
export const AB_TEST_FABLE_HOLDOUT_MODEL = "claude-fable-5";

const DEFAULT_CONTROL_PERCENT = 62;
const DEFAULT_GROK_PERCENT = 30;
const DEFAULT_FABLE_HOLDOUT_PERCENT = 8;

export type ClaudeAbTestAssignment = {
  model: string;
  abTestModel: string;
};

export type ArmWeights = {
  control: number;
  grok: number;
  fableHoldout: number;
};

function parsePercent(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, parsed));
}

/**
 * Resolves sticky 3-arm weights (control / Grok / Fable holdout).
 * When no AB_TEST_* envs are set: plan defaults control 62 / Grok 30 / Fable 8.
 * When any AB_TEST_* is set: unset siblings default to 0, then normalize to 100.
 * Examples: GROK=0 alone → all arms 0 → fallback 100% control; GROK=30 alone → 100% Grok.
 * Set all three for exact shares. Legacy CLAUDE_AB_TEST_PERCENT is ignored for weights.
 * Development always uses 100% Grok (see resolveClaudeAbTestModel).
 */
export function resolveAbTestArmWeights(): ArmWeights {
  if (isDevelopment()) {
    return { control: 0, grok: 100, fableHoldout: 0 };
  }

  const hasAnyExplicitWeight =
    process.env.AB_TEST_CONTROL_PERCENT !== undefined ||
    process.env.AB_TEST_GROK_PERCENT !== undefined ||
    process.env.AB_TEST_FABLE_HOLDOUT_PERCENT !== undefined;

  // Partial overrides: missing arms are 0. Full unset: use plan defaults.
  const fallbackControl = hasAnyExplicitWeight ? 0 : DEFAULT_CONTROL_PERCENT;
  const fallbackGrok = hasAnyExplicitWeight ? 0 : DEFAULT_GROK_PERCENT;
  const fallbackFable = hasAnyExplicitWeight ? 0 : DEFAULT_FABLE_HOLDOUT_PERCENT;

  const control = parsePercent(process.env.AB_TEST_CONTROL_PERCENT, fallbackControl);
  const grok = parsePercent(process.env.AB_TEST_GROK_PERCENT, fallbackGrok);
  const fableHoldout = parsePercent(process.env.AB_TEST_FABLE_HOLDOUT_PERCENT, fallbackFable);

  const total = control + grok + fableHoldout;
  if (total <= 0) {
    return { control: 100, grok: 0, fableHoldout: 0 };
  }
  if (total === 100) {
    return { control, grok, fableHoldout };
  }

  // Normalize to 100 so ops can set relative weights without exact sums.
  return {
    control: (control / total) * 100,
    grok: (grok / total) * 100,
    fableHoldout: (fableHoldout / total) * 100,
  };
}

function resolveForceModel(): string | null {
  const forced = process.env.AB_TEST_FORCE_MODEL?.trim() || process.env.CLAUDE_AB_TEST_FORCE_MODEL?.trim();
  return forced || null;
}

/**
 * Maps a roll in [0, 100) onto arms in control → Grok → Fable order.
 * Defaults (62/30/8): [0, 62) control, [62, 92) Grok, [92, 100) Fable.
 */
export function pickArmFromWeights(weights: ArmWeights, controlModel: string, roll: number): string {
  if (roll < weights.control) {
    return controlModel;
  }
  if (roll < weights.control + weights.grok) {
    return AB_TEST_GROK_MODEL;
  }
  if (roll < weights.control + weights.grok + weights.fableHoldout) {
    return AB_TEST_FABLE_HOLDOUT_MODEL;
  }
  return controlModel;
}

/**
 * Resolves the sticky model A/B arm for a conversation (control / Grok / Fable holdout).
 * In development, always assigns Grok (force env is ignored) so local testing stays
 * Grok-only regardless of leftover FORCE_MODEL, sticky history, or production weights.
 * In production, force env wins; otherwise sticky arm, else weighted draw.
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

  // Local/dev: run Grok only (ignore force env, sticky arms, and production weights).
  if (isDevelopment()) {
    return { model: AB_TEST_GROK_MODEL, abTestModel: AB_TEST_GROK_MODEL };
  }

  const forced = resolveForceModel();
  if (forced) {
    return { model: forced, abTestModel: forced };
  }

  if (options.convId) {
    const sticky = await loadStickyAbTestModel(options.convId);
    if (sticky) {
      return { model: sticky, abTestModel: sticky };
    }
  }

  const weights = resolveAbTestArmWeights();
  const roll = Math.random() * 100;
  const assigned = pickArmFromWeights(weights, controlModel, roll);
  return { model: assigned, abTestModel: assigned };
}

/** True when this answer should count toward A/B success rates (model matches sticky arm). */
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
