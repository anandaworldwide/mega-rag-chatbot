import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRouter } from "next/router";
import DownvotesReview from "@/pages/admin/downvotes";
import { useDownvotedAnswers } from "@/hooks/useAnswers";
import { SiteConfig } from "@/types/siteConfig";

// Mock next/router
jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

// Mock the useDownvotedAnswers hook
jest.mock("@/hooks/useAnswers", () => ({
  useDownvotedAnswers: jest.fn(),
}));

describe("DownvotesReview", () => {
  const mockRouter = {
    query: { page: "1" },
    push: jest.fn(),
    pathname: "/admin/downvotes",
  };

  const mockSiteConfig: SiteConfig = {
    siteId: "test-site",
    name: "Test Site",
    shortname: "test",
    tagline: "Test tagline",
    greeting: "Welcome to test site",
    parent_site_url: "https://example.com",
    parent_site_name: "Parent Site",
    help_url: "https://example.com/help",
    help_text: "Get help here",
    collectionConfig: {},
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    welcome_popup_heading: "Welcome",
    other_visitors_reference: "Others are viewing",
    loginImage: null,
    header: {
      logo: "logo.png",
      navItems: [],
    },
    footer: {
      links: [],
    },
    requireLogin: false,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    queriesPerUserPerDay: 50,
    showSourceContent: true,
    showVoting: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
  });

  it("renders loading state", () => {
    (useDownvotedAnswers as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<DownvotesReview siteConfig={mockSiteConfig} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders error state", () => {
    (useDownvotedAnswers as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Test error"),
    });

    render(<DownvotesReview siteConfig={mockSiteConfig} />);
    expect(screen.getByText(/Test error/)).toBeInTheDocument();
  });

  it("renders empty state", () => {
    (useDownvotedAnswers as jest.Mock).mockReturnValue({
      data: { answers: [], totalPages: 0, currentPage: 1 },
      isLoading: false,
      error: null,
    });

    render(<DownvotesReview siteConfig={mockSiteConfig} />);
    expect(screen.getByText("No downvoted answers to review.")).toBeInTheDocument();
  });

  it("renders answers and pagination controls", () => {
    const mockData = {
      answers: [
        {
          id: "answer1",
          question: "Test Question 1",
          answer: "Test Answer 1",
          vote: -1,
          timestamp: new Date("2024-01-01").toISOString(),
        },
        {
          id: "answer2",
          question: "Test Question 2",
          answer: "Test Answer 2",
          vote: -1,
          timestamp: new Date("2024-01-02").toISOString(),
        },
      ],
      totalPages: 3,
      currentPage: 2,
    };

    // Update router query to match currentPage in mockData
    mockRouter.query.page = "2";

    (useDownvotedAnswers as jest.Mock).mockReturnValue({
      data: mockData,
      isLoading: false,
      error: null,
    });

    render(<DownvotesReview siteConfig={mockSiteConfig} />);

    // Check if answers are rendered
    expect(screen.getByText("Test Question 1")).toBeInTheDocument();
    expect(screen.getByText("Test Question 2")).toBeInTheDocument();

    // Check pagination controls
    const pageText = screen.getByText(/Page/);
    expect(pageText).toBeInTheDocument();
    expect(pageText).toHaveTextContent(`Page ${mockData.currentPage} of ${mockData.totalPages}`);

    // Check Previous/Next buttons
    const prevButton = screen.getByRole("button", { name: "Previous" });
    const nextButton = screen.getByRole("button", { name: "Next" });
    expect(prevButton).not.toBeDisabled();
    expect(nextButton).not.toBeDisabled();
  });

  it("handles page navigation", async () => {
    const mockData = {
      answers: [
        {
          id: "answer1",
          question: "Test Question 1",
          answer: "Test Answer 1",
          vote: -1,
          timestamp: new Date("2024-01-01").toISOString(),
        },
      ],
      totalPages: 3,
      currentPage: 1,
    };

    mockRouter.push.mockClear();
    mockRouter.query.page = "2";

    (useDownvotedAnswers as jest.Mock).mockReturnValue({
      data: mockData,
      isLoading: false,
      error: null,
    });

    render(<DownvotesReview siteConfig={mockSiteConfig} />);

    // Click next page button
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      // Component is sending page 3, so we should expect that
      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: "/admin/downvotes",
        query: { page: 3 },
      });
    });
  });

  it("disables pagination buttons appropriately", () => {
    // First, test first page (Previous should be disabled)
    const mockData = {
      answers: [
        {
          id: "answer1",
          question: "Test Question 1",
          answer: "Test Answer 1",
          vote: -1,
          timestamp: new Date("2024-01-01").toISOString(),
        },
      ],
      totalPages: 3,
      currentPage: 1,
    };

    mockRouter.query.page = "1";

    (useDownvotedAnswers as jest.Mock).mockReturnValue({
      data: mockData,
      isLoading: false,
      error: null,
    });

    const { unmount } = render(<DownvotesReview siteConfig={mockSiteConfig} />);

    const prevButton = screen.getByRole("button", { name: "Previous" });
    const nextButton = screen.getByRole("button", { name: "Next" });
    expect(prevButton).toBeDisabled();
    expect(nextButton).not.toBeDisabled();

    // Clean up
    unmount();

    // Now test last page (Next should be disabled)
    mockRouter.query.page = "3";
    (useDownvotedAnswers as jest.Mock).mockReturnValue({
      data: { ...mockData, currentPage: 3 },
      isLoading: false,
      error: null,
    });

    render(<DownvotesReview siteConfig={mockSiteConfig} />);

    const lastPagePrevButton = screen.getByRole("button", { name: "Previous" });
    const lastPageNextButton = screen.getByRole("button", { name: "Next" });
    expect(lastPagePrevButton).not.toBeDisabled();
    expect(lastPageNextButton).toBeDisabled();
  });
});
