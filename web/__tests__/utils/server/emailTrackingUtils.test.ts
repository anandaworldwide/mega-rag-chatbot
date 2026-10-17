import { generateClickTrackingUrl, generateOpenTrackingUrl } from "@/utils/server/emailTrackingUtils";
import { generateClickRedirectSignature } from "@/utils/server/emailTokenUtils";

jest.mock("@/utils/server/emailTokenUtils", () => {
  const actual = jest.requireActual("@/utils/server/emailTokenUtils");
  return {
    ...actual,
    generateSignedOpenToken: jest.fn(() => "signed-token"),
  };
});

describe("emailTrackingUtils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, SECURE_TOKEN: "test-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("upgrades non-local HTTP tracking bases and redirect targets to HTTPS", () => {
    const trackingUrl = generateClickTrackingUrl(
      "http://luca.ananda.org/?q=test",
      "test@example.com",
      "specialDay",
      "sri-yukteswar-birthday-2026",
      "question",
      "Question",
      "http://luca.ananda.org"
    );

    const url = new URL(trackingUrl);
    expect(url.origin).toBe("https://luca.ananda.org");
    expect(url.searchParams.get("url")).toBe("https://luca.ananda.org/?q=test");
    expect(url.searchParams.get("sig")).toBe(
      generateClickRedirectSignature("test@example.com", "https://luca.ananda.org/?q=test")
    );
  });

  it("keeps localhost HTTP tracking URLs for development", () => {
    const trackingUrl = generateClickTrackingUrl(
      "http://localhost:3000/?q=test",
      "test@example.com",
      "specialDay",
      "test-campaign",
      "question",
      undefined,
      "http://localhost:3000"
    );

    const url = new URL(trackingUrl);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.searchParams.get("url")).toBe("http://localhost:3000/?q=test");
    expect(url.searchParams.get("sig")).toBe(
      generateClickRedirectSignature("test@example.com", "http://localhost:3000/?q=test")
    );
  });

  it("upgrades open tracking base URLs to HTTPS", () => {
    const trackingUrl = generateOpenTrackingUrl(
      "test@example.com",
      "specialDay",
      "sri-yukteswar-birthday-2026",
      "http://luca.ananda.org"
    );

    expect(new URL(trackingUrl).origin).toBe("https://luca.ananda.org");
  });
});
