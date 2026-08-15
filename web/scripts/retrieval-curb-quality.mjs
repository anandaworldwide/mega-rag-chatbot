#!/usr/bin/env node
/**
 * Retrieval-tool quality harness for Luca.
 *
 * Purpose: check that answer-first guidance does not block needed source expansion on
 * well-specified deliverables, while controls stay quiet.
 *
 * Usage (from web/; server must already be running — do not start it here):
 *   TTFB_EXPERIMENT=quality-tools node scripts/retrieval-curb-quality.mjs
 *
 *   # Compare two JSONL runs (e.g. before/after a code change):
 *   node scripts/retrieval-curb-quality.mjs --compare tmp/a.jsonl tmp/b.jsonl
 *
 * Auth: CHAT_BEARER_TOKEN or SECURE_TOKEN via ../.env.ananda
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.CHAT_BASE_URL || "http://localhost:3000";
const EXPERIMENT = process.env.TTFB_EXPERIMENT || "quality-curb";
const RUNS = Number.parseInt(process.env.TTFB_RUNS || "2", 10);
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
  const email = process.env.CHAT_EMAIL || "ttfb-quality@localhost";
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

/**
 * expectTools:
 *   "never"  — controls (definition / how-to); toolRounds>0 is a false positive
 *   "often"  — well-specified deliverables that often need expansion; 0 tools on both arms is OK if RAG is rich
 *   "clarify"— under-specified planning; should ask questions, not tool-loop
 */
const CASES = [
  {
    id: "ctrl-definition",
    expectTools: "never",
    question: "What is satchitananda?",
  },
  {
    id: "ctrl-howto",
    expectTools: "never",
    question: "How do I log in to Luca?",
  },
  {
    id: "ctrl-clarify-class",
    expectTools: "clarify",
    question: "Help me create a class on the Bhagavad Gita",
  },
  {
    id: "deliverable-class",
    expectTools: "often",
    question:
      "Create a 90-minute introductory class outline on willpower for Ananda meditation group leaders. Audience: kriyabans. Include direct quotes from Swami Kriyananda and at least one short story, with citations. Do not ask clarifying questions — use these details.",
  },
  {
    id: "deliverable-talk",
    expectTools: "often",
    question:
      "Prepare a 20-minute Sunday service talk outline on gratitude. Audience: general sangha. Include 3–5 exact quotes with citations from Master or Swami, plus one illustrative story. Do not ask clarifying questions — produce the full outline now.",
  },
  {
    id: "deliverable-quotes",
    expectTools: "often",
    question:
      "Find 8 exact quotations about chakras suitable for a workshop handout, preferably from Swami Kriyananda or Paramhansa Yogananda, each with a citation. Prefer complete sentences; if a passage is cut off, expand as needed. Do not ask clarifying questions.",
  },
  {
    id: "deliverable-research",
    expectTools: "often",
    question:
      "Research survey: what did Swami Kriyananda teach about magnetism and will? Purpose: talk prep. Depth: comprehensive. Include key themes, notable quotes with citations, and nuances. Do not ask clarifying questions — produce the full survey now.",
  },
];

const TOKEN = mintBearerToken();
if (!TOKEN && !process.argv.includes("--compare")) {
  console.error("Need CHAT_BEARER_TOKEN or SECURE_TOKEN (via .env.ananda) to authenticate.");
  process.exit(1);
}

function scoreAnswer(text, expectTools) {
  const answer = text || "";
  const lower = answer.toLowerCase();
  const wordCount = answer.trim() ? answer.trim().split(/\s+/).length : 0;
  const headingCount = (answer.match(/^#{1,3}\s/gm) || []).length;
  const quoteMarkPairs = Math.floor((answer.match(/["""]/g) || []).length / 2);
  const citationHints =
    (answer.match(/\([^)]{3,80}\)/g) || []).length +
    (answer.match(/\b(p\.|pp\.|page|chapter|ch\.)\s*\d+/gi) || []).length;
  const looksLikeClarification =
    wordCount < 120 &&
    ((answer.match(/\?/g) || []).length >= 2 ||
      /clarif|how long|audience|duration|who is|what length/i.test(answer));
  const hasClassShape =
    /opening/i.test(answer) &&
    /(teaching|main point|points)/i.test(answer) &&
    /(discussion|exercise|closing|meditation)/i.test(answer);
  const hasTalkShape =
    /(opening|hook)/i.test(answer) &&
    /(quote|story|closing)/i.test(answer);
  const hasResearchShape =
    /(overview|theme|nuance|quote)/i.test(lower) && headingCount >= 2;

  return {
    wordCount,
    headingCount,
    quoteMarkPairs,
    citationHints,
    looksLikeClarification,
    hasClassShape,
    hasTalkShape,
    hasResearchShape,
    expectTools,
  };
}

async function postChat({ question }) {
  const body = {
    question,
    history: [],
    collection: "whole_library",
    sourceCount: 4,
    uuid: UUID,
    temporarySession: true,
    mediaTypes: { text: true, audio: true, youtube: true },
  };

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
  let answer = "";
  let model = null;
  let doneTiming = null;
  let sawRetrievingMore = false;
  let maxSourceDocs = 0;
  let statusEvents = [];

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
      if (data.model) model = data.model;
      if (data.status) {
        statusEvents.push(data.status);
        if (data.status === "retrieving_more_sources") {
          sawRetrievingMore = true;
        }
      }
      if (Array.isArray(data.sourceDocs)) {
        maxSourceDocs = Math.max(maxSourceDocs, data.sourceDocs.length);
      }
      if (data.token) {
        if (ttfb === null) {
          ttfb = data.timing?.ttfb ?? Date.now() - started;
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

  const toolRounds = doneTiming?.toolRounds ?? (sawRetrievingMore ? 1 : 0);
  const retrievalToolMs = doneTiming?.retrievalToolMs ?? null;
  const quality = scoreAnswer(answer, null);

  return {
    ttfbMs: ttfb,
    elapsedMs: Date.now() - started,
    answerChars: answer.length,
    answerPreview: answer.slice(0, 220).replace(/\s+/g, " "),
    answerFull: answer,
    timing: doneTiming,
    model,
    toolRounds,
    retrievalToolMs,
    sawRetrievingMore,
    maxSourceDocs,
    statusEvents,
    quality,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function summarizeArm(rows) {
  const byId = {};
  for (const r of rows) {
    byId[r.caseId] = byId[r.caseId] || [];
    byId[r.caseId].push(r);
  }
  const out = {};
  for (const [id, list] of Object.entries(byId)) {
    const tools = list.map((r) => r.toolRounds || 0);
    const ttfb = list.map((r) => r.ttfbMs).filter((n) => typeof n === "number");
    const words = list.map((r) => r.quality?.wordCount || 0);
    const cites = list.map((r) => r.quality?.citationHints || 0);
    const toolRate = tools.filter((t) => t > 0).length / list.length;
    out[id] = {
      n: list.length,
      expectTools: list[0].expectTools,
      toolRate,
      toolRounds: tools,
      ttfbP50: percentile([...ttfb].sort((a, b) => a - b), 50),
      wordsP50: percentile([...words].sort((a, b) => a - b), 50),
      citesP50: percentile([...cites].sort((a, b) => a - b), 50),
      clarifyRate: list.filter((r) => r.quality?.looksLikeClarification).length / list.length,
    };
  }
  return out;
}

async function compareFiles(pathA, pathB) {
  const load = async (p) =>
    (await readFile(p, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((ln) => JSON.parse(ln));
  const a = await load(pathA);
  const b = await load(pathB);
  const sa = summarizeArm(a);
  const sb = summarizeArm(b);
  const ids = [...new Set([...Object.keys(sa), ...Object.keys(sb)])];

  console.log("\n=== Over-curb comparison ===");
  console.log(`A: ${pathA}`);
  console.log(`B: ${pathB}`);
  console.log(
    "Interpretation: on expectTools=often, if A(curb) toolRate << B(off) AND words/cites drop, over-curbing is likely."
  );
  console.log(
    "On expectTools=never, toolRate should stay ~0 on both; rise on curb-off is eager false positives.\n"
  );

  for (const id of ids) {
    const x = sa[id];
    const y = sb[id];
    if (!x || !y) {
      console.log(`${id}: missing in one arm`);
      continue;
    }
    console.log(
      `${id} (${x.expectTools}): toolRate ${x.toolRate.toFixed(2)}→${y.toolRate.toFixed(2)} | ` +
        `ttfbP50 ${x.ttfbP50}→${y.ttfbP50} | wordsP50 ${x.wordsP50}→${y.wordsP50} | ` +
        `citesP50 ${x.citesP50}→${y.citesP50} | clarify ${x.clarifyRate.toFixed(2)}→${y.clarifyRate.toFixed(2)}`
    );
  }
}

async function main() {
  if (process.argv.includes("--compare")) {
    const idx = process.argv.indexOf("--compare");
    const pathA = process.argv[idx + 1];
    const pathB = process.argv[idx + 2];
    if (!pathA || !pathB) {
      console.error("Usage: node scripts/retrieval-curb-quality.mjs --compare <armA.jsonl> <armB.jsonl>");
      process.exit(1);
    }
    const resolve = (p) => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));
    await compareFiles(resolve(pathA), resolve(pathB));
    return;
  }

  try {
    await fetch(BASE_URL, { method: "GET" });
  } catch {
    console.error(`Cannot reach ${BASE_URL}. Start Luca locally first, then re-run.`);
    process.exit(1);
  }

  const outDir = path.join(__dirname, "..", "tmp");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${EXPERIMENT}-${stamp}.jsonl`);
  await writeFile(outPath, "");

  console.log(`Experiment=${EXPERIMENT} runs=${RUNS} base=${BASE_URL}`);
  console.log(`Auth fingerprint=${createHash("sha256").update(TOKEN).digest("hex").slice(0, 8)}`);
  console.log(`Writing ${outPath}`);
  console.log(
    "Note: correlate with server [TTFB_METRICS] curbRetrievalTools / toolRounds in web/tmp/ttfb-metrics.jsonl\n"
  );

  for (const item of CASES) {
    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n[${item.id}] run ${run}/${RUNS} expect=${item.expectTools}`);
      console.log(`  Q: ${item.question.slice(0, 100)}${item.question.length > 100 ? "…" : ""}`);
      const result = await postChat({ question: item.question });
      const quality = scoreAnswer(result.answerFull, item.expectTools);
      const record = {
        experiment: EXPERIMENT,
        caseId: item.id,
        expectTools: item.expectTools,
        run,
        question: item.question,
        ttfbMs: result.ttfbMs,
        elapsedMs: result.elapsedMs,
        answerChars: result.answerChars,
        answerPreview: result.answerPreview,
        model: result.model,
        toolRounds: result.toolRounds,
        retrievalToolMs: result.retrievalToolMs,
        sawRetrievingMore: result.sawRetrievingMore,
        maxSourceDocs: result.maxSourceDocs,
        statusEvents: result.statusEvents,
        quality,
        timing: result.timing,
        recordedAt: new Date().toISOString(),
      };
      // Keep JSONL manageable — full answers are long; store separately only preview + scores
      await appendFile(outPath, `${JSON.stringify(record)}\n`);
      console.log(
        `  ttfb=${result.ttfbMs}ms tools=${result.toolRounds} retrievingMore=${result.sawRetrievingMore} ` +
          `sources=${result.maxSourceDocs} words=${quality.wordCount} cites~${quality.citationHints} ` +
          `clarify=${quality.looksLikeClarification}`
      );
    }
  }

  const rows = (await readFile(outPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((ln) => JSON.parse(ln));
  const summary = summarizeArm(rows);
  console.log("\n=== Arm summary ===");
  console.log(JSON.stringify({ experiment: EXPERIMENT, cases: summary }, null, 2));
  console.log(`JSONL: ${outPath}`);
  console.log(
    "\nNext: flip GROK_CURB_RETRIEVAL_TOOLS, restart server, re-run with a different TTFB_EXPERIMENT, then --compare the two JSONL files."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
