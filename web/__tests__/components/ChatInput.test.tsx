// Mock dependencies
jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/components/CollectionSelector", () =>
  jest.fn().mockImplementation(({ onChange, value }) => (
    <select data-testid="collection-selector" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="all">All</option>
      <option value="test">Test</option>
    </select>
  ))
);

jest.mock("@/components/SuggestedQueries", () =>
  jest.fn().mockImplementation(({ queries, onQueryClick, shuffleQueries }) => (
    <div data-testid="random-queries">
      {queries.map((query: string, index: number) => (
        <button key={index} onClick={() => onQueryClick(query)}>
          {query}
        </button>
      ))}
      <button data-testid="regenerate-button" onClick={shuffleQueries}>
        Regenerate
      </button>
    </div>
  ))
);

// React imports after mocks
import React from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";
import { SiteConfig } from "@/types/siteConfig";
import { DEFAULT_MODEL } from "@/config/modelOptions";

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
    shuffleQueries: jest.fn(),
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
    selectedModel: DEFAULT_MODEL,
    handleModelChange: jest.fn(),
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

    // Get textarea by its role and id
    const textarea = screen.getByRole("textbox", { name: "" });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(defaultProps.handleEnter).toHaveBeenCalled();
  });

  it("does not submit on Shift+Enter", () => {
    const props = {
      ...defaultProps,
      input: "Test question",
    };

    render(<ChatInput {...props} />);

    // Get textarea by its role and id
    const textarea = screen.getByRole("textbox", { name: "" });
    fireEvent.keyDown(textarea, {
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    });

    expect(defaultProps.handleEnter).not.toHaveBeenCalled();
  });

  it("shows chat options dropdown when options are available", () => {
    render(<ChatInput {...defaultProps} />);

    // Check if the AI settings and filter buttons are present
    const aiSettingsButton = screen.getByRole("button", { name: /ai settings/i });
    const filterButton = screen.getByRole("button", { name: /content filters/i });
    expect(aiSettingsButton).toBeInTheDocument();
    expect(filterButton).toBeInTheDocument();
  });

  it("handles query shuffling", () => {
    render(<ChatInput {...defaultProps} />);

    // Find and click the regenerate button directly
    const regenerateButton = screen.getByTestId("regenerate-button");
    fireEvent.click(regenerateButton);

    // Verify that shuffleQueries was called
    expect(defaultProps.shuffleQueries).toHaveBeenCalled();
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

  it("passes model props to AISettingsDropdown", () => {
    const mockHandleModelChange = jest.fn();
    const props = {
      ...defaultProps,
      selectedModel: "gpt-4o",
      handleModelChange: mockHandleModelChange,
    };

    render(<ChatInput {...props} />);

    // Open the AI settings dropdown (model selection is in AISettingsDropdown)
    const aiSettingsButton = screen.getByRole("button", { name: /ai settings/i });
    fireEvent.click(aiSettingsButton);

    // Verify model selector is present
    expect(screen.getByText("AI Model")).toBeInTheDocument();

    // Verify the selected model is shown
    const selectedRadio = screen.getByLabelText("GPT-4 Optimized") as HTMLInputElement;
    expect(selectedRadio.checked).toBe(true);
  });
});
