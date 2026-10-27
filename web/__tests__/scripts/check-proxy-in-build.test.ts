/**
 * @jest-environment node
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "../../scripts/check-proxy-in-build.mjs");
const FIX_LINE = "Fix: keep the interceptor in web/src/proxy.ts and export function proxy.";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function makeFixture(options: { hasNodeProxy: boolean }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-check-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "proxy.ts"), "export function proxy() {}\n");
  writeJson(path.join(root, ".next", "server", "middleware-manifest.json"), {
    middleware: {},
  });
  const functions = options.hasNodeProxy
    ? { functions: { "/_middleware": { runtime: "nodejs" } } }
    : { functions: {} };
  writeJson(path.join(root, ".next", "server", "functions-config-manifest.json"), functions);
  return root;
}

function runCheck(webRoot: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, WEB_ROOT: webRoot },
  });
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

describe("check-proxy-in-build.mjs", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const root of fixtures.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when functions-config-manifest.json has no /_middleware key", () => {
    const root = makeFixture({ hasNodeProxy: false });
    fixtures.push(root);
    const checkedFile = path.join(root, ".next", "server", "functions-config-manifest.json");
    const result = runCheck(root);
    const output = combinedOutput(result);

    expect(result.status).not.toBe(0);
    expect(output).toContain(`Checked file: ${checkedFile}`);
    expect(output).toContain(FIX_LINE);
  });

  it("passes when functions-config-manifest.json has a /_middleware key", () => {
    const root = makeFixture({ hasNodeProxy: true });
    fixtures.push(root);
    const checkedFile = path.join(root, ".next", "server", "functions-config-manifest.json");
    const result = runCheck(root);
    const output = combinedOutput(result);

    expect(result.status).toBe(0);
    expect(output).toContain(`Checked file: ${checkedFile}`);
    expect(output).toContain("Proxy build check passed: Node proxy (/_middleware) is part of the Next.js build.");
  });
});
