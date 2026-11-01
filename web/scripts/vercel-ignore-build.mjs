#!/usr/bin/env node
/**
 * Vercel Ignored Build Step.
 *
 * Exit 0: skip the build.
 * Exit 1: run the build.
 *
 * Skip when VERCEL_ENV is not production and the project is not ananda-chatbot.
 * Production builds always run. Preview builds run only for ananda-chatbot.
 *
 * Identity uses SITE_ID (repo site env) or VERCEL_PROJECT_NAME (Vercel system
 * env). VERCEL_PROJECT_ID is not in this repo, so the script does not match IDs.
 */
const PREVIEW_ALLOWED_SITE_ID = "ananda";
const PREVIEW_ALLOWED_PROJECT_NAME = "ananda-chatbot";

function readTrimmedEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isAnandaChatbot(env = process.env) {
  const siteId = readTrimmedEnv(env, "SITE_ID");
  const projectName = readTrimmedEnv(env, "VERCEL_PROJECT_NAME");
  return siteId === PREVIEW_ALLOWED_SITE_ID || projectName === PREVIEW_ALLOWED_PROJECT_NAME;
}

function shouldSkipVercelBuild(env = process.env) {
  const vercelEnv = readTrimmedEnv(env, "VERCEL_ENV");
  if (vercelEnv === "production") {
    return false;
  }
  return !isAnandaChatbot(env);
}

function describeIdentity(env) {
  const siteId = readTrimmedEnv(env, "SITE_ID") || "(unset)";
  const projectName = readTrimmedEnv(env, "VERCEL_PROJECT_NAME") || "(unset)";
  const vercelEnv = readTrimmedEnv(env, "VERCEL_ENV") || "(unset)";
  return `VERCEL_ENV=${vercelEnv} SITE_ID=${siteId} VERCEL_PROJECT_NAME=${projectName}`;
}

function main() {
  const skip = shouldSkipVercelBuild(process.env);
  if (skip) {
    console.log(`Skipping Vercel build: non-production and not ananda-chatbot. ${describeIdentity(process.env)}`);
    process.exit(0);
  }
  console.log(`Continuing Vercel build. ${describeIdentity(process.env)}`);
  process.exit(1);
}

main();
