import fs from "fs";
import path from "path";
import { VERCEL_CRON_PATHS, isVercelCronPath } from "../../../src/config/cronPaths";

describe("VERCEL_CRON_PATHS lockstep with vercel.json", () => {
  it("matches the cron paths in web/vercel.json exactly", () => {
    const vercelPath = path.join(process.cwd(), "vercel.json");
    const vercel = JSON.parse(fs.readFileSync(vercelPath, "utf8")) as {
      crons: Array<{ path: string }>;
    };
    const fromVercel = vercel.crons.map((cron) => cron.path);
    expect([...VERCEL_CRON_PATHS].sort()).toEqual([...fromVercel].sort());
  });

  it("matches only exact cron pathnames", () => {
    expect(isVercelCronPath("/api/cron/remindLucaS3Backup")).toBe(true);
    expect(isVercelCronPath("/api/chats")).toBe(false);
    expect(isVercelCronPath("/api/cron/remindLucaS3Backup/extra")).toBe(false);
  });
});
