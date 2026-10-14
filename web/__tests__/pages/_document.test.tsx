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
});
