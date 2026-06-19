/** @jest-environment node */

import jwt from "jsonwebtoken";
import {
  generateUnsubscribeToken,
  generateSignedOpenToken,
  verifyOpenToken,
  generateSignedClickToken,
  verifyClickToken,
} from "@/utils/server/emailTokenUtils";

const ORIGINAL_SECRET = process.env.SECURE_TOKEN;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.SECURE_TOKEN;
  } else {
    process.env.SECURE_TOKEN = ORIGINAL_SECRET;
  }
});

describe("generateUnsubscribeToken", () => {
  it("signs a verifiable JWT with lowercased email", () => {
    process.env.SECURE_TOKEN = "test-secret";
    const token = generateUnsubscribeToken("User@Example.com", "newsletters");
    const decoded = jwt.verify(token, "test-secret") as Record<string, unknown>;
    expect(decoded.email).toBe("user@example.com");
    expect(decoded.purpose).toBe("email_unsubscribe");
    expect(decoded.category).toBe("newsletters");
  });

  it("throws when SECURE_TOKEN is missing", () => {
    delete process.env.SECURE_TOKEN;
    expect(() => generateUnsubscribeToken("a@b.com", "newsletters")).toThrow("SECURE_TOKEN not configured");
  });
});

describe("open tracking tokens", () => {
  it("round-trips a signed open token as valid", () => {
    process.env.SECURE_TOKEN = "test-secret";
    const token = generateSignedOpenToken("User@Example.com", "newsletter", 42);
    const payload = verifyOpenToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.email).toBe("user@example.com");
    expect(payload?.campaignType).toBe("newsletter");
    expect(payload?.campaignId).toBe("42");
    expect(payload?.isValid).toBe(true);
  });

  it("marks tampered signatures as invalid", () => {
    process.env.SECURE_TOKEN = "test-secret";
    const token = generateSignedOpenToken("a@b.com", "newsletter", 1);
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const tampered = decoded.replace(/:[0-9a-f]{16}$/, ":0000000000000000");
    const payload = verifyOpenToken(Buffer.from(tampered).toString("base64"));
    expect(payload?.isValid).toBe(false);
  });

  it("accepts legacy unsigned tokens during transition", () => {
    delete process.env.SECURE_TOKEN;
    const legacy = generateSignedOpenToken("a@b.com", "newsletter", 1); // unsigned (4 parts)
    const payload = verifyOpenToken(legacy);
    expect(payload?.isValid).toBe(true);
  });

  it("returns isValid false when secret is missing but token is signed", () => {
    process.env.SECURE_TOKEN = "test-secret";
    const token = generateSignedOpenToken("a@b.com", "newsletter", 1);
    delete process.env.SECURE_TOKEN;
    const payload = verifyOpenToken(token);
    expect(payload?.isValid).toBe(false);
  });

  it("returns null for malformed tokens", () => {
    expect(verifyOpenToken(Buffer.from("only:two").toString("base64"))).toBeNull();
    expect(verifyOpenToken(Buffer.from("a::c:notanumber").toString("base64"))).toBeNull();
  });
});

describe("click tracking tokens", () => {
  it("round-trips a signed click token as valid", () => {
    process.env.SECURE_TOKEN = "test-secret";
    const token = generateSignedClickToken("User@Example.com", "newsletter", 7, "cta", "link-1");
    const payload = verifyClickToken(token);
    expect(payload?.email).toBe("user@example.com");
    expect(payload?.linkType).toBe("cta");
    expect(payload?.linkId).toBe("link-1");
    expect(payload?.isValid).toBe(true);
  });

  it("marks tampered click signatures as invalid", () => {
    process.env.SECURE_TOKEN = "test-secret";
    const token = generateSignedClickToken("a@b.com", "newsletter", 7, "cta");
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const tampered = decoded.replace(/:[0-9a-f]{16}$/, ":0000000000000000");
    const payload = verifyClickToken(Buffer.from(tampered).toString("base64"));
    expect(payload?.isValid).toBe(false);
  });

  it("accepts legacy unsigned click tokens", () => {
    delete process.env.SECURE_TOKEN;
    const legacy = generateSignedClickToken("a@b.com", "newsletter", 7, "cta", "link-1");
    const payload = verifyClickToken(legacy);
    expect(payload?.isValid).toBe(true);
  });

  it("returns null for non-click or malformed tokens", () => {
    expect(verifyClickToken(Buffer.from("open:a:b:c:d:e:1").toString("base64"))).toBeNull();
    expect(verifyClickToken(Buffer.from("click:too:few").toString("base64"))).toBeNull();
  });
});
