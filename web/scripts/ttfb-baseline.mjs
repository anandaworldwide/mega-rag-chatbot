#!/usr/bin/env node
/**
 * Local TTFB baseline / experiment runner for Luca chat.
 *
 * Usage (from web/):
 *   # Server must already be running (npm run dev). Do not start it from this script.
 *   node scripts/ttfb-baseline.mjs
 *   TTFB_EXPERIMENT=prod-like node scripts/ttfb-baseline.mjs
 *
 * Cache-friendly prompt layout + answer-first retrieval guidance are always on in code.
 * Auth:
 *   CHAT_BEARER_TOKEN=...   # preferred: paste JWT from a logged-in session
 *   or set SECURE_TOKEN in the env file and optionally CHAT_EMAIL / CHAT_UUID to mint a short-lived JWT
 *
 * Writes JSONL to web/tmp/ttfb-<experiment>-<timestamp>.jsonl
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.CHAT_BASE_URL || "http://localhost:3000";
const EXPERIMENT = process.env.TTFB_EXPERIMENT || "baseline";
const RUNS = Number.parseInt(process.env.TTFB_RUNS || "3", 10);
const UUID = process.env.CHAT_UUID || randomUUID();

async function loadEnvFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // optional
  }
}

await loadEnvFile(path.join(__dirname, "..", "..", ".env.ananda"));

function mintBearerToken() {
  if (process.env.CHAT_BEARER_TOKEN) {
    return process.env.CHAT_BEARER_TOKEN;
  }
  const secret = process.env.SECURE_TOKEN;
  if (!secret) {
    return null;
  }
  const jwt = require("jsonwebtoken");
  const email = process.env.CHAT_EMAIL || "ttfb-baseline@localhost";
  return jwt.sign(
    {
      client: "web",
      email,
      role: "user",
      uuid: UUID,
    },
    secret,
    {
      algorithm: "HS256",
      issuer: "mega-rag-chatbot",
      audience: "mega-rag-chatbot-users",
      expiresIn: "2h",
    }
  );
}

const TOKEN = mintBearerToken();

if (!TOKEN) {
  console.error(
    "Need CHAT_BEARER_TOKEN or SECURE_TOKEN (via .env.ananda / dotenv) to authenticate."
  );
  process.exit(1);
}

const QUESTIONS = [
  { id: "short-library", question: "What is satchitananda", followUp: null },
  { id: "author-quote", question: "What did Swami say about chakras?", followUp: null },
  { id: "prompt-only", question: "How do I log in to Luca?", followUp: null },
  {
    id: "planning",
    question: "Help me create a 6-week class on the Bhagavad Gita",
    followUp: null,
  },
  {
    id: "follow-up-pair",
    question: "What did Swami Kriyananda teach about willpower?",
    followUp: "go deeper on the second point",
  },
];

async function postChat({ question, history, convId, temporarySession }) {
  const body = {
    question,
    history: history || [],
    collection: "whole_library",
    sourceCount: 4,
    uuid: UUID,
    temporarySession: temporarySession !== false,
    mediaTypes: { text: true, audio: true, youtube: true },
  };
  if (convId) {
    body.convId = convId;
    body.temporarySession = false;
  }

  const started = Date.now();
  const response = await fetch(`${BASE_URL}/api/chat/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ttfb = null;
  let firstTokenAt = null;
  let doneTiming = null;
  let answer = "";
  let returnedConvId = convId || null;
  let model = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let data;
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (data.convId) returnedConvId = data.convId;
      if (data.model) model = data.model;
      if (data.token) {
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          ttfb = data.timing?.ttfb ?? firstTokenAt - started;
        }
        answer += data.token;
      }
      if (data.done) {
        doneTiming = data.timing || null;
        if (ttfb === null && doneTiming?.ttfb !== undefined) {
          ttfb = doneTiming.ttfb;
        }
      }
      if (data.error) {
        throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
      }
    }
  }

  return {
    ttfbMs: ttfb,
    firstTokenAt,
    elapsedMs: Date.now() - started,
    answerChars: answer.length,
    answerPreview: answer.slice(0, 120).replace(/\s+/g, " "),
    timing: doneTiming,
    convId: returnedConvId,
    model,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function summarize(values) {
  const sorted = [...values].filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0 };
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    mean: Math.round(mean),
    max: sorted[sorted.length - 1],
  };
}

async function main() {
  // Health check — do not start the server from this script.
  try {
    await fetch(BASE_URL, { method: "GET" });
  } catch {
    console.error(
      `Cannot reach ${BASE_URL}. Start Luca locally first (already-running next dev), then re-run.`
    );
    process.exit(1);
  }

  const outDir = path.join(__dirname, "..", "tmp");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `ttfb-${EXPERIMENT}-${stamp}.jsonl`);
  await writeFile(outPath, "");

  console.log(`Experiment=${EXPERIMENT} runs=${RUNS} base=${BASE_URL}`);
  console.log(`Auth fingerprint=${createHash("sha256").update(TOKEN).digest("hex").slice(0, 8)}`);
  console.log(`Writing ${outPath}`);

  const allTtfb = [];

  for (const item of QUESTIONS) {
    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n[${item.id}] run ${run}/${RUNS}: ${item.question}`);
      const first = await postChat({ question: item.question, history: [], temporarySession: true });
      const record = {
        experiment: EXPERIMENT,
        questionId: item.id,
        run,
        phase: "cold",
        question: item.question,
        ...first,
        recordedAt: new Date().toISOString(),
      };
      await appendFile(outPath, `${JSON.stringify(record)}\n`);
      allTtfb.push(first.ttfbMs);
      console.log(`  cold TTFB=${first.ttfbMs}ms model=${first.model} chars=${first.answerChars}`);

      if (item.followUp) {
        const history = [
          { role: "user", content: item.question },
          { role: "assistant", content: first.answerPreview || "(answer)" },
        ];
        const warm = await postChat({
          question: item.followUp,
          history,
          convId: first.convId || undefined,
          temporarySession: !first.convId,
        });
        const warmRecord = {
          experiment: EXPERIMENT,
          questionId: item.id,
          run,
          phase: "warm-followup",
          question: item.followUp,
          parentQuestion: item.question,
          ...warm,
          recordedAt: new Date().toISOString(),
        };
        await appendFile(outPath, `${JSON.stringify(warmRecord)}\n`);
        allTtfb.push(warm.ttfbMs);
        console.log(`  warm TTFB=${warm.ttfbMs}ms model=${warm.model} chars=${warm.answerChars}`);
      }
    }
  }

  const summary = summarize(allTtfb);
  console.log("\n=== Summary (all TTFB ms) ===");
  console.log(JSON.stringify({ experiment: EXPERIMENT, ...summary }, null, 2));
  console.log(`JSONL: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
