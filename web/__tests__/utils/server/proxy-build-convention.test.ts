/**
 * Fail if the Next 16 request interceptor is not where the build can load it.
 *
 * @jest-environment node
 */

import fs from "fs";
import path from "path";
import { isMiddlewareFile, isProxyFile } from "next/dist/build/utils.js";
import { proxy } from "../../../src/proxy";

const WEB_ROOT = path.resolve(__dirname, "../../..");

describe("Next 16 proxy build convention", () => {
  it("places proxy.ts next to app/ and pages/ and exports proxy", () => {
    const proxyPath = path.join(WEB_ROOT, "src/proxy.ts");
    const staleRootMiddleware = path.join(WEB_ROOT, "middleware.ts");
    expect(fs.existsSync(proxyPath)).toBe(true);
    expect(fs.existsSync(staleRootMiddleware)).toBe(false);
    expect(fs.readdirSync(path.join(WEB_ROOT, "src"))).toEqual(expect.arrayContaining(["proxy.ts"]));
    expect(typeof proxy).toBe("function");
    expect(isProxyFile("/src/proxy")).toBe(true);
    expect(isMiddlewareFile("/src/proxy")).toBe(true);
    expect(isProxyFile("/proxy")).toBe(true);
    expect(isMiddlewareFile("/middleware")).toBe(true);
  });
});
