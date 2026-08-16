// Mock dependencies
jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/components/SuggestedQueries", () =>
  jest.fn().mockImplementation(({ queries, onQueryClick }) => (
    <div data-testid="random-queries">
      {queries.map((query: string, index: number) => (
        <button key={index} onClick={() => onQueryClick(query)}>
          {query}
        </button>
      ))}
    </div>
  ))
);

// React imports after mocks
import React from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";
import { SiteConfig } from "@/types/siteConfig";

describe("ChatInput", () => {
  // Common mock props
  const mockSiteConfig: SiteConfig = {
    siteId: "test",
    name: "Test Site",
    shortname: "Test",
    tagline: "Test Tagline",
    greeting: "Test Greeting",
    parent_site_url: "",
    parent_site_name: "",
    help_url: "",
    help_text: "",
    collectionConfig: {},
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    welcome_popup_heading: "",
    other_visitors_reference: "",
    loginImage: null,
    header: { logo: "", navItems: [] },
    footer: { links: [] },
    requireLogin: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: false,
    queriesPerUserPerDay: 100,
    showSourceContent: true,
    showVoting: true,
  };

  // Default props for tests
  const defaultProps = {
    loading: false,
    handleSubmit: jest.fn(),
    handleStop: jest.fn(),
    handleEnter: jest.fn(),
    handleClick: jest.fn(),
    handleCollectionChange: jest.fn(),
    collection: "all",
    temporarySession: false,
    error: null,
    setError: jest.fn(),
    suggestedQueries: ["How can I meditate?", "What is yoga?"],
    textAreaRef: { current: null } as React.RefObject<HTMLTextAreaElement>,
    mediaTypes: { text: true, audio: false, youtube: false },
    handleMediaTypeChange: jest.fn(),
    selectedLibraries: [],
    handleLibraryChange: jest.fn(),
    siteConfig: mockSiteConfig,
    input: "",
    handleInputChange: jest.fn(),
    setShouldAutoScroll: jest.fn(),
    setQuery: jest.fn(),
    isNearBottom: true,
    setIsNearBottom: jest.fn(),
    isLoadingQueries: false,
    onTemporarySessionChange: jest.fn(),
    sourceCount: 0,
    setSourceCount: jest.fn(),
    isChatEmpty: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders correctly", () => {
    const { container } = render(<ChatInput {...defaultProps} />);
    expect(container).toBeInTheDocument();
  });

  it("submits input on form submission", () => {
    const props = {
      ...defaultProps,
      input: "Test question",
    };

    const { container } = render(<ChatInput {...props} />);

    // Find the form element directly
    const form = container.querySelector("form");
    fireEvent.submit(form!);

    expect(defaultProps.handleSubmit).toHaveBeenCalled();
  });

  it("calls handleStop when stop button is clicked during loading", () => {
    const props = {
      ...defaultProps,
      loading: true,
    };

    render(<ChatInput {...props} />);

    // Find stop button by its text content
    const stopButton = screen.getByText("stop");
    fireEvent.click(stopButton);

    expect(defaultProps.handleStop).toHaveBeenCalled();
  });

  it("handles Enter key press correctly", () => {
    const props = {
      ...defaultProps,
      input: "Test question",
    };

    render(<ChatInput {...props} />);

    const textarea = screen.getByRole("textbox", { name: "Chat message" });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(defaultProps.handleEnter).toHaveBeenCalled();
  });

  it("does not submit on Shift+Enter", () => {
    const props = {
      ...defaultProps,
      input: "Test question",
    };

    render(<ChatInput {...props} />);

    const textarea = screen.getByRole("textbox", { name: "Chat message" });
    fireEvent.keyDown(textarea, {
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    });

    expect(defaultProps.handleEnter).not.toHaveBeenCalled();
  });

  it("shows chat options dropdown when options are available", () => {
    render(<ChatInput {...defaultProps} />);

    // Check if the filter button is present
    const filterButton = screen.getByRole("button", { name: /content filters/i });
    expect(filterButton).toBeInTheDocument();
  });

  it("does not show a suggested-query shuffle button", () => {
    render(<ChatInput {...defaultProps} />);

    expect(screen.queryByTestId("regenerate-button")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Get new example questions")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Generate new questions")).not.toBeInTheDocument();
  });

  it("displays temporary session indicator when active", () => {
    render(<ChatInput {...defaultProps} temporarySession={true} />);

    // Check that the temporary session indicator is displayed
    expect(screen.getByText(/Temporary Session Active/)).toBeInTheDocument();
    expect(screen.getByText("lock")).toBeInTheDocument();
  });

  it("opens dropdown and shows media type options", () => {
    render(<ChatInput {...defaultProps} />);

    // Click the filter button to open it (media types are in FilterDropdown)
    const filterButton = screen.getByRole("button", { name: /content filters/i });
    fireEvent.click(filterButton);

    // Check if media type options are visible in the dropdown
    expect(screen.getByText("Media Types")).toBeInTheDocument();
    expect(screen.getByText("Audio")).toBeInTheDocument();
  });

  it("closes dropdown when clicking outside", () => {
    render(<ChatInput {...defaultProps} />);

    // Open the filter dropdown
    const filterButton = screen.getByRole("button", { name: /content filters/i });
    fireEvent.click(filterButton);

    // Verify dropdown is open
    expect(screen.getByText("Media Types")).toBeInTheDocument();

    // Click outside the dropdown (on document body)
    fireEvent.mouseDown(document.body);

    // Verify dropdown is closed
    expect(screen.queryByText("Media Types")).not.toBeInTheDocument();
  });

  it("handles empty input gracefully by passing to parent", () => {
    const props = {
      ...defaultProps,
      input: "",
    };

    render(<ChatInput {...props} />);

    // Find send button by its icon text
    const sendButton = screen.getByText("arrow_upward");
    fireEvent.click(sendButton);

    // Empty input should not trigger error, but should call handleSubmit
    // to let parent handle it gracefully (parent has early return for empty strings)
    expect(defaultProps.setError).not.toHaveBeenCalled();
    expect(defaultProps.handleSubmit).toHaveBeenCalledWith(expect.any(Object), "");
  });

  it("renders suggested queries when available", () => {
    render(<ChatInput {...defaultProps} />);

    // Verify that suggested queries are displayed
    expect(screen.getByText("How can I meditate?")).toBeInTheDocument();
    expect(screen.getByText("What is yoga?")).toBeInTheDocument();
  });

  it("passes sourceCount props to FilterDropdown", () => {
    const mockSetSourceCount = jest.fn();
    const props = {
      ...defaultProps,
      sourceCount: 10,
      setSourceCount: mockSetSourceCount,
      siteConfig: {
        ...mockSiteConfig,
        showSourceCountSelector: true,
      },
    };

    render(<ChatInput {...props} />);

    // Open the filter dropdown (extra sources option is now in FilterDropdown)
    const filterButton = screen.getByRole("button", { name: /content filters/i });
    fireEvent.click(filterButton);

    // Verify response depth option is present
    expect(screen.getByText("Response Depth")).toBeInTheDocument();
    expect(screen.getByText(/Use 10 sources/)).toBeInTheDocument();
  });

  it("exposes Voice Control names for the chat field and send button", () => {
    render(<ChatInput {...defaultProps} />);

    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("labels the stop button while a response is generating", () => {
    render(<ChatInput {...defaultProps} loading={true} />);

    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();
  });

  it("does not render the task wizard wand", () => {
    render(<ChatInput {...defaultProps} />);

    expect(screen.queryByText("auto_fix_high")).not.toBeInTheDocument();
  });
});
