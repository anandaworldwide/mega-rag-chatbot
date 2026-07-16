#!/usr/bin/env node
/**
 * Fail CI when juice (newsletter CSS inlining) cannot load its runtime deps.
 *
 * Incomplete npm lockfiles can list juice while omitting transitive packages
 * (mensch, slick, escape-goat). Vercel then fails processNewsletterBatch with
 * MODULE_NOT_FOUND. Local Jest suites that mock juice do not catch this.
 */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webPkgPath = path.join(repoRoot, "web", "package.json");
const require = createRequire(webPkgPath);

const REQUIRED_MODULES = ["juice", "mensch", "slick", "web-resource-inliner", "escape-goat"];

function fail(message) {
  console.error(`juice deps check failed: ${message}`);
  process.exit(1);
}

const lockfilePath = path.join(repoRoot, "package-lock.json");
if (!fs.existsSync(lockfilePath)) {
  fail("package-lock.json missing");
}

const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
const packages = lockfile.packages || {};

for (const name of ["mensch", "slick", "escape-goat"]) {
  const hasEntry = Object.keys(packages).some(
    (pkgPath) => pkgPath === `node_modules/${name}` || pkgPath.endsWith(`/node_modules/${name}`)
  );
  if (!hasEntry) {
    fail(
      `lockfile omits ${name} (required by juice). Reinstall juice so transitive deps are locked:\n` +
        `  npm uninstall juice --workspace=@mega-rag-chatbot/web && npm install juice@^11.0.1 --workspace=@mega-rag-chatbot/web`
    );
  }
}

for (const name of REQUIRED_MODULES) {
  try {
    require.resolve(name);
  } catch (error) {
    fail(`cannot resolve '${name}': ${error.message}`);
  }
}

try {
  const juice = require("juice");
  const html = juice('<style>p{color:red}</style><p>hi</p>');
  if (!html.includes("color") || !html.includes("hi")) {
    fail(`juice() returned unexpected HTML: ${html}`);
  }
} catch (error) {
  fail(`require('juice') / juice() threw ${error.code || "Error"}: ${error.message}`);
}

console.log("juice and newsletter CSS-inlining deps OK (mensch, slick, escape-goat resolve)");
