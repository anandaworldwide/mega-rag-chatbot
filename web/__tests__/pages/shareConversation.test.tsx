import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ShareConversation from "@/pages/share/[docId]";
import { SiteConfig } from "@/types/siteConfig";
import { fetchWithAuth, isAuthenticated } from "@/utils/client/tokenManager";
import { loadConversationByDocId } from "@/utils/client/conversationLoader";
import { useRouter } from "next/router";

const mockReplace = jest.fn();
const mockPush = jest.fn();
const SHARE_ID = "OHXIZPKK5XAyj9f1vEXx";
const mockRouter = {
  isReady: true,
  query: { docId: SHARE_ID },
  replace: mockReplace,
  push: mockPush,
  asPath: `/share/${SHARE_ID}`,
  pathname: "/share/[docId]",
};

jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("next/head", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/components/layout", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

jest.mock("@/components/MessageItem", () => ({
  __esModule: true,
  default: ({ message }: { message: { message: string; type: string } }) => (
    <div data-testid={`msg-${message.type}`}>{message.message}</div>
  ),
}));

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
  initializeTokenManager: jest.fn().mockResolvedValue(null),
  isAuthenticated: jest.fn(),
}));

jest.mock("@/utils/client/conversationLoader", () => {
  class ConversationNotFoundError extends Error {
    constructor(message = "Conversation not found") {
      super(message);
      this.name = "ConversationNotFoundError";
    }
  }
  return {
    ConversationNotFoundError,
    loadConversationByDocId: jest.fn(),
  };
});

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn().mockReturnValue("viewer-uuid"),
}));

const mockSiteConfig = {
  siteId: "ananda",
  shortname: "Luca",
  name: "Luca",
  tagline: "Test",
  greeting: "Hello from Luca",
  requireLogin: true,
} as SiteConfig;

describe("ShareConversation logged-out on requireLogin site", () => {
  const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;
  const mockIsAuthenticated = isAuthenticated as jest.MockedFunction<typeof isAuthenticated>;
  const mockLoadConversationByDocId = loadConversationByDocId as jest.MockedFunction<typeof loadConversationByDocId>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAuthenticated.mockReturnValue(false);
    mockReplace.mockReset();
    mockPush.mockReset();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: `/share/${SHARE_ID}`,
        search: "",
        hash: "",
        href: `http://localhost/share/${SHARE_ID}`,
        origin: "http://localhost",
      },
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: SHARE_ID,
        title: "Meditation",
        turns: [
          {
            id: SHARE_ID,
            question: "What is meditation?",
            answer: "A practice of inner stillness.",
            sources: [],
            timestamp: { seconds: 1 },
            title: "Meditation",
            collection: "whole_library",
            suggestions: [],
            model: null,
          },
        ],
      }),
    }) as jest.Mock;
  });

  it("renders the conversation and does not redirect", async () => {
    render(<ShareConversation siteConfig={mockSiteConfig} />);

    expect(await screen.findByText("What is meditation?")).toBeInTheDocument();
    expect(screen.getByText("A practice of inner stillness.")).toBeInTheDocument();
    expect(screen.getByText(/viewing a shared conversation/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(`/api/share/${SHARE_ID}`);
    });
    expect(mockLoadConversationByDocId).not.toHaveBeenCalled();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(String(window.location.href)).not.toMatch(/\/login/);
  });
});

describe("ShareConversation logged-out on requireLogin false site", () => {
  const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;
  const mockIsAuthenticated = isAuthenticated as jest.MockedFunction<typeof isAuthenticated>;
  const mockLoadConversationByDocId = loadConversationByDocId as jest.MockedFunction<typeof loadConversationByDocId>;

  const noLoginSiteConfig = {
    ...mockSiteConfig,
    siteId: "ananda-public",
    shortname: "Vivek",
    name: "Vivek",
    greeting: "Hello from Vivek",
    requireLogin: false,
  } as SiteConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAuthenticated.mockReturnValue(false);
    mockReplace.mockReset();
    mockPush.mockReset();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: `/share/${SHARE_ID}`,
        search: "",
        hash: "",
        href: `http://localhost/share/${SHARE_ID}`,
        origin: "http://localhost",
      },
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: SHARE_ID,
        title: "Meditation",
        turns: [
          {
            id: SHARE_ID,
            question: "What is meditation?",
            answer: "A practice of inner stillness.",
            sources: [],
            timestamp: { seconds: 1 },
            title: "Meditation",
            collection: "whole_library",
            suggestions: [],
            model: null,
          },
        ],
      }),
    }) as jest.Mock;
  });

  it("loads /api/share/{id} and does not call /api/document", async () => {
    render(<ShareConversation siteConfig={noLoginSiteConfig} />);

    expect(await screen.findByText("What is meditation?")).toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(`/api/share/${SHARE_ID}`);
    });
    expect(global.fetch).not.toHaveBeenCalledWith(`/api/document/${SHARE_ID}`);
    expect(mockLoadConversationByDocId).not.toHaveBeenCalled();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });
});
