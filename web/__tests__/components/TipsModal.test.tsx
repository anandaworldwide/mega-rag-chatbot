/**
 * Tests for TipsModal component
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TipsModal } from "@/components/TipsModal";
import { SiteConfig } from "@/types/siteConfig";
import * as loadTipsModule from "@/utils/client/loadTips";
import * as analyticsModule from "@/utils/client/analytics";

// Mock the loadTips module - only mock loadSiteTips, not parseTipsContent
jest.mock("@/utils/client/loadTips", () => ({
  ...jest.requireActual("@/utils/client/loadTips"),
  loadSiteTips: jest.fn(),
}));
const mockLoadSiteTips = loadTipsModule.loadSiteTips as jest.MockedFunction<typeof loadTipsModule.loadSiteTips>;

// Mock analytics
jest.mock("@/utils/client/analytics");
const mockLogEvent = analyticsModule.logEvent as jest.MockedFunction<typeof analyticsModule.logEvent>;

describe("TipsModal", () => {
  const mockSiteConfig: SiteConfig = {
    siteId: "ananda",
    shortname: "Luca",
    name: "Luca, The Ananda Devotee Chatbot",
    tagline: "Test tagline",
    greeting: "Test greeting",
    parent_site_url: "https://example.com",
    parent_site_name: "Example",
    help_url: "",
    help_text: "",
    collectionConfig: {},
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    welcome_popup_heading: "Welcome",
    other_visitors_reference: "visitors",
    loginImage: null,
    header: { logo: "logo.png", navItems: [] },
    footer: { links: [] },
    requireLogin: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    queriesPerUserPerDay: 200,
    showSourceContent: true,
    showVoting: true,
  };

  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not render when isOpen is false", () => {
    render(<TipsModal isOpen={false} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    expect(screen.queryByText("Tips & Tricks")).not.toBeInTheDocument();
  });

  it("should render loading state when modal opens", async () => {
    mockLoadSiteTips.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    expect(screen.getByText("Tips & Tricks")).toBeInTheDocument();
    expect(screen.getByText("Loading tips...")).toBeInTheDocument();
  });

  it("should display tips carousel when loaded successfully", async () => {
    const mockTipsData = {
      version: 2,
      content: `Getting Better Answers from Luca

If you're getting unclear answers, try turning off audio and video sources.

---

Exploring Source Content

Click on sources to see excerpts.`,
    };
    mockLoadSiteTips.mockResolvedValueOnce(mockTipsData);

    const mockOnVersionLoaded = jest.fn();
    render(
      <TipsModal
        isOpen={true}
        onClose={mockOnClose}
        siteConfig={mockSiteConfig}
        onVersionLoaded={mockOnVersionLoaded}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Getting Better Answers from Luca")).toBeInTheDocument();
      expect(
        screen.getByText("If you're getting unclear answers, try turning off audio and video sources.")
      ).toBeInTheDocument();
    });

    expect(mockOnVersionLoaded).toHaveBeenCalledWith(2);
    expect(mockLogEvent).toHaveBeenCalledWith("tips_content_loaded", "Tips", "ananda", 2);
  });

  it("should display error message when loading fails", async () => {
    mockLoadSiteTips.mockRejectedValueOnce(new Error("Network error"));

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load tips content")).toBeInTheDocument();
    });

    expect(mockLogEvent).toHaveBeenCalledWith("tips_load_error", "Tips", "ananda");
  });

  it("should display no tips message when content is null", async () => {
    mockLoadSiteTips.mockResolvedValueOnce(null);

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("No tips available for this site yet.")).toBeInTheDocument();
    });
  });

  it("should close modal when close button is clicked", async () => {
    const mockTipsData = {
      version: 1,
      content: "Test tips content",
    };
    mockLoadSiteTips.mockResolvedValueOnce(mockTipsData);

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("Test tips content")).toBeInTheDocument();
    });

    const closeButton = screen.getByLabelText("Close tips");
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith("tips_modal_close", "Tips", "close_button");
  });

  it("should close modal when backdrop is clicked", async () => {
    const mockTipsData = {
      version: 1,
      content: "Test tips content",
    };
    mockLoadSiteTips.mockResolvedValueOnce(mockTipsData);

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("Test tips content")).toBeInTheDocument();
    });

    // Click on the backdrop (the first div with backdrop styling)
    const backdrop = document.querySelector(".fixed.inset-0.bg-black\\/30");
    expect(backdrop).toBeInTheDocument();

    fireEvent.click(backdrop!);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith("tips_modal_close", "Tips", "backdrop_click");
  });

  it("should close modal when Escape key is pressed", async () => {
    const mockTipsData = {
      version: 1,
      content: "Test tips content",
    };
    mockLoadSiteTips.mockResolvedValueOnce(mockTipsData);

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("Test tips content")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith("tips_modal_close", "UI", "escape_key");
  });

  it("should not close modal when clicking inside the modal content", async () => {
    const mockTipsData = {
      version: 1,
      content: "Test tips content",
    };
    mockLoadSiteTips.mockResolvedValueOnce(mockTipsData);

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("Test tips content")).toBeInTheDocument();
    });

    // Click on the modal content
    const modalContent = screen.getByText("Tips & Tricks");
    fireEvent.click(modalContent);

    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("should format content with headings and paragraphs correctly", async () => {
    const mockTipsData = {
      version: 1,
      content:
        "Getting Better Answers\n\nThis is the first paragraph with some helpful information.\n\nThis is the second paragraph with more details.",
    };
    mockLoadSiteTips.mockResolvedValueOnce(mockTipsData);

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      // Check that the first line is rendered as a heading
      expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent("Getting Better Answers");

      // Check that paragraphs are rendered
      expect(screen.getByText(/This is the first paragraph/)).toBeInTheDocument();
      expect(screen.getByText(/This is the second paragraph/)).toBeInTheDocument();
    });
  });

  it("should display footer message when tips are loaded", async () => {
    const mockTipsData = {
      version: 1,
      content: `Test Tip Title

Test tips content.`,
    };
    mockLoadSiteTips.mockResolvedValueOnce(mockTipsData);

    render(<TipsModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("Test tips content.")).toBeInTheDocument();
      expect(screen.getByText(/Have suggestions for more tips/)).toBeInTheDocument();
    });
  });
});
