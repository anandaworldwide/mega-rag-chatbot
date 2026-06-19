#!/usr/bin/env node
/**
 * Enforce coverage thresholds using coverage/coverage-summary.json.
 *
 * Two bars:
 *  - Global floor: prevents regressions across the whole codebase (incl. render-heavy
 *    page/component shells that need integration tests to cover).
 *  - Logic subset: stricter bar on logic-bearing code (utils/hooks/services/contexts/api),
 *    where unit tests are high-value. Target is 70%.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeLogicSubsetPct } from "./logic-subset.mjs";

const summaryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "coverage", "coverage-summary.json");

if (!fs.existsSync(summaryPath)) {
  console.error("coverage-summary.json not found.");
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const total = summary.total;

// Global floor: ratchet upward as coverage improves.
const globalThresholds = {
  statements: 53,
  branches: 43,
  functions: 47,
  lines: 53,
};

// Logic subset statement bar (target 70%, enforced with a small CI buffer).
const logicStatementThreshold = 69;

const failures = Object.entries(globalThresholds).filter(([metric, min]) => total[metric].pct < min);

const logic = computeLogicSubsetPct(summary);
const logicFailed = logic.pct < logicStatementThreshold;

if (failures.length > 0 || logicFailed) {
  console.error("\nCoverage thresholds not met:");
  for (const [metric, min] of failures) {
    console.error(`  global ${metric}: ${total[metric].pct}% (required ${min}%)`);
  }
  if (logicFailed) {
    console.error(`  logic subset statements: ${logic.pct.toFixed(2)}% (required ${logicStatementThreshold}%)`);
  }
  process.exit(1);
}

console.log(`Coverage thresholds met. (logic subset: ${logic.pct.toFixed(2)}%)`);
