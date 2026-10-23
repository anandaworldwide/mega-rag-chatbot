/**
 * After clone, GET /chat/{id} is 200. The client then fetched
 * /_next/data/{build}/chat/{id}.json?convId={id} (Next dynamic-route query)
 * and 404ed. The old page only showed a spinner and router.replace("/", as),
 * so the spinner never cleared.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";

jest.mock("@/pages/index", () => ({
  __esModule: true,
  default: function Home() {
    return <div data-testid="chat-home">chat-ready</div>;
  },
}));

jest.mock("@/utils/server/getCommonSiteConfigProps", () => ({
  getCommonSiteConfigProps: jest.fn().mockResolvedValue({
    props: {
      siteConfig: { siteId: "ananda-public", name: "Vivek", requireLogin: false },
    },
  }),
}));

import ChatConversation, { getServerSideProps } from "@/pages/chat/[convId]";

const mockReplace = jest.fn();

jest.mock("next/router", () => ({
  useRouter: () => ({
    isReady: true,
    query: { convId: "f0cf8eaf-6dba-442b-ae74-2777a7fd9281" },
    asPath: "/chat/f0cf8eaf-6dba-442b-ae74-2777a7fd9281",
    pathname: "/chat/[convId]",
    push: jest.fn(),
    replace: mockReplace,
  }),
}));

describe("chat/[convId] after clone", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/pages/chat/[convId].tsx"), "utf8");

  it("does not keep a Loading conversation spinner page", () => {
    expect(source).not.toContain("Loading conversation...");
    render(<ChatConversation siteConfig={null} />);
    expect(screen.queryByText("Loading conversation...")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-home")).toBeInTheDocument();
  });

  it("does not mask-replace / with /chat/id (that fetch 404s the data route)", () => {
    render(<ChatConversation siteConfig={null} />);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("getServerSideProps returns props and never notFound when convId query is present", async () => {
    const result = await getServerSideProps({
      query: { convId: "f0cf8eaf-6dba-442b-ae74-2777a7fd9281" },
      req: {} as never,
      res: {} as never,
      resolvedUrl: "/chat/f0cf8eaf-6dba-442b-ae74-2777a7fd9281",
    });
    expect(result).toEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          siteConfig: expect.anything(),
        }),
      })
    );
    expect(result).not.toHaveProperty("notFound");
  });
});
