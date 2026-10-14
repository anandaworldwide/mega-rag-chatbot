import fs from "fs";
import path from "path";
import { nonceFromDocumentContext } from "@/pages/_document";
import AppDocument from "@/pages/_document";

describe("Document CSP nonce wiring", () => {
  it("reads the middleware nonce from incoming document headers", () => {
    expect(nonceFromDocumentContext({ req: { headers: { "x-nonce": "script-nonce" } } })).toBe("script-nonce");
    expect(nonceFromDocumentContext({ req: { headers: {} } })).toBeUndefined();
  });

  it("registers getInitialProps so NextScript can receive the nonce", () => {
    expect(typeof AppDocument.getInitialProps).toBe("function");
  });

  it("passes the nonce to Head and NextScript", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/pages/_document.tsx"), "utf8");
    expect(source).toContain("<Head nonce={nonce}>");
    expect(source).toContain("<NextScript nonce={nonce} />");
  });
});
