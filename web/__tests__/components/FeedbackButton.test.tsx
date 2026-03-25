import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import FeedbackButton from "@/components/FeedbackButton";
import { SiteConfig } from "@/types/siteConfig";

describe("FeedbackButton", () => {
  const mockSiteConfig: SiteConfig = {
    siteId: "ananda",
    shortname: "Luca",
    name: "Luca, The Ananda Devotee Chatbot",
    tagline: "Explore, Discover, Learn",
    greeting: "Greetings! I'm Luca.",
    emailGreeting: "Greetings!",
    welcome_popup_heading: "Welcome, Gurubhai!",
    other_visitors_reference: "your Gurubhais",
    chatPlaceholder: "How can I meditate more deeply?",
    allowedFrontEndDomains: ["localhost:3000"],
    parent_site_url: "https://www.ananda.org",
    parent_site_name: "Ananda",
    help_url: "",
    help_text: "Help",
    collectionConfig: {
      master_swami: "Master and Swami",
      whole_library: "All authors",
    },
    includedLibraries: ["Ananda Library"],
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    requireLogin: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    loginImage: "mascot.png",
    header: { logo: "ananda-logo.png", navItems: [] },
    footer: { links: [] },
    queriesPerUserPerDay: 200,
    showSourceContent: true,
    showVoting: true,
    enableModelComparison: true,
    showSourceCountSelector: true,
    temperature: 0.4,
    modelName: "gpt-4o",
    enableGeoAwareness: true,
    feedbackIcon: "mascot.png",
  };

  const mockSiteConfigNoIcon: SiteConfig = {
    ...mockSiteConfig,
    feedbackIcon: undefined,
  };

  const mockSiteConfigDifferentSite: SiteConfig = {
    ...mockSiteConfig,
    siteId: "crystal",
    feedbackIcon: "bot-image.png",
  };

  const mockOnClick = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders feedback button with correct styling", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    const button = screen.getByRole("button", { name: /give feedback/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass(
      "flex",
      "items-center",
      "bg-white",
      "rounded-full",
      "shadow-lg",
      "px-4",
      "py-2",
      "space-x-3"
    );
  });

  it("displays the correct site-specific icon", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    const image = screen.getByAltText("Feedback");
    expect(image).toHaveAttribute("src", "/mascot.png");
  });

  it("uses default icon when feedbackIcon is not set", () => {
    render(<FeedbackButton siteConfig={mockSiteConfigNoIcon} onClick={mockOnClick} />);

    const image = screen.getByAltText("Feedback");
    expect(image).toHaveAttribute("src", "/bot-image.png");
  });

  it("uses correct icon for different sites", () => {
    render(<FeedbackButton siteConfig={mockSiteConfigDifferentSite} onClick={mockOnClick} />);

    const image = screen.getByAltText("Feedback");
    expect(image).toHaveAttribute("src", "/bot-image.png");
  });

  it("displays feedback text", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    // Feedback text should be visible
    expect(screen.getByText("Feedback")).toBeInTheDocument();
    expect(screen.getByText("Feedback")).toHaveClass("text-gray-800", "text-sm", "font-medium", "whitespace-nowrap");
  });

  it("handles image load error gracefully", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    const image = screen.getByAltText("Feedback");

    // Simulate image load error
    fireEvent.error(image);

    // Should fallback to default icon
    expect(image).toHaveAttribute("src", "/bot-image.png");
  });

  it("calls onClick when button is clicked", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    const button = screen.getByRole("button", { name: /give feedback/i });
    fireEvent.click(button);

    expect(mockOnClick).toHaveBeenCalledTimes(1);
  });

  it("has proper accessibility attributes", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    const button = screen.getByRole("button", { name: /give feedback/i });
    expect(button).toHaveAttribute("aria-label", "Give feedback");
  });

  it("handles null siteConfig gracefully", () => {
    render(<FeedbackButton siteConfig={null} onClick={mockOnClick} />);

    const image = screen.getByAltText("Feedback");
    expect(image).toHaveAttribute("src", "/bot-image.png");
  });

  it("includes hover transition effects", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    // Check for hover transition classes
    const button = screen.getByRole("button");
    expect(button).toHaveClass("transition-all", "duration-300", "ease-in-out");
  });

  it("has correct image sizing for pill layout", () => {
    render(<FeedbackButton siteConfig={mockSiteConfig} onClick={mockOnClick} />);

    const image = screen.getByAltText("Feedback");
    expect(image).toHaveClass("w-10", "h-10", "rounded-full", "object-cover", "flex-shrink-0");
  });
});
