/**
 * @jest-environment node
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "../../scripts/check-ses-outbound-guard.mjs");

function runGuard(webRoot: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, WEB_ROOT: webRoot },
  });
}

function writeFile(root: string, relativePath: string, contents: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

describe("check-ses-outbound-guard.mjs", () => {
  it("passes when only outbound.ts mentions SES send APIs", () => {
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ses-guard-pass-"));
    writeFile(
      webRoot,
      "src/utils/server/outbound.ts",
      `import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";\n`
    );
    writeFile(webRoot, "src/utils/server/emailOps.ts", `export async function sendOpsAlert() { return true; }\n`);

    const result = runGuard(webRoot);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("SES outbound guard passed");
  });

  it("fails when another web/src file sends through SES", () => {
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ses-guard-fail-"));
    writeFile(
      webRoot,
      "src/utils/server/outbound.ts",
      `import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";\n`
    );
    writeFile(
      webRoot,
      "src/pages/api/contact.ts",
      `import { SendEmailCommand } from "@aws-sdk/client-ses";\n`
    );

    const result = runGuard(webRoot);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("src/pages/api/contact.ts: SendEmailCommand");
  });

  it("passes against this repository checkout", () => {
    const webRoot = path.resolve(__dirname, "../..");
    const result = runGuard(webRoot);
    expect(result.status).toBe(0);
  });
});
