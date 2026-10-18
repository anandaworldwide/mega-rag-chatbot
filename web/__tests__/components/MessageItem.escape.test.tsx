import React from "react";
import { render, screen } from "@testing-library/react";
import MessageItem from "@/components/MessageItem";
import { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import { SiteConfig } from "@/types/siteConfig";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/contexts/SudoContext", () => ({
  useSudo: () => ({ isSudoUser: false }),
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

const userMessage: ExtendedAIMessage = {
  type: "userMessage",
  message: question,
};

describe("MessageItem user question escape", () => {
  it("renders saved punctuation as text and does not inject HTML", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MessageItem
          message={userMessage}
          index={0}
          isLastMessage={true}
          loading={false}
          temporarySession={false}
          collectionChanged={false}
          hasMultipleCollections={false}
          linkCopied={null}
          siteConfig={siteConfig}
          handleCopyLink={jest.fn()}
          lastMessageRef={null}
          messageKey="user-1"
          allowAllAnswersPage={false}
        />
      </QueryClientProvider>
    );

    expect(screen.getByText(question, { exact: false })).toBeInTheDocument();
    expect(container.innerHTML).toContain("&amp;");
    expect(container.innerHTML).toContain("&lt;b&gt;");
    expect(container.innerHTML).not.toContain("<b>bold</b>");
  });
});
