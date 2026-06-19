#!/usr/bin/env node
/**
 * Merge client and server coverage by taking the higher-coverage map per file.
 * Istanbul's default merge doubles statement counts when instrumentation differs between runs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createCoverageMap } = require("istanbul-lib-coverage");
const libReport = require("istanbul-lib-report");
const reports = require("istanbul-reports");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const coverageDir = path.join(root, "coverage");

function readCoverageFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hitRatio(fileCoverage) {
  if (!fileCoverage?.s) {
    return 0;
  }
  const values = Object.values(fileCoverage.s);
  if (values.length === 0) {
    return 0;
  }
  const covered = values.filter((count) => count > 0).length;
  return covered / values.length;
}

function maxMergeCoverage(clientCoverage, serverCoverage) {
  const merged = createCoverageMap({});
  const filePaths = new Set([
    ...Object.keys(clientCoverage || {}),
    ...Object.keys(serverCoverage || {}),
  ]);

  for (const filePath of filePaths) {
    const clientEntry = clientCoverage?.[filePath];
    const serverEntry = serverCoverage?.[filePath];

    if (clientEntry && serverEntry) {
      const chosen = hitRatio(clientEntry) >= hitRatio(serverEntry) ? clientEntry : serverEntry;
      merged.addFileCoverage(structuredClone(chosen));
    } else if (clientEntry) {
      merged.addFileCoverage(structuredClone(clientEntry));
    } else if (serverEntry) {
      merged.addFileCoverage(structuredClone(serverEntry));
    }
  }

  return merged;
}

const clientCoverage = readCoverageFile(path.join(coverageDir, "client", "coverage-final.json"));
const serverCoverage = readCoverageFile(path.join(coverageDir, "server", "coverage-final.json"));

if (!clientCoverage && !serverCoverage) {
  console.error("No coverage data found. Run client and server tests with --coverage first.");
  process.exit(1);
}

const coverageMap = maxMergeCoverage(clientCoverage, serverCoverage);

fs.mkdirSync(coverageDir, { recursive: true });
fs.writeFileSync(path.join(coverageDir, "coverage-final.json"), JSON.stringify(coverageMap.toJSON()));

const context = libReport.createContext({
  dir: coverageDir,
  coverageMap,
});

for (const reporter of ["text", "json-summary", "lcov"]) {
  reports.create(reporter).execute(context);
}

const summary = JSON.parse(fs.readFileSync(path.join(coverageDir, "coverage-summary.json"), "utf8"));
const total = summary.total;

const { computeLogicSubsetPct } = await import("./logic-subset.mjs");
const logic = computeLogicSubsetPct(summary);

console.log("\n=== MERGED COVERAGE SUMMARY ===");
console.log(`Statements : ${total.statements.pct}%`);
console.log(`Branches   : ${total.branches.pct}%`);
console.log(`Functions  : ${total.functions.pct}%`);
console.log(`Lines      : ${total.lines.pct}%`);
console.log(`Logic subset (stmts) : ${logic.pct.toFixed(2)}% (${logic.covered}/${logic.total})`);
