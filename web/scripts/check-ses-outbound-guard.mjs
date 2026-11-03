#!/usr/bin/env node
/**
 * Fail when web/src contains a direct SES send outside outbound.ts.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const defaultWebRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.resolve(process.env.WEB_ROOT || defaultWebRoot);
const srcRoot = path.join(webRoot, "src");
const allowedRelative = path.join("src", "utils", "server", "outbound.ts");

const BANNED_PATTERNS = [
  { name: "SendEmailCommand", regex: /SendEmailCommand/ },
  { name: "SESClient", regex: /SESClient/ },
  { name: "@aws-sdk/client-ses", regex: /@aws-sdk\/client-ses/ },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function collectSourceFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

if (!fs.existsSync(srcRoot)) {
  console.error(`SES outbound guard failed: missing ${srcRoot}`);
  process.exit(1);
}

const violations = [];
for (const filePath of collectSourceFiles(srcRoot)) {
  const relativePath = path.relative(webRoot, filePath).split(path.sep).join("/");
  if (relativePath === allowedRelative.split(path.sep).join("/")) {
    continue;
  }

  const text = fs.readFileSync(filePath, "utf8");
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.regex.test(text)) {
      violations.push(`${relativePath}: ${pattern.name}`);
    }
  }
}

if (violations.length > 0) {
  console.error("SES outbound guard failed. Only web/src/utils/server/outbound.ts may send SES mail.");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exit(1);
}

console.log("SES outbound guard passed.");
