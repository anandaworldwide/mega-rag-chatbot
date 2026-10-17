/** @jest-environment node */

import { renderOnboardingEmail } from "@/utils/server/onboardingEmailUtils";
import { renderNpsSurveyEmail } from "@/utils/server/npsSurveyEmailUtils";
import { renderReengagementEmail } from "@/utils/server/reengagementEmailUtils";
import { renderSpecialDayEmail } from "@/utils/server/specialDayEmailUtils";
import { loadSiteConfig, loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { User } from "@/types/user";

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(),
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("@/utils/server/emailTrackingUtils", () => ({
  addUtmParams: jest.fn((url: string) => url),
  generateClickTrackingUrl: jest.fn((targetUrl: string) => targetUrl),
  generateOpenTrackingUrl: jest.fn(() => "https://test.example.com/open"),
}));

jest.mock("@/utils/server/emailTokenUtils", () => ({
  generateUnsubscribeToken: jest.fn(() => "unsub-token"),
}));

jest.mock("@/utils/server/npsSurveyTokenUtils", () => ({
  generateNpsSurveyToken: jest.fn((_email: string, score: number) => `tok-${score}`),
}));

jest.mock("@/services/firebase", () => ({
  db: {},
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "users"),
}));

jest.mock("@/utils/server/contentEmailTracker", () => ({
  updateLastContentEmailSent: jest.fn().mockResolvedValue(undefined),
}));

const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

const siteConfig = {
  siteId: "ananda",
  name: "Test Site",
  shortname: "TestSite",
  emailGreeting: "Hi there,",
};

const user: User = {
  id: "obrien@example.com",
  firstName: "O'Brien",
};

function expectSafeNameAndLink(html: string) {
  expect(html).toContain("<a href=");
  expect(html).not.toContain("&lt;a");
  expect(html).toContain("O&#039;Brien");
  expect(html).not.toContain("O&amp;#039;Brien");
}

describe("email callers through real generateEmailContent", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_BASE_URL: "https://test.example.com",
    };
    mockLoadSiteConfig.mockResolvedValue(siteConfig as any);
    mockLoadSiteConfigSync.mockReturnValue(siteConfig as any);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("onboarding keeps question links and escapes O'Brien once", async () => {
    const result = await renderOnboardingEmail(
      {
        day: 1,
        subject: "Welcome",
        greeting: "Hi {{firstName}},",
        body: "Hello {{firstName}}.\n{{exampleQuestions}}",
        exampleQuestions: ["What is Kriya?"],
        ctaUrl: "{{baseUrl}}",
        ctaText: "Start Exploring",
      },
      user,
      "ananda",
      "https://test.example.com"
    );

    expectSafeNameAndLink(result.html);
  });

  it("NPS keeps score links and escapes O'Brien once", async () => {
    const result = await renderNpsSurveyEmail(
      {
        subject: "How did we do?",
        greeting: "Hi {{firstName}},",
        body: "Please choose a score.",
      },
      user,
      "ananda",
      "https://test.example.com"
    );

    expectSafeNameAndLink(result.html);
  });

  it("re-engagement keeps prompt links and escapes O'Brien once", async () => {
    const result = await renderReengagementEmail(
      {
        campaignId: "we-miss-you",
        subject: "We miss you",
        greeting: "Hi {{firstName}},",
        leadIn: "Here are some questions.",
        prompts: {
          meditation: ["How do I meditate?"],
        },
        ctaCategories: ["meditation"],
        secondaryCta: {
          label: "Return home",
          url: "{{baseUrl}}",
        },
      },
      user,
      "ananda",
      "https://test.example.com"
    );

    expectSafeNameAndLink(result.html);
  });

  it("special-day keeps question links and escapes O'Brien once", async () => {
    const result = await renderSpecialDayEmail(
      {
        specialDayId: "masters-birthday",
        subject: "A special day",
        greeting: "Hi {{firstName}},",
        body: "Hello {{firstName}}.\n{{exampleQuestions}}",
        exampleQuestionPool: ["Who was Master?"],
        exampleQuestionCount: 1,
        ctaUrl: "{{baseUrl}}",
        ctaText: "Read more",
      },
      user,
      "ananda",
      "https://test.example.com",
      2026
    );

    expectSafeNameAndLink(result.html);
  });
});
