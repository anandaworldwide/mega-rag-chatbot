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
import { render, fireEvent, screen, act } from "@testing-library/react";
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

  describe("mobile follow-up auto-hide", () => {

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

function prepareScroller(el: HTMLElement) {
  let scrollTop = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2400 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: 500 });
}

function FollowUpHarness({
  width,
  input = "",
  loading = false,
  revealSignal = 0,
  enableHideOnScroll = true,
}: {
  width: number;
  input?: string;
  loading?: boolean;
  revealSignal?: number;
  enableHideOnScroll?: boolean;
}) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (scrollerRef.current) prepareScroller(scrollerRef.current);
  }, []);
  setWindowWidth(width);
  return (
    <div>
      <div ref={scrollerRef} data-testid="answer-scroller" />
      <ChatInput
        {...defaultProps}
        input={input}
        loading={loading}
        shouldShowSuggestions={false}
        selectedTitleScope={null}
        setSelectedTitleScope={jest.fn()}
        scrollContainerRef={scrollerRef}
        enableHideOnScroll={enableHideOnScroll}
        revealSignal={revealSignal}
      />
    </div>
  );
}

describe("ChatInput mobile follow-up auto-hide", () => {
  const originalWidth = window.innerWidth;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 140;
      },
    });
  });

  afterEach(() => {
    setWindowWidth(originalWidth);
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    }
    window.matchMedia = originalMatchMedia;
  });

  function bar() {
    return screen.getByTestId("follow-up-bar");
  }

  it("hides after scrolling down and shows after scrolling up on mobile", () => {
    render(<FollowUpHarness width={390} />);
    const scroller = screen.getByTestId("answer-scroller");

    expect(bar()).toHaveAttribute("data-hidden", "false");
    expect(bar()).toHaveStyle({
      transform: "translateY(0)",
      backgroundColor: "rgb(255, 255, 255)",
      left: "-1rem",
      right: "-1rem",
    });
    expect(scroller).toHaveStyle({ paddingBottom: "140px" });
    expect(bar().className).toContain("env(safe-area-inset-bottom)");

    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);

    expect(bar()).toHaveAttribute("data-hidden", "true");
    expect(bar()).toHaveStyle({ transform: "translateY(100%)", pointerEvents: "none" });
    expect(scroller).toHaveStyle({ paddingBottom: "0px" });

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "false");
    expect(bar()).toHaveStyle({ transform: "translateY(0)" });
  });

  it("stays visible while the field is focused or has text", () => {
    const { rerender } = render(<FollowUpHarness width={390} />);
    const scroller = screen.getByTestId("answer-scroller");

    fireEvent.focus(screen.getByRole("textbox", { name: "Chat message" }));
    scroller.scrollTop = 80;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "false");

    fireEvent.blur(screen.getByRole("textbox", { name: "Chat message" }));
    scroller.scrollTop = 160;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "true");

    rerender(<FollowUpHarness width={390} input="still typing" />);
    scroller.scrollTop = 240;
    fireEvent.scroll(screen.getByTestId("answer-scroller"));
    expect(bar()).toHaveAttribute("data-hidden", "false");
  });

  it("hides on scroll-down while a response is streaming and returns on scroll-up or at the bottom", () => {
    render(<FollowUpHarness width={390} loading />);
    const scroller = screen.getByTestId("answer-scroller");

    expect(bar()).toHaveAttribute("data-hidden", "false");
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();

    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "true");
    expect(bar()).toHaveStyle({ transform: "translateY(100%)", pointerEvents: "none" });

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "false");
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();

    scroller.scrollTop = 80;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "true");

    // 2400 - 1860 - 500 = 40, inside the 48px bottom offset
    scroller.scrollTop = 1860;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "false");
    expect(bar()).toHaveStyle({ transform: "translateY(0)", pointerEvents: "auto" });
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();
  });

  it("stays visible while typing during a stream", () => {
    const { rerender } = render(<FollowUpHarness width={390} loading />);
    const scroller = screen.getByTestId("answer-scroller");
    const field = screen.getByRole("textbox", { name: "Chat message" });

    fireEvent.focus(field);
    scroller.scrollTop = 60;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "false");

    fireEvent.blur(field);
    rerender(<FollowUpHarness width={390} loading input="draft follow-up" />);
    scroller.scrollTop = 140;
    fireEvent.scroll(screen.getByTestId("answer-scroller"));
    expect(bar()).toHaveAttribute("data-hidden", "false");
  });

  async function flushFocusTimeout() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("blurs after send on mobile so streaming scroll can hide the bar", async () => {
    // Earlier desktop submits schedule a focus timeout and do not flush it.
    await flushFocusTimeout();
    const { rerender } = render(<FollowUpHarness width={390} input="What is karma?" />);
    const field = screen.getByRole("textbox", { name: "Chat message" });
    field.focus();
    fireEvent.focus(field);

    fireEvent.submit(field.closest("form")!);
    expect(field).not.toHaveFocus();
    await flushFocusTimeout();

    expect(field).not.toHaveFocus();
    expect(defaultProps.handleSubmit).toHaveBeenCalled();

    rerender(<FollowUpHarness width={390} input="" loading />);
    const scroller = screen.getByTestId("answer-scroller");
    scroller.scrollTop = 50;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "true");
  });

  it("blurs after Enter on mobile", async () => {
    await flushFocusTimeout();
    render(<FollowUpHarness width={390} input="What is karma?" />);
    const field = screen.getByRole("textbox", { name: "Chat message" });
    field.focus();
    fireEvent.focus(field);

    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    expect(field).not.toHaveFocus();
    await flushFocusTimeout();

    expect(field).not.toHaveFocus();
    expect(defaultProps.handleEnter).toHaveBeenCalled();
  });

  it("refocuses the field after submit on desktop", async () => {
    await flushFocusTimeout();
    render(<FollowUpHarness width={1280} input="What is karma?" />);
    const field = screen.getByRole("textbox", { name: "Chat message" });

    fireEvent.submit(field.closest("form")!);
    expect(field).not.toHaveFocus();
    await flushFocusTimeout();

    expect(field).toHaveFocus();
  });

  it("shows again when the scroll-to-bottom signal fires", () => {
    const { rerender } = render(<FollowUpHarness width={390} />);
    const scroller = screen.getByTestId("answer-scroller");
    scroller.scrollTop = 50;
    fireEvent.scroll(scroller);
    expect(bar()).toHaveAttribute("data-hidden", "true");

    rerender(<FollowUpHarness width={390} revealSignal={1} />);
    expect(bar()).toHaveAttribute("data-hidden", "false");
  });

  it("does not animate when reduced motion is requested", () => {
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;

    render(<FollowUpHarness width={390} />);
    expect(bar()).toHaveStyle({ transition: "none", transform: "translateY(0)" });
  });

  it("leaves the desktop follow-up box in normal flow", () => {
    render(<FollowUpHarness width={1280} />);
    const scroller = screen.getByTestId("answer-scroller");
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);

    expect(bar()).toHaveAttribute("data-hidden", "false");
    expect(bar().style.transform).toBe("");
    expect(bar().style.position).toBe("");
    expect(scroller.style.paddingBottom).toBe("");
  });
  });
  });
});
