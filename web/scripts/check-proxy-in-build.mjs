#!/usr/bin/env node
/**
 * Fail when the Next.js production build does not compile src/proxy.ts.
 *
 * Next 16 loads proxy.ts from web/src/ next to app/ and pages/.
 * A Node proxy matcher is stored in functions-config-manifest.json as /_middleware.
 * Edge middleware is stored in middleware-manifest.json.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextServerDir = path.join(webRoot, ".next", "server");
const proxySourcePath = path.join(webRoot, "src", "proxy.ts");
const staleRootMiddlewarePath = path.join(webRoot, "middleware.ts");
const FIX_INSTRUCTION = "Fix: keep the interceptor in web/src/proxy.ts and export function proxy.";

function fail(checkedFile, message) {
  if (checkedFile) {
    console.error(`Checked file: ${checkedFile}`);
  }
  console.error(`Proxy build check failed: ${message}`);
  console.error(FIX_INSTRUCTION);
  process.exit(1);
}

if (!fs.existsSync(proxySourcePath)) {
  fail("web/src/proxy.ts", "web/src/proxy.ts is missing. Next 16 loads proxy from the same folder as app/ and pages/.");
}

if (fs.existsSync(staleRootMiddlewarePath)) {
  fail("web/middleware.ts", "web/middleware.ts still exists. Next 16 with src/pages does not load that file.");
}

const source = fs.readFileSync(proxySourcePath, "utf8");
if (!/export\s+(async\s+)?function\s+proxy\s*\(/.test(source) && !/export\s+\{[^}]*\bproxy\b/.test(source)) {
  fail("web/src/proxy.ts", "web/src/proxy.ts must export a function named proxy.");
}

const middlewareManifestPath = path.join(nextServerDir, "middleware-manifest.json");
const functionsManifestPath = path.join(nextServerDir, "functions-config-manifest.json");
if (!fs.existsSync(functionsManifestPath)) {
  fail(
    ".next/server/functions-config-manifest.json",
    "No .next/server/functions-config-manifest.json. Run next build --webpack in web/ first."
  );
}

const functionsManifest = JSON.parse(fs.readFileSync(functionsManifestPath, "utf8"));
const hasNodeProxy = Boolean(functionsManifest?.functions?.["/_middleware"]);
let hasEdgeMiddleware = false;
if (fs.existsSync(middlewareManifestPath)) {
  const middlewareManifest = JSON.parse(fs.readFileSync(middlewareManifestPath, "utf8"));
  const edgeFiles = middlewareManifest?.middleware?.["/"]?.files;
  hasEdgeMiddleware = Array.isArray(edgeFiles) && edgeFiles.length > 0;
}

if (!hasEdgeMiddleware && !hasNodeProxy) {
  fail(
    ".next/server/functions-config-manifest.json",
    "Build manifests have no proxy or middleware entry. Next did not compile src/proxy.ts."
  );
}

const checkedFile = hasNodeProxy
  ? ".next/server/functions-config-manifest.json"
  : ".next/server/middleware-manifest.json";
const mode = hasNodeProxy ? "Node proxy (/_middleware)" : "Edge middleware (/)";
console.log(`Checked file: ${checkedFile}`);
console.log(`Proxy build check passed: ${mode} is part of the Next.js build.`);
