#!/usr/bin/env node
/**
 * Fail CI when uuid cannot be required() without --experimental-require-module.
 * uuid@14 is ESM-only and breaks gaxios on Vercel; local Node 20 often hides this.
 */
import { createRequire } from "module";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

if (!process.execArgv.includes("--no-experimental-require-module")) {
  const result = spawnSync(
    process.execPath,
    ["--no-experimental-require-module", fileURLToPath(import.meta.url)],
    { stdio: "inherit", cwd: repoRoot }
  );
  process.exit(result.status ?? 1);
}

const require = createRequire(path.join(repoRoot, "package.json"));

function fail(message) {
  console.error(`CJS uuid compat check failed: ${message}`);
  process.exit(1);
}

function majorVersion(version) {
  const match = String(version).match(/^(\d+)/);
  return match ? Number(match[1]) : NaN;
}

const lockfilePath = path.join(repoRoot, "package-lock.json");
const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
const esmOnlyUuidEntries = Object.entries(lockfile.packages || {})
  .filter(([pkgPath, meta]) => {
    if (!pkgPath.endsWith("/uuid") && pkgPath !== "node_modules/uuid") {
      return false;
    }
    // @smithy/uuid is a different package
    if (pkgPath.includes("@smithy/uuid")) {
      return false;
    }
    return majorVersion(meta.version) >= 12;
  })
  .map(([pkgPath, meta]) => `${pkgPath}@${meta.version}`);

if (esmOnlyUuidEntries.length > 0) {
  fail(
    `lockfile still nests ESM-only uuid (major >= 12):\n  ${esmOnlyUuidEntries.join("\n  ")}\n` +
      "Delete nested uuid lock entries and re-run npm install so everything dedupes to 11.1.1."
  );
}

let uuidPkg;
try {
  uuidPkg = require("uuid/package.json");
} catch (error) {
  fail(`could not load uuid/package.json: ${error.message}`);
}

console.log(`Resolved uuid@${uuidPkg.version} (type=${uuidPkg.type || "commonjs"})`);

if (majorVersion(uuidPkg.version) >= 12) {
  fail(`resolved uuid@${uuidPkg.version} is ESM-only; pin override to 11.1.1`);
}

try {
  const uuid = require("uuid");
  if (typeof uuid.v4 !== "function") {
    fail("require('uuid') succeeded but v4 is missing");
  }
} catch (error) {
  fail(
    `require('uuid') threw ${error.code || "Error"}: ${error.message}\n` +
      "Pin uuid overrides to 11.1.1 (dual CJS/ESM), not ESM-only 14.x."
  );
}

try {
  require("gaxios");
} catch (error) {
  fail(`require('gaxios') threw ${error.code || "Error"}: ${error.message}`);
}

console.log("CJS require('uuid') and require('gaxios') OK without experimental-require-module");
