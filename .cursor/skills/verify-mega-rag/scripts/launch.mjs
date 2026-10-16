#!/usr/bin/env node
/**
 * Start Next.js for verification.
 * Bind 127.0.0.1 only. Override stale cloud index settings.
 * Do not print secret values.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const site = process.env.VERIFY_LAUNCH_SITE;
const port = process.env.VERIFY_LAUNCH_PORT;
const repoRoot = process.env.VERIFY_LAUNCH_REPO;
const runDir = process.env.VERIFY_LAUNCH_RUN_DIR;
const indexName = process.env.VERIFY_LAUNCH_INDEX_NAME;
const embeddingsModel = process.env.VERIFY_LAUNCH_EMBEDDINGS_MODEL;

if (!site || !port || !repoRoot || !runDir || !indexName || !embeddingsModel) {
  console.error("verify-mega-rag: launch.mjs missing VERIFY_LAUNCH_* values");
  process.exit(1);
}

const require = createRequire(path.join(repoRoot, "package.json"));
const dotenv = require("dotenv");

const envFile = path.join(repoRoot, `.env.${site}`);
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
}

const env = { ...process.env };
env.SITE_ID = site;
env.NODE_ENV = "development";
env.NEXT_PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
env.PINECONE_INDEX_NAME = indexName;
env.OPENAI_EMBEDDINGS_MODEL = embeddingsModel;
// Never inherit a production public URL from the parent environment.
delete env.VERCEL;
delete env.VERCEL_URL;

const nextCandidates = [
  path.join(repoRoot, "web", "node_modules", ".bin", "next"),
  path.join(repoRoot, "node_modules", ".bin", "next"),
];
const nextBin = nextCandidates.find((candidate) => fs.existsSync(candidate));
if (!nextBin) {
  console.error("verify-mega-rag: next binary is missing. Run cd web && npm ci");
  process.exit(1);
}

const stdoutPath = path.join(runDir, "launch.stdout.log");
const stderrPath = path.join(runDir, "launch.stderr.log");
const stdoutFd = fs.openSync(stdoutPath, "w");
const stderrFd = fs.openSync(stderrPath, "w");

const child = spawn(
  nextBin,
  ["dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)],
  {
    cwd: path.join(repoRoot, "web"),
    env,
    stdio: ["ignore", stdoutFd, stderrFd],
    detached: true,
  }
);

if (!child.pid) {
  console.error("verify-mega-rag: failed to spawn Next.js");
  process.exit(1);
}

fs.writeFileSync(path.join(runDir, "server.pid"), `${child.pid}\n`);
child.unref();
process.exit(0);
