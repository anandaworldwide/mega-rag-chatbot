/**
 * Defines the "logic-bearing" code subset that we hold to a higher coverage bar.
 *
 * Rationale: full React page/component shells are mostly JSX wiring whose statements
 * can only be covered by render-heavy integration tests. We track those in the global
 * floor but enforce a stricter bar on logic-bearing code (utils, hooks, services,
 * context, and API route handlers) where unit tests are high-value and low-cost.
 */

const LOGIC_PREFIXES = [
  "utils/",
  "hooks/",
  "services/",
  "contexts/",
  "pages/api/",
  "app/api/",
];

export function relativeSrcPath(absPath) {
  // Normalize Windows separators first so the /web/src/ strip works cross-platform.
  return absPath.replace(/\\/g, "/").replace(/.*\/web\/src\//, "");
}

export function isLogicFile(absPath) {
  const rel = relativeSrcPath(absPath);
  return LOGIC_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

/**
 * Compute aggregate statement coverage for the logic subset from a coverage-summary.json map.
 */
export function computeLogicSubsetPct(summary) {
  let total = 0;
  let covered = 0;
  for (const [filePath, entry] of Object.entries(summary)) {
    if (filePath === "total") continue;
    if (!isLogicFile(filePath)) continue;
    total += entry.statements.total;
    covered += entry.statements.covered;
  }
  if (total === 0) {
    // No logic files matched. This means path matching broke (or the subset is empty),
    // not that coverage is perfect. Fail loud rather than letting the gate pass at 100%.
    throw new Error(
      "Logic subset matched 0 statements. Check LOGIC_PREFIXES / path normalization in logic-subset.mjs."
    );
  }
  return {
    total,
    covered,
    pct: (100 * covered) / total,
  };
}
