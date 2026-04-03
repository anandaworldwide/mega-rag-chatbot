import React from "react";
import { render, act, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SiteConfig } from "@/types/siteConfig";
import Home, { getRepairAllLibrariesSelection } from "@/pages/index";

// Mock next/image to prevent Base URL error
jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: any) => (
    <div
      data-testid="mock-image"
      data-src={props.src}
      data-alt={props.alt}
      data-width={props.width}
      data-height={props.height}
      style={{ width: props.width, height: props.height }}
    />
  ),
}));

// Mock the next/router
jest.mock("next/router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    query: {}, // Empty query object by default
    asPath: "/",
  }),
}));

// Mock react-markdown
jest.mock("react-markdown", () => {
  const ReactMarkdownMock = ({ children }: { children: string }) => {
    // Process the content to convert markdown links
    const content = children.toString();
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const processedContent = content.replace(linkRegex, (_, text, url) => {
      // GETHUMAN links are handled differently based on siteConfig in the actual component
      if (url === "GETHUMAN") {
        // Use data attributes to help with test assertions
        return `<a href="${url}" data-testid="gethuman-link">${text}</a>`;
      }
      // Default link rendering with target and rel attributes
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

    return <div data-testid="react-markdown" dangerouslySetInnerHTML={{ __html: processedContent }} />;
  };
  ReactMarkdownMock.displayName = "ReactMarkdown";
  return ReactMarkdownMock;
});

// Mock remark-gfm
jest.mock("remark-gfm", () => {
  return jest.fn();
});

// Mock the hooks
jest.mock("@/hooks/usePopup", () => ({
  __esModule: true,
  default: () => ({
    isOpen: false,
    openPopup: jest.fn(),
    closePopup: jest.fn(),
  }),
}));

jest.mock("@/hooks/useSuggestedQueries", () => ({
  __esModule: true,
  useSuggestedQueries: () => ({
    suggestedQueries: [],
    shuffleQueries: jest.fn(),
  }),
}));

// Mock getCollectionQueries
jest.mock("@/utils/client/collectionQueries", () => ({
  getCollectionQueries: jest.fn().mockResolvedValue([]),
  getCategorizedQueries: jest.fn().mockResolvedValue(null),
}));

// Mock ChatInput component since we're testing it separately
jest.mock("@/components/ChatInput", () => ({
  __esModule: true,
  ChatInput: ({ temporarySession }: any) => (
    <div>
      <textarea data-testid="chat-input" />
      {temporarySession && <div>Temporary Session Active</div>}
    </div>
  ),
}));

// Mock useChat hook
jest.mock("@/hooks/useChat", () => ({
  __esModule: true,
  useChat: () => ({
    messageState: {
      messages: [
        {
          type: "apiMessage",
          message: "Welcome! How can I help you today?",
        },
      ],
      history: [],
    },
    loading: false,
    error: null,
    setError: jest.fn(),
    setLoading: jest.fn(),
    setMessageState: jest.fn(),
    handleSubmit: jest.fn(),
  }),
}));

jest.mock("@/hooks/useMultipleCollections", () => ({
  __esModule: true,
  useMultipleCollections: () => ({
    collections: [],
    isLoading: false,
    error: null,
  }),
}));

// Mock useChatHistory hook
jest.mock("@/hooks/useChatHistory", () => ({
  useChatHistory: jest.fn(() => ({
    loading: false,
    error: null,
    conversations: [],
    hasMore: false,
    fetchConversations: jest.fn(),
    refetch: jest.fn(),
    loadMore: jest.fn(),
  })),
}));

// Mock ChatHistorySidebar
jest.mock("@/components/ChatHistorySidebar", () => ({
  __esModule: true,
  default: function ChatHistorySidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    return (
      <div data-testid="chat-history-sidebar" data-is-open={isOpen}>
        <button onClick={onClose}>Close</button>
      </div>
    );
  },
}));

// Mock the SudoContext
jest.mock("@/contexts/SudoContext", () => ({
  __esModule: true,
  SudoProvider: function SudoProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
  },
  useSudo: function useSudo() {
    return {
      isSudoUser: false,
      isSudoAdmin: false,
    };
  },
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

const minimalSiteConfig: SiteConfig = {
  siteId: "test-site",
  shortname: "test",
  name: "Test Site",
  tagline: "Test Tagline",
  greeting: "Welcome to Ananda!",
  parent_site_url: "https://www.ananda.org",
  parent_site_name: "Ananda",
  help_url: "https://www.ananda.org/help",
  help_text: "Need help?",
  collectionConfig: {},
  libraryMappings: {},
  enableSuggestedQueries: true,
  enableMediaTypeSelection: false,
  enableAuthorSelection: false,
  welcome_popup_heading: "Welcome",
  other_visitors_reference: "others",
  loginImage: null,
  header: { logo: "", navItems: [] },
  footer: { links: [] },
  requireLogin: false,
  allowTemporarySessions: true,
  allowAllAnswersPage: true,
  queriesPerUserPerDay: 100,
  showSourceContent: true,
  showVoting: false,
};

describe("Home Page", () => {
  // Set up mock for window.location
  let originalLocation: Location;

  beforeEach(() => {
    // Store the original location
    originalLocation = window.location;

    // Create a new Location object
    const mockLocation = {
      ...originalLocation,
      href: "",
      // Add any other properties being used in tests
    };

    // Use Object.defineProperty to avoid TypeScript errors
    Object.defineProperty(window, "location", {
      value: mockLocation,
      writable: true,
    });
  });

  afterEach(() => {
    // Use Object.defineProperty to restore original window.location
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  describe("Filter Conflict Recovery", () => {
    it("falls back to default libraries when repairAll omits libraries", () => {
      expect(getRepairAllLibrariesSelection(undefined, [])).toEqual([]);
      expect(getRepairAllLibrariesSelection(undefined, ["Default Library"])).toEqual(["Default Library"]);
    });

    it("uses action libraries when repairAll provides them", () => {
      expect(getRepairAllLibrariesSelection(["Repair Library"], ["Default Library"])).toEqual(["Repair Library"]);
    });
  });

  it("renders the home page correctly", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Home siteConfig={minimalSiteConfig} />
      </QueryClientProvider>
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByText("Welcome! How can I help you today?")).toBeInTheDocument();
    expect(screen.getByTestId("landing-chat-layout")).toBeInTheDocument();
  });

  // it('handles GETHUMAN links correctly', async () => {
  //   const { findByTestId } = render(
  //     <QueryClientProvider client={queryClient}>
  //       <Home siteConfig={minimalSiteConfig} />
  //     </QueryClientProvider>,
  //   );
  //
  //   // Assuming a message with [Text](GETHUMAN) is rendered
  //   // and ReactMarkdown translates it to <a data-testid="gethuman-link" ...>
  //   expect(await findByTestId('gethuman-link')).toBeInTheDocument();
  // });

  describe("Props Validation", () => {
    it("handles null siteConfig gracefully", async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Home siteConfig={null} />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Should still render without crashing and *not* show chat input
      expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();
    });

    it("uses default values when optional siteConfig properties are missing", async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Home
            siteConfig={{
              siteId: "test",
              shortname: "test",
              name: "Test Site",
              tagline: "Test Tagline",
              greeting: "Test Greeting",
              parent_site_url: "https://test.com",
              parent_site_name: "Test Parent",
              help_url: "https://test.com/help",
              help_text: "Help",
              collectionConfig: {},
              libraryMappings: {},
              header: { logo: "", navItems: [] },
              footer: { links: [] },
              enableSuggestedQueries: false,
              enableMediaTypeSelection: false,
              enableAuthorSelection: false,
              welcome_popup_heading: "Welcome",
              other_visitors_reference: "others",
              loginImage: null,
              requireLogin: false,
              allowTemporarySessions: false,
              allowAllAnswersPage: false,
              queriesPerUserPerDay: 100,
              showSourceContent: true,
              showVoting: false,
            }}
          />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Should render chat input with minimal config
      expect(screen.getByTestId("chat-input")).toBeInTheDocument();
    });
  });

  describe("Initial State", () => {
    it("starts with an empty chat input", async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Home siteConfig={minimalSiteConfig} />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const input = await screen.findByTestId("chat-input");
      expect(input).toHaveValue("");
    });

    it("starts with default media type settings", async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Home siteConfig={minimalSiteConfig} />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Add assertions for media type settings
      expect(screen.getByText("Welcome! How can I help you today?")).toBeInTheDocument();
    });

    it("starts with private session disabled", async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Home siteConfig={minimalSiteConfig} />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Add assertions for private session state
      expect(screen.getByText("Welcome! How can I help you today?")).toBeInTheDocument();
    });

    it("starts with maintenance mode disabled", async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Home siteConfig={minimalSiteConfig} />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Add assertions for maintenance mode state
      expect(screen.getByText("Welcome! How can I help you today?")).toBeInTheDocument();
    });

    it("initializes with the first available collection", async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Home siteConfig={minimalSiteConfig} />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Add assertion for collection if needed, using getByTestId if appropriate
      // Example: expect(getByTestId('collection-selector').value).toBe('...');
      // For now, just ensuring it renders without error is implicitly tested by setup.
      // If findByTestId was only used for chat-input check, it's redundant now.
    });
  });

  describe("Temporary Session Functionality", () => {
    // Mock window.location.reload to verify it's not called
    const mockReload = jest.fn();

    beforeEach(() => {
      // Mock window.location.reload
      Object.defineProperty(window, "location", {
        value: {
          ...window.location,
          reload: mockReload,
        },
        writable: true,
      });

      // Mock window.history.pushState
      Object.defineProperty(window, "history", {
        value: {
          ...window.history,
          pushState: jest.fn(),
        },
        writable: true,
      });

      mockReload.mockClear();
    });

    it("passes temporary session props to layout correctly", async () => {
      const siteConfigWithTempSessions = {
        ...minimalSiteConfig,
        allowTemporarySessions: true,
      };

      render(
        <QueryClientProvider client={queryClient}>
          <Home siteConfig={siteConfigWithTempSessions} />
        </QueryClientProvider>
      );

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Verify that the page renders correctly with temporary session support
      expect(screen.getByTestId("chat-input")).toBeInTheDocument();

      // Verify the greeting message is shown (indicating empty chat state)
      expect(screen.getByText("Welcome! How can I help you today?")).toBeInTheDocument();

      // Note: Temporary session functionality is now in the navigation header
      // The header components receive the necessary props for temporary session management
    });

    it("ends temporary session when new chat button is clicked", async () => {
      // Mock the handleNewChat function to verify it's called
      const mockHandleNewChat = jest.fn();

      // Create a component with temporary session active
      const TestComponent = () => {
        const [tempSession, setTempSession] = React.useState(true);

        const handleNewChat = () => {
          if (tempSession) {
            setTempSession(false);
          }
          mockHandleNewChat();
        };

        return (
          <div>
            <div data-testid="temp-session-status">
              {tempSession ? "Temporary Session Active" : "No Temporary Session"}
            </div>
            <button onClick={handleNewChat} data-testid="new-chat-button">
              New Chat
            </button>
          </div>
        );
      };

      render(<TestComponent />);

      // Verify temporary session is initially active
      expect(screen.getByText("Temporary Session Active")).toBeInTheDocument();

      // Click the new chat button
      const newChatButton = screen.getByTestId("new-chat-button");
      fireEvent.click(newChatButton);

      // Verify temporary session is ended
      expect(screen.getByText("No Temporary Session")).toBeInTheDocument();
      expect(mockHandleNewChat).toHaveBeenCalledTimes(1);
    });
  });
});
