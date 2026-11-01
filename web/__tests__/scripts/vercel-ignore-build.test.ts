/**
 * @jest-environment node
 */

import { spawnSync } from "child_process";
import path from "path";

const SCRIPT = path.resolve(__dirname, "../../scripts/vercel-ignore-build.mjs");

const OTHER_SITES = [
  { siteId: "crystal", projectName: "crystal-chatbot" },
  { siteId: "jairam", projectName: "jairam-chatbot" },
  { siteId: "ananda-public", projectName: "ananda-public-chatbot" },
] as const;

function runIgnore(env: Record<string, string | undefined>) {
  const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      cleanEnv[key] = value;
    }
  }
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: cleanEnv,
  });
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

describe("vercel-ignore-build.mjs", () => {
  it("builds preview for ananda-chatbot when SITE_ID is ananda", () => {
    const result = runIgnore({
      VERCEL_ENV: "preview",
      SITE_ID: "ananda",
    });
    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain("Continuing Vercel build");
  });

  it("builds preview for ananda-chatbot when VERCEL_PROJECT_NAME is ananda-chatbot", () => {
    const result = runIgnore({
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_NAME: "ananda-chatbot",
    });
    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain("Continuing Vercel build");
  });

  it.each(OTHER_SITES)(
    "skips preview for $projectName when SITE_ID is $siteId",
    ({ siteId, projectName }) => {
      const result = runIgnore({
        VERCEL_ENV: "preview",
        SITE_ID: siteId,
        VERCEL_PROJECT_NAME: projectName,
      });
      expect(result.status).toBe(0);
      expect(combinedOutput(result)).toContain("Skipping Vercel build");
    }
  );

  it.each(OTHER_SITES)("skips preview for $projectName by project name only", ({ projectName }) => {
    const result = runIgnore({
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_NAME: projectName,
    });
    expect(result.status).toBe(0);
    expect(combinedOutput(result)).toContain("Skipping Vercel build");
  });

  it.each(["ananda", "crystal", "jairam", "ananda-public"] as const)(
    "builds production for SITE_ID=%s",
    (siteId) => {
      const result = runIgnore({
        VERCEL_ENV: "production",
        SITE_ID: siteId,
      });
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain("Continuing Vercel build");
    }
  );

  it.each(["ananda-chatbot", "crystal-chatbot", "jairam-chatbot", "ananda-public-chatbot"] as const)(
    "builds production for VERCEL_PROJECT_NAME=%s",
    (projectName) => {
      const result = runIgnore({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_NAME: projectName,
      });
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain("Continuing Vercel build");
    }
  );

  it("skips non-production development builds that are not ananda-chatbot", () => {
    const result = runIgnore({
      VERCEL_ENV: "development",
      SITE_ID: "crystal",
    });
    expect(result.status).toBe(0);
    expect(combinedOutput(result)).toContain("Skipping Vercel build");
  });
});
