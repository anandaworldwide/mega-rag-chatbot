/**
 * Live proof for the fetch-additional-sources answer guard.
 *
 * Calls setupAndExecuteLanguageModelChain with the production model path
 * (site-config modelName, grok-4.5 for ananda) and real Pinecone retrieval.
 * Does not start Next and does not call Vercel.
 *
 * Usage (from web/):
 *   npx tsx scripts/live-retrieval-answer-proof.ts
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import type { Index, RecordMetadata } from "@pinecone-database/pinecone";
import { loadSiteConfigSync } from "../src/utils/server/loadSiteConfig";
import { getCachedPineconeIndex } from "../src/utils/server/pinecone-client";
import { getPineconeIndexName } from "../src/utils/server/pinecone-config";
import { setupAndExecuteLanguageModelChain } from "../src/utils/server/makechain";
import { determineActiveMediaTypes } from "../src/utils/determineActiveMediaTypes";
import { buildPineconeAccessFilterClauses } from "../src/utils/server/accessLevelUtils";
import {
  isIncompleteRetrievalAnswer,
  RETRIEVAL_FETCH_FAILED_USER_MESSAGE,
  RETRIEVAL_INCOMPLETE_AFTER_FETCH_USER_MESSAGE,
  RETRIEVAL_ROUND_LIMIT_USER_MESSAGE,
} from "../src/utils/server/tools/retrievalTools";
import type { StreamingResponseData } from "../src/types/StreamingResponseData";

const REQUIRED_ENV = [
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "PINECONE_API_KEY",
  "PINECONE_INDEX_NAME",
  "SITE_ID",
  "OPENAI_EMBEDDINGS_MODEL",
] as const;

type ProofEvent = {
  kind: "status" | "token" | "sources" | "done" | "error" | "other";
  preview: string;
};

type ProofRow = {
  id: string;
  question: string;
  pass: boolean;
  failReason: string | null;
  model: string;
  fetchedMore: boolean;
  last300: string;
  eventCount: number;
};

function envPresence(): { missing: string[]; present: string[] } {
  const missing: string[] = [];
  const present: string[] = [];
  for (const key of REQUIRED_ENV) {
    if (process.env[key] && String(process.env[key]).trim()) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }
  return { missing, present };
}

function isClearFailureNote(text: string): boolean {
  return (
    text === RETRIEVAL_FETCH_FAILED_USER_MESSAGE ||
    text === RETRIEVAL_ROUND_LIMIT_USER_MESSAGE ||
    text === RETRIEVAL_INCOMPLETE_AFTER_FETCH_USER_MESSAGE
  );
}

function eventPreview(data: StreamingResponseData): ProofEvent {
  if (data.status) {
    return { kind: "status", preview: String(data.status) };
  }
  if (data.token) {
    const token = data.token;
    return { kind: "token", preview: token.length > 80 ? `${token.slice(0, 80)}…` : token };
  }
  if (data.sourceDocs) {
    return { kind: "sources", preview: `sourceDocs=${data.sourceDocs.length}` };
  }
  if (data.done) {
    return { kind: "done", preview: "done" };
  }
  if (data.error) {
    return { kind: "error", preview: String(data.error) };
  }
  return { kind: "other", preview: Object.keys(data).join(",") };
}

async function runOneQuestion(
  question: string,
  siteConfig: NonNullable<ReturnType<typeof loadSiteConfigSync>>
): Promise<{ row: Omit<ProofRow, "id">; events: ProofEvent[]; rawTail: StreamingResponseData[] }> {
  const indexName = getPineconeIndexName() || "";
  const index = (await getCachedPineconeIndex(indexName)) as Index<RecordMetadata>;
  const activeTypes = determineActiveMediaTypes({ text: true }, siteConfig.enabledMediaTypes);
  const filter = {
    $and: [{ type: { $in: activeTypes } }, ...buildPineconeAccessFilterClauses(200, siteConfig)],
  };
  const vectorStore = await PineconeStore.fromExistingIndex(
    new OpenAIEmbeddings({
      model: process.env.OPENAI_EMBEDDINGS_MODEL,
    }),
    { pineconeIndex: index, textKey: "text" }
  );
  const retriever = vectorStore.asRetriever({
    k: 4,
    filter,
  });

  const events: ProofEvent[] = [];
  const rawEvents: StreamingResponseData[] = [];
  let streamed = "";
  let fetchedMore = false;

  const sendData = (data: StreamingResponseData) => {
    rawEvents.push(data);
    events.push(eventPreview(data));
    if (data.status === "retrieving_more_sources") {
      fetchedMore = true;
      streamed = "";
    }
    if (data.token) {
      streamed += data.token;
    }
  };

  const result = await setupAndExecuteLanguageModelChain(
    retriever,
    question,
    [],
    sendData,
    4,
    filter,
    siteConfig,
    Date.now(),
    true,
    undefined,
    {},
    siteConfig.modelName,
    undefined,
    "whole_library",
    undefined,
    200,
    "live-retrieval-proof"
  );

  const answer = (result.fullResponse || streamed).trim();
  const last300 = answer.slice(-300);
  const endsOnFetchingMore = isIncompleteRetrievalAnswer(answer) && !isClearFailureNote(answer);
  const pass = answer.length > 0 && !endsOnFetchingMore;
  const failReason = !answer
    ? "empty answer"
    : endsOnFetchingMore
      ? "ended on interim fetching-more narration"
      : null;

  return {
    row: {
      question,
      pass,
      failReason,
      model: result.model || siteConfig.modelName || "unknown",
      fetchedMore,
      last300,
      eventCount: events.length,
    },
    events,
    rawTail: rawEvents.slice(-8),
  };
}

async function preflightExternalKeys(): Promise<string[]> {
  const rejected: string[] = [];
  const xaiKey = process.env.XAI_API_KEY || "";
  try {
    const xaiResponse = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${xaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "Reply with the single word ok." }],
        max_tokens: 8,
      }),
    });
    if (!xaiResponse.ok) {
      rejected.push("XAI_API_KEY");
    }
  } catch {
    rejected.push("XAI_API_KEY");
  }

  const pineconeKey = process.env.PINECONE_API_KEY || "";
  try {
    const pineconeResponse = await fetch("https://api.pinecone.io/indexes", {
      headers: {
        "Api-Key": pineconeKey,
        "X-Pinecone-API-Version": "2025-04",
      },
    });
    if (!pineconeResponse.ok) {
      rejected.push("PINECONE_API_KEY");
    }
  } catch {
    rejected.push("PINECONE_API_KEY");
  }

  return rejected;
}

async function main() {
  const presence = envPresence();
  if (presence.missing.length > 0) {
    console.error(
      `Live proof skipped. Missing env vars: ${presence.missing.join(", ")}. Present: ${presence.present.join(", ")}.`
    );
    process.exit(2);
  }

  const rejectedKeys = await preflightExternalKeys();
  if (rejectedKeys.length > 0) {
    const artifactDir = "/opt/cursor/artifacts";
    await mkdir(artifactDir, { recursive: true });
    const blocked = {
      generatedAt: new Date().toISOString(),
      siteId: process.env.SITE_ID,
      modelName: "grok-4.5",
      presentEnv: presence.present,
      rejectedEnv: rejectedKeys,
      summary: {
        passed: 0,
        failed: 10,
        blocked: true,
        reason:
          "Required env var names are present, but the live providers rejected the keys. Real grok-4.5 retrieval runs cannot start.",
      },
      rows: [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `stories-${index + 1}`,
          question: "Give me some stories from Autobiography of a Yogi",
          pass: false,
          failReason: `blocked: rejected ${rejectedKeys.join(", ")}`,
          model: "grok-4.5",
          fetchedMore: false,
          last300: "",
          eventCount: 0,
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `chapters-${index + 1}`,
          question: "List all the chapters of Autobiography of a Yogi",
          pass: false,
          failReason: `blocked: rejected ${rejectedKeys.join(", ")}`,
          model: "grok-4.5",
          fetchedMore: false,
          last300: "",
          eventCount: 0,
        })),
      ],
    };
    await writeFile(
      path.join(artifactDir, "live-retrieval-answer-proof.json"),
      JSON.stringify(blocked, null, 2),
      "utf8"
    );
    const table = [
      "| id | result | fetched more | last 300 chars |",
      "| --- | --- | --- | --- |",
      ...blocked.rows.map(
        (row) => `| ${row.id} | BLOCKED (${row.failReason}) | false | |`
      ),
    ].join("\n");
    await writeFile(
      path.join(artifactDir, "live-retrieval-answer-proof.md"),
      `# Live retrieval answer proof\n\nBlocked. Present env names: ${presence.present.join(", ")}.\nRejected keys: ${rejectedKeys.join(", ")}.\n\n${table}\n`,
      "utf8"
    );
    console.error(
      `Live proof blocked. Present env names: ${presence.present.join(", ")}. Rejected by provider: ${rejectedKeys.join(", ")}.`
    );
    process.exit(2);
  }

  const siteConfig = loadSiteConfigSync();
  if (!siteConfig) {
    console.error("Live proof skipped. loadSiteConfigSync returned null.");
    process.exit(2);
  }

  const stories = "Give me some stories from Autobiography of a Yogi";
  const chapters = "List all the chapters of Autobiography of a Yogi";
  const perQuestion = Math.max(1, Number.parseInt(process.env.LIVE_PROOF_PER_QUESTION || "5", 10));
  const questions: Array<{ id: string; question: string }> = [];
  for (let i = 1; i <= perQuestion; i += 1) {
    questions.push({ id: `stories-${i}`, question: stories });
  }
  for (let i = 1; i <= perQuestion; i += 1) {
    questions.push({ id: `chapters-${i}`, question: chapters });
  }

  const rows: ProofRow[] = [];
  let sampleRawTail: StreamingResponseData[] = [];
  let sampleEvents: ProofEvent[] = [];
  let sampleId = "";

  for (const item of questions) {
    console.log(`Running ${item.id}...`);
    try {
      const { row, events, rawTail } = await runOneQuestion(item.question, siteConfig);
      rows.push({ id: item.id, ...row });
      if (!sampleId) {
        sampleId = item.id;
        sampleEvents = events;
        sampleRawTail = rawTail;
      }
      console.log(`${item.id}: ${row.pass ? "PASS" : "FAIL"} model=${row.model} fetchedMore=${row.fetchedMore}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      rows.push({
        id: item.id,
        question: item.question,
        pass: false,
        failReason: `handler error: ${message}`,
        model: siteConfig.modelName || "unknown",
        fetchedMore: false,
        last300: "",
        eventCount: 0,
      });
      console.log(`${item.id}: FAIL handler error`);
    }
  }

  const artifactDir = "/opt/cursor/artifacts";
  await mkdir(artifactDir, { recursive: true });
  const artifact = {
    generatedAt: new Date().toISOString(),
    siteId: process.env.SITE_ID,
    modelName: siteConfig.modelName,
    presentEnv: presence.present,
    summary: {
      passed: rows.filter((row) => row.pass).length,
      failed: rows.filter((row) => !row.pass).length,
    },
    rows,
    sampleStream: {
      id: sampleId,
      events: sampleEvents,
      rawTail: sampleRawTail.map((event) => {
        const copy: Record<string, unknown> = { ...event };
        if (Array.isArray(event.sourceDocs)) {
          copy.sourceDocs = `[${event.sourceDocs.length} docs omitted]`;
        }
        return copy;
      }),
    },
  };

  const artifactPath = path.join(artifactDir, "live-retrieval-answer-proof.json");
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");

  const tableLines = [
    "| id | result | fetched more | last 300 chars |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => {
      const last = row.last300.replace(/\|/g, "\\|").replace(/\n/g, " ");
      return `| ${row.id} | ${row.pass ? "PASS" : `FAIL (${row.failReason})`} | ${row.fetchedMore} | ${last} |`;
    }),
  ];
  const mdPath = path.join(artifactDir, "live-retrieval-answer-proof.md");
  await writeFile(
    mdPath,
    `# Live retrieval answer proof\n\nModel: ${siteConfig.modelName}\n\n${tableLines.join("\n")}\n`,
    "utf8"
  );

  console.log(`Wrote ${artifactPath}`);
  console.log(`Wrote ${mdPath}`);
  if (rows.some((row) => !row.pass)) {
    process.exit(1);
  }
}

const isDirect = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error("Live proof failed to start.");
    console.error(error instanceof Error ? error.message : "unknown error");
    process.exit(1);
  });
}
