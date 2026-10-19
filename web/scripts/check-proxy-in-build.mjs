#!/usr/bin/env node
/**
 * Fail when the Next.js production build did not compile src/proxy.ts.
 *
 * Next 16 with src/pages and src/app only loads proxy.ts from web/src/.
 * Node proxy matchers land in functions-config-manifest.json as /_middleware.
 * Edge middleware land in middleware-manifest.json.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextServerDir = path.join(webRoot, ".next", "server");
const proxySourcePath = path.join(webRoot, "src", "proxy.ts");
const staleRootMiddlewarePath = path.join(webRoot, "middleware.ts");

function fail(message) {
  console.error(`Proxy build check failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(proxySourcePath)) {
  fail("web/src/proxy.ts is missing. Next 16 loads proxy from the same folder as app/ and pages/.");
}

if (fs.existsSync(staleRootMiddlewarePath)) {
  fail("web/middleware.ts still exists. Next 16 with src/pages does not load that file.");
}

const source = fs.readFileSync(proxySourcePath, "utf8");
if (!/export\s+(async\s+)?function\s+proxy\s*\(/.test(source) && !/export\s+\{[^}]*\bproxy\b/.test(source)) {
  fail("web/src/proxy.ts must export a function named proxy.");
}

const middlewareManifestPath = path.join(nextServerDir, "middleware-manifest.json");
const functionsManifestPath = path.join(nextServerDir, "functions-config-manifest.json");
if (!fs.existsSync(middlewareManifestPath) || !fs.existsSync(functionsManifestPath)) {
  fail("No .next/server manifests. Run next build --webpack in web/ first.");
}

const middlewareManifest = JSON.parse(fs.readFileSync(middlewareManifestPath, "utf8"));
const functionsManifest = JSON.parse(fs.readFileSync(functionsManifestPath, "utf8"));
const edgeFiles = middlewareManifest?.middleware?.["/"]?.files;
const hasEdgeMiddleware = Array.isArray(edgeFiles) && edgeFiles.length > 0;
const hasNodeProxy = Boolean(functionsManifest?.functions?.["/_middleware"]);

if (!hasEdgeMiddleware && !hasNodeProxy) {
  fail(
    "Build manifests have no proxy/middleware entry. Next did not compile src/proxy.ts. " +
      "Expected functions-config-manifest.json functions['/_middleware'] or middleware-manifest.json middleware['/']."
  );
}

const mode = hasNodeProxy ? "Node proxy (/_middleware)" : "Edge middleware";
console.log(`Proxy build check passed: ${mode} is part of the Next.js build.`);
