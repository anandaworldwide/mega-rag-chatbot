import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import VoteStatsPage from "@/pages/admin/vote-stats";
import { SiteConfig } from "@/types/siteConfig";

jest.mock("next/head", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

jest.mock("@/components/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

import { fetchWithAuth } from "@/utils/client/tokenManager";

const siteConfig = { siteId: "ananda", name: "Test" } as SiteConfig;
const question = `What's (Kriya) | & ; $ <b>bold</b>`;

const payload = {
  siteId: "ananda",
  lookbackDays: 7,
  since: "2026-01-01T00:00:00.000Z",
  generatedAt: "2026-01-08T00:00:00.000Z",
  summary: {
    answersInWindow: 1,
    answersWithModel: 1,
    answersWithAbTestModel: 1,
    answersWithoutAbTestModel: 0,
    geoAnswers: 0,
    upvotes: 0,
    downvotes: 1,
    comparableVotes: 1,
    comparableUpvotes: 0,
    comparableDownvotes: 1,
    downvoteEventsInWindow: 1,
  },
  arms: [],
  modelCounts: [],
  recentVotes: [
    {
      id: "vote-1",
      vote: -1 as const,
      model: "gpt-4.1-mini",
      abTestModel: "gpt-4.1-mini",
      isLocationQuery: false,
      comparable: true,
      question,
      feedbackReason: null,
      feedbackComment: null,
      timestamp: "2026-01-07T00:00:00.000Z",
    },
  ],
  recentDownvoteEvents: [
    {
      id: "event-1",
      answerDocId: "vote-1",
      question,
      reason: null,
      comment: null,
      model: "gpt-4.1-mini",
      abTestModel: "gpt-4.1-mini",
      triageCategory: null,
      triageStatus: null,
      createdAt: "2026-01-07T00:00:00.000Z",
    },
  ],
};

describe("vote-stats question escape", () => {
  it("renders saved punctuation as text and does not inject HTML", async () => {
    (fetchWithAuth as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const { container } = render(<VoteStatsPage siteConfig={siteConfig} />);

    await waitFor(() => {
      expect(screen.getAllByText(question).length).toBeGreaterThan(0);
    });

    const questionCells = screen.getAllByText(question);
    expect(questionCells.length).toBeGreaterThan(0);
    questionCells.forEach((cell) => {
      expect(cell.innerHTML).toContain("&amp;");
      expect(cell.innerHTML).toContain("&lt;b&gt;");
      expect(cell.querySelector("b")).toBeNull();
    });
    expect(container.querySelectorAll("td b")).toHaveLength(0);
  });
});
