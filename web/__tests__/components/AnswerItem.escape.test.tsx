import React from "react";
import { render, screen } from "@testing-library/react";
import AnswerItem from "@/components/AnswerItem";
import { Answer } from "@/types/answer";
import { SiteConfig } from "@/types/siteConfig";

jest.mock("@/hooks/useMultipleCollections", () => ({
  useMultipleCollections: () => false,
}));

jest.mock("@/components/TruncatedMarkdown", () => ({
  __esModule: true,
  default: () => <div data-testid="answer-body">answer</div>,
}));

jest.mock("@/components/SourcesList", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/CopyButton", () => ({
  __esModule: true,
  default: () => <button type="button">Copy</button>,
}));

const siteConfig = { siteId: "ananda", name: "Test" } as SiteConfig;

const question = `What's (Kriya) {path} [book] | & ; $ <b>bold</b>`;

const answer: Answer = {
  id: "answer-1",
  question,
  answer: "ok",
  timestamp: { _seconds: 1_700_000_000, _nanoseconds: 0 },
};

describe("AnswerItem question escape", () => {
  it("renders saved punctuation as text and does not inject HTML", () => {
    const { container } = render(
      <AnswerItem
        answer={answer}
        handleCopyLink={jest.fn()}
        linkCopied={null}
        isSudoUser={false}
        isFullPage={true}
        siteConfig={siteConfig}
      />
    );

    expect(screen.getByText(question, { exact: false })).toBeInTheDocument();
    expect(container.innerHTML).toContain("&amp;");
    expect(container.innerHTML).toContain("&lt;b&gt;");
    expect(container.innerHTML).not.toContain("<b>bold</b>");
  });
});
