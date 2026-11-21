/** @jest-environment node */
/**
 * Adversarial site isolation tests for ananda, ananda-public, crystal, and jairam.
 *
 * Site selection is env SITE_ID plus an optional explicit argument to loadSiteConfigSync.
 * These tests prove headers, host, query-like env vars, and spoofed ids cannot leak
 * another site's config, flags, prompt file, Pinecone index name, or cached state.
 */

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({
    send: jest.fn(async () => {
      throw new Error("Real network call attempted: S3");
    }),
  })),
  GetObjectCommand: jest.fn(),
}));

jest.mock("openai", () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn(async () => {
        throw new Error("Real network call attempted: OpenAI embeddings");
      }),
    },
  })),
}));

const mockPineconeIndex = jest.fn((indexName: string) => ({ indexName }));
jest.mock("@pinecone-database/pinecone", () => ({
  Pinecone: jest.fn().mockImplementation(() => ({
    Index: mockPineconeIndex,
  })),
}));

jest.mock("@/utils/server/loadEnv.js", () => ({
  loadEnv: jest.fn(),
}));

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { loadSiteConfig, loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getPineconeIndexName } from "@/utils/server/pinecone-config";
import { PineconeClientService } from "@/utils/server/pinecone-client";
import { handleCors } from "@/utils/server/corsMiddleware";
import { buildChatRequestLockKey } from "@/utils/server/chatRequestIdempotency";
import {
  clearTitleCatalogCache,
  getTitleCatalogLookup,
} from "@/utils/server/titleCatalog";
import {
  getCachedSiteId,
  initializeLocationIntentDetector,
} from "@/utils/server/locationIntentDetector";
import type { SiteConfig } from "@/types/siteConfig";

const SITES = ["ananda", "ananda-public", "crystal", "jairam"] as const;
type SiteId = (typeof SITES)[number];

const PRODUCTION_HOST: Record<SiteId, string> = {
  ananda: "luca.ananda.org",
  "ananda-public": "vivek.ananda.org",
  crystal: "chat.crystalclarity.com",
  jairam: "chat.freejoehunt.com",
};

const HOSTILE_SITE_IDS = [
  " ",
  "unknown",
  "ANANDA",
  "ananda ",
  " ananda",
  "ananda\n",
  "../crystal",
  "ananda/../crystal",
  "..",
  "ananda\0crystal",
  "ananda;crystal",
  "ananda%00",
  "ananda%2e%2e",
  "ananda' OR '1'='1",
  "<script>ananda</script>",
  "ananda\u202e",
  "../../etc/passwd",
  "site-config/prompts/crystal",
];

function fingerprint(config: SiteConfig) {
  return {
    siteId: config.siteId,
    name: config.name,
    shortname: config.shortname,
    requireLogin: config.requireLogin === true,
    enableTitleScopeSelection: config.enableTitleScopeSelection === true,
    enableAuthorSelection: config.enableAuthorSelection === true,
    enableMediaTypeSelection: config.enableMediaTypeSelection === true,
    enableGeoAwareness: config.enableGeoAwareness === true,
    enableRetrievalTools: config.enableRetrievalTools === true,
    enableAnswerFeedbackPrompt: config.enableAnswerFeedbackPrompt === true,
    hideSources: config.hideSources === true,
    modelName: config.modelName ?? null,
    queriesPerUserPerDay: config.queriesPerUserPerDay,
    includedLibraries: JSON.stringify(config.includedLibraries ?? null),
    collectionKeys: Object.keys(config.collectionConfig || {})
      .sort()
      .join(","),
    allowedFrontEndDomains: [...(config.allowedFrontEndDomains || [])].sort().join(","),
    promptTemplateFile: readPromptTemplateFile(config.siteId),
  };
}

function readPromptTemplateFile(siteId: string): string {
  const promptsDir = path.join(process.cwd(), "site-config", "prompts");
  const raw = fs.readFileSync(path.join(promptsDir, `${siteId}.json`), "utf8");
  const parsed = JSON.parse(raw) as { templates?: { baseTemplate?: { file?: string } } };
  return parsed.templates?.baseTemplate?.file || "";
}

function writeSyntheticCatalog(root: string, siteId: string, marker: string): void {
  const dir = path.join(root, siteId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ lookupKey: "lookup.json", expansionsKey: "expansions.json" })
  );
  fs.writeFileSync(
    path.join(dir, "lookup.json"),
    JSON.stringify({
      entries: [
        {
          canonicalPrefix: marker,
          normalizedPrefix: marker.toLowerCase(),
          normalizedSearchText: marker.toLowerCase(),
          depth: 1,
          fullTitleCount: 1,
          vectorCount: 1,
          availability: {
            libraries: ["synthetic-lib"],
            mediaTypes: ["text"],
            collectionsWithVectors: ["whole_library"],
          },
        },
      ],
    })
  );
  fs.writeFileSync(path.join(dir, "expansions.json"), JSON.stringify({ expansions: { [marker]: [marker] } }));
}

describe("site isolation adversarial sweep", () => {
  const originalEnv = process.env;
  let reportsRoot: string;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.S3_BUCKET_NAME;
    delete process.env.OPENAI_API_KEY;
    reportsRoot = path.join(process.cwd(), ".cache", "title_prefix_catalog", "reports");
    clearTitleCatalogCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    clearTitleCatalogCache();
    jest.restoreAllMocks();
  });

  describe("SITE_ID env selection", () => {
    it.each(SITES)("loads %s from SITE_ID and not another site", (site) => {
      process.env.SITE_ID = site;
      const config = loadSiteConfigSync();
      expect(config).not.toBeNull();
      expect(config?.siteId).toBe(site);
      expect(config?.name).toBeTruthy();
      for (const other of SITES.filter((item) => item !== site)) {
        expect(config?.siteId).not.toBe(other);
        expect(config?.name).not.toBe(loadSiteConfigSync(other)?.name);
      }
    });

    it("switches SITE_ID between sequential calls with no leftover singleton", () => {
      process.env.SITE_ID = "ananda";
      expect(loadSiteConfigSync()?.siteId).toBe("ananda");
      process.env.SITE_ID = "crystal";
      expect(loadSiteConfigSync()?.siteId).toBe("crystal");
      process.env.SITE_ID = "jairam";
      expect(loadSiteConfigSync()?.siteId).toBe("jairam");
      process.env.SITE_ID = "ananda-public";
      expect(loadSiteConfigSync()?.siteId).toBe("ananda-public");
    });

    it("async loader follows the same SITE_ID selection", async () => {
      process.env.SITE_ID = "jairam";
      const config = await loadSiteConfig();
      expect(config?.siteId).toBe("jairam");
      expect(config?.requireLogin).toBe(true);
    });
  });

  describe("spoofed env, host, and query-like values", () => {
    it.each([
      ["SITE", "crystal"],
      ["NEXT_PUBLIC_SITE", "crystal"],
      ["NEXT_PUBLIC_SITE_ID", "jairam"],
      ["HTTP_HOST", "chat.crystalclarity.com"],
      ["HOST", "vivek.ananda.org"],
      ["VERCEL_URL", "crystal-chatbot.vercel.app"],
      ["QUERY_STRING", "site=crystal"],
      ["REQUEST_URI", "/api/chat/v1?siteId=jairam"],
    ])("ignores %s=%s when SITE_ID is ananda", (key, value) => {
      process.env.SITE_ID = "ananda";
      process.env[key] = value;
      const config = loadSiteConfigSync();
      expect(config?.siteId).toBe("ananda");
      expect(config?.shortname).toBe("Luca");
    });

    it("explicit siteId argument does not keep the previous SITE_ID config", () => {
      process.env.SITE_ID = "ananda";
      const fromArg = loadSiteConfigSync("crystal");
      expect(fromArg?.siteId).toBe("crystal");
      expect(fromArg?.shortname).toBe("Library Magic");
      expect(loadSiteConfigSync()?.siteId).toBe("ananda");
    });
  });

  describe("unknown and hostile site ids", () => {
    it.each(HOSTILE_SITE_IDS)("returns null for %j and does not yield another site", (siteId) => {
      process.env.SITE_ID = "ananda";
      const config = loadSiteConfigSync(siteId);
      expect(config).toBeNull();
    });

    it("unknown SITE_ID does not fall back to ananda", () => {
      process.env.SITE_ID = "not-a-real-site";
      expect(loadSiteConfigSync()).toBeNull();
    });

    it("treats an empty siteId argument as SITE_ID", () => {
      process.env.SITE_ID = "crystal";
      expect(loadSiteConfigSync("")?.siteId).toBe("crystal");
    });
  });

  describe("config, flags, prompts, and CORS domains", () => {
    it("keeps a unique fingerprint per site", () => {
      const fingerprints = SITES.map((site) => fingerprint(loadSiteConfigSync(site) as SiteConfig));
      const serialized = fingerprints.map((item) => JSON.stringify(item));
      expect(new Set(serialized).size).toBe(SITES.length);
      expect(new Set(fingerprints.map((item) => item.promptTemplateFile)).size).toBe(SITES.length);
    });

    it.each([
      ["ananda", "requireLogin", true],
      ["ananda-public", "requireLogin", false],
      ["crystal", "requireLogin", false],
      ["jairam", "requireLogin", true],
      ["ananda", "enableTitleScopeSelection", true],
      ["ananda-public", "enableTitleScopeSelection", false],
      ["crystal", "enableTitleScopeSelection", false],
      ["jairam", "enableTitleScopeSelection", false],
      ["ananda", "enableAuthorSelection", true],
      ["ananda-public", "enableAuthorSelection", false],
      ["ananda-public", "hideSources", true],
      ["ananda", "hideSources", false],
      ["ananda", "enableGeoAwareness", true],
      ["crystal", "enableGeoAwareness", false],
      ["jairam", "enableGeoAwareness", false],
    ] as const)("%s has %s=%s", (site, flag, expected) => {
      const config = loadSiteConfigSync(site) as SiteConfig;
      const value = (config as unknown as Record<string, unknown>)[flag] === true;
      expect(value).toBe(expected);
    });

    it.each(SITES)("allows the %s production host on that site only", (site) => {
      process.env.SITE_ID = site;
      const config = loadSiteConfigSync() as SiteConfig;
      const ownReq = new NextRequest("https://example.com/api/chat/v1", {
        method: "POST",
        headers: { origin: `https://${PRODUCTION_HOST[site]}` },
      });
      expect(handleCors(ownReq, config)).toBeNull();

      for (const other of SITES.filter((item) => item !== site)) {
        if (site === "ananda-public" && other === "ananda") {
          continue;
        }
        const otherReq = new NextRequest("https://example.com/api/chat/v1", {
          method: "POST",
          headers: { origin: `https://${PRODUCTION_HOST[other]}` },
        });
        const blocked = handleCors(otherReq, config);
        expect(blocked).not.toBeNull();
        expect(blocked?.status).toBe(403);
      }
    });

    it.failing(
      "TODO(bug): ananda-public CORS suffix match allows luca.ananda.org (web/src/utils/server/corsMiddleware.ts isAllowedOrigin). Input origin=https://luca.ananda.org while SITE_ID=ananda-public. Impact: Luca origin is allowed on Vivek CORS.",
      () => {
        const config = loadSiteConfigSync("ananda-public") as SiteConfig;
        const req = new NextRequest("https://example.com/api/chat/v1", {
          method: "POST",
          headers: { origin: "https://luca.ananda.org" },
        });
        const blocked = handleCors(req, config);
        expect(blocked?.status).toBe(403);
      }
    );
  });

  describe("Pinecone index selection", () => {
    it.each(SITES)("reads PINECONE_INDEX_NAME for %s and ignores SITE_ID as the index name", (site) => {
      process.env.SITE_ID = site;
      process.env.PINECONE_INDEX_NAME = "synthetic-shared-index";
      expect(getPineconeIndexName()).toBe("synthetic-shared-index");
      process.env.PINECONE_INDEX_NAME = `${site}-synthetic-index`;
      expect(getPineconeIndexName()).toBe(`${site}-synthetic-index`);
    });

    it("does not let a later index name reuse an earlier cached client index", async () => {
      const service = new PineconeClientService({
        getPineconeApiKey: () => "12345678-1234-1234-1234-123456789012",
      });
      const first = await service.getIndex("ananda-synthetic-index");
      const second = await service.getIndex("crystal-synthetic-index");
      expect(first).not.toBe(second);
      expect(mockPineconeIndex).toHaveBeenCalledWith("ananda-synthetic-index");
      expect(mockPineconeIndex).toHaveBeenCalledWith("crystal-synthetic-index");
      const firstAgain = await service.getIndex("ananda-synthetic-index");
      expect(firstAgain).toBe(first);
      service.clearCache();
    });
  });

  describe("prompt templates", () => {
    it("maps each site to a distinct local prompt file name", () => {
      const files = SITES.map((site) => ({ site, file: readPromptTemplateFile(site) }));
      expect(files).toEqual([
        { site: "ananda", file: "ananda-base.txt" },
        { site: "ananda-public", file: "ananda-public-base.txt" },
        { site: "crystal", file: "crystal-prompt.txt" },
        { site: "jairam", file: "jairam-base.txt" },
      ]);
      for (const row of files) {
        expect(fs.existsSync(path.join(process.cwd(), "site-config", "prompts", row.file))).toBe(true);
      }
    });
  });

  describe("cached title catalog and location-intent state", () => {
    it("keeps title catalog lookups isolated by siteId", async () => {
      writeSyntheticCatalog(reportsRoot, "ananda", "SYNTH-ANANDA-TITLE");
      writeSyntheticCatalog(reportsRoot, "crystal", "SYNTH-CRYSTAL-TITLE");
      const ananda = await getTitleCatalogLookup("ananda");
      const crystal = await getTitleCatalogLookup("crystal");
      expect(ananda.entries[0].canonicalPrefix).toBe("SYNTH-ANANDA-TITLE");
      expect(crystal.entries[0].canonicalPrefix).toBe("SYNTH-CRYSTAL-TITLE");
      const anandaAgain = await getTitleCatalogLookup("ananda");
      expect(anandaAgain.entries[0].canonicalPrefix).toBe("SYNTH-ANANDA-TITLE");
    });

    it.failing(
      "TODO(bug): title catalog siteId path is not sanitized (web/src/utils/server/titleCatalog.ts readJsonFromLocalOrS3). Input siteId='../ananda-canary'. Impact: a hostile siteId can read a catalog outside the per-site reports directory.",
      async () => {
        const canaryRoot = path.join(process.cwd(), ".cache", "title_prefix_catalog");
        writeSyntheticCatalog(canaryRoot, "ananda-canary", "SYNTH-TRAVERSAL-CANARY");
        await expect(getTitleCatalogLookup("../ananda-canary")).rejects.toThrow();
      }
    );

    it("reloads location-intent embeddings when the siteId changes", async () => {
      process.env.OPENAI_API_KEY = "synthetic-test-key-not-a-secret";
      const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
      await initializeLocationIntentDetector("ananda");
      expect(getCachedSiteId()).toBe("ananda");
      await initializeLocationIntentDetector("ananda-public");
      expect(getCachedSiteId()).toBe("ananda-public");
      const paths = existsSpy.mock.calls.map((call) => String(call[0]));
      expect(paths.some((item) => item.includes("ananda-embeddings.json"))).toBe(true);
      expect(paths.some((item) => item.includes("ananda-public-embeddings.json"))).toBe(true);
    });
  });

  describe("chat request lock keys", () => {
    it("does not collide across sites for the same client request id", () => {
      const requestId = "423e4567-e89b-42d3-a456-426614174000";
      const keys = SITES.map((site) => buildChatRequestLockKey(site, requestId));
      expect(new Set(keys).size).toBe(SITES.length);
    });
  });
});
