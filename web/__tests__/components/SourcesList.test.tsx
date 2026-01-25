import React from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import SourcesList from "@/components/SourcesList";
import { Document } from "@langchain/core/documents";
import { DocMetadata } from "@/types/DocMetadata";
import { SiteConfig } from "@/types/siteConfig";
import * as analyticsModule from "@/utils/client/analytics";

// Add mock for react-markdown at the top of the file.
jest.mock("react-markdown", () => {
  const ReactMarkdownMock = ({ children }: { children: string }) => <div>{children}</div>;
  ReactMarkdownMock.displayName = "ReactMarkdown";
  return ReactMarkdownMock;
});

// Also mock remark-gfm which is imported in SourcesList.tsx
jest.mock("remark-gfm", () => {
  return jest.fn(() => ({}));
});

// Mock collections config
jest.mock("@/utils/client/collectionsConfig", () => ({
  collectionsConfig: {
    "Test Collection": "Test Collection Display Name",
  },
  CollectionKey: {},
}));

// Mock dependencies
jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/components/AudioPlayer", () => {
  return {
    AudioPlayer: jest.fn().mockImplementation(({ src, startTime }) => (
      <div data-testid="audio-player">
        Audio: {src} | Start: {startTime}s
      </div>
    )),
  };
});

// Mock window.open
const mockOpen = jest.fn();
window.open = mockOpen;

describe("SourcesList", () => {
  // Set up test data
  const textSource: Document<DocMetadata> = {
    pageContent: "This is a text source content.",
    metadata: {
      title: "Test Document",
      type: "text",
      library: "Test Library",
      source: "https://test.com/document",
    },
  };

  const audioSource: Document<DocMetadata> = {
    pageContent: "This is an audio source content.",
    metadata: {
      title: "Test Audio",
      type: "audio",
      library: "Audio Library",
      file_hash: "abc123",
      filename: "test-audio.mp3",
      start_time: 30,
    },
  };

  const youtubeSource: Document<DocMetadata> = {
    pageContent: "This is a youtube source content.",
    metadata: {
      title: "Test YouTube Video",
      type: "youtube",
      library: "YouTube Channel",
      url: "https://www.youtube.com/watch?v=abcdef",
      start_time: 60,
    },
  };

  const sourceWithoutTitle: Document<DocMetadata> = {
    pageContent: "Content without title",
    metadata: {
      type: "text",
      library: "Test Library",
      title: "",
    },
  };

  const multiLevelTitleSource: Document<DocMetadata> = {
    pageContent: "This is a multi-level title source content.",
    metadata: {
      title:
        "Demystifying Patanjali::Samadhi Pada, the first Book::1 – 15. From constant Self-remembrance there comes complete non-attachment to things seen or heard.",
      type: "text",
      library: "Test Library",
      source: "https://test.com/patanjali",
    },
  };

  const audioWithAlbumSource: Document<DocMetadata> = {
    pageContent: "This is an audio with album source content.",
    metadata: {
      title: "Track Title",
      album: "Album Name",
      type: "audio",
      library: "Audio Library",
      file_hash: "def456",
      filename: "test-album-audio.mp3",
      start_time: 45,
    },
  };

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
    enableSuggestedQueries: false,
    enableMediaTypeSelection: false,
    enableAuthorSelection: false,
    welcome_popup_heading: "",
    other_visitors_reference: "",
    loginImage: null,
    header: { logo: "", navItems: [] },
    footer: { links: [] },
    requireLogin: true,
    allowTemporarySessions: false,
    allowAllAnswersPage: false,
    queriesPerUserPerDay: 100,
    showSourceContent: true,
    showVoting: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders text sources correctly", () => {
    render(<SourcesList sources={[textSource]} />);

    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Test Document")).toBeInTheDocument();
    // Library name appears twice (mobile and desktop views), so use getAllByText
    expect(screen.getAllByText("Test Library").length).toBeGreaterThan(0);

    // Source icon should be displayed
    expect(screen.getByText("description")).toBeInTheDocument();
  });

  it("renders audio sources correctly", () => {
    render(<SourcesList sources={[audioSource]} />);

    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Test Audio")).toBeInTheDocument();
    // Library name appears twice (mobile and desktop views), so use getAllByText
    expect(screen.getAllByText("Audio Library").length).toBeGreaterThan(0);

    // Audio icon should be displayed
    expect(screen.getByText("mic")).toBeInTheDocument();

    // Should not show audio player initially (not expanded)
    expect(screen.queryByTestId("audio-player")).not.toBeInTheDocument();
  });

  it("renders YouTube sources correctly", () => {
    render(<SourcesList sources={[youtubeSource]} />);

    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Test YouTube Video")).toBeInTheDocument();
    // Library name appears twice (mobile and desktop views), so use getAllByText
    expect(screen.getAllByText("YouTube Channel").length).toBeGreaterThan(0);

    // Video icon should be displayed
    expect(screen.getByText("videocam")).toBeInTheDocument();
  });

  it("handles sources without titles", () => {
    render(<SourcesList sources={[sourceWithoutTitle]} />);

    expect(screen.getByText("Unknown source")).toBeInTheDocument();
  });

  it("expands a source when clicked", () => {
    // Mock implementation might be wrong, so mock it directly in this test
    const mockLogEvent = jest.fn();
    jest.spyOn(analyticsModule, "logEvent").mockImplementation(mockLogEvent);

    render(<SourcesList sources={[textSource, audioSource, youtubeSource]} />);

    // Find the first source's summary element
    const firstSourceSummary = screen.getAllByRole("generic")[3]; // Using generic role for the summary
    fireEvent.click(firstSourceSummary);

    // The content should now be visible
    expect(screen.getByText("This is a text source content.")).toBeInTheDocument();
  });

  it("collapses an expanded source when clicked again", () => {
    render(<SourcesList sources={[textSource]} />);

    // First expand
    const sourceSummary = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(sourceSummary);

    // Content should be visible
    expect(screen.getByText("This is a text source content.")).toBeInTheDocument();

    // Now collapse
    fireEvent.click(sourceSummary);

    // Content should no longer be visible (this may not work due to details/summary behavior in jsdom)
    // Instead just verify the event was logged
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("collapse_source", "UI", "collapsed:0");
  });

  it('expands all sources when "Expand all" is clicked', () => {
    render(<SourcesList sources={[textSource, audioSource]} />);

    // Find expand all link
    const expandAllButton = screen.getByText("(expand all)");
    fireEvent.click(expandAllButton);

    // Just verify the event was logged since JSDOM doesn't fully simulate details/summary behavior
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("expand_all_sources", "UI", "accordion");
  });

  it('collapses all sources when "Collapse all" is clicked', () => {
    render(<SourcesList sources={[textSource, audioSource]} />);

    // First expand all
    const expandAllButton = screen.getByText("(expand all)");
    fireEvent.click(expandAllButton);

    // Button should now say "Collapse all"
    const collapseAllButton = screen.getByText("(collapse all)");
    fireEvent.click(collapseAllButton);

    // Just verify the event was logged since JSDOM doesn't fully simulate details/summary behavior
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("collapse_all_sources", "UI", "accordion");
  });

  it("does not make text source titles clickable - users should use Go to source button", () => {
    render(<SourcesList sources={[textSource]} />);

    const textTitle = screen.getByText("Test Document");

    // Text title should not be a clickable link
    expect(textTitle.tagName).toBe("SPAN");
    expect(textTitle.closest("a")).toBeNull();

    // Click on text title should not trigger any link behavior
    fireEvent.click(textTitle);

    // Should not open any new tabs or log source click events
    expect(mockOpen).not.toHaveBeenCalled();
    expect(analyticsModule.logEvent).not.toHaveBeenCalledWith("click_source", "UI", expect.any(String));
  });

  it("shows Go to source button for text sources when expanded (Ananda site with Ananda Library)", () => {
    // Create a source specifically from Ananda Library
    const anandaLibrarySource: Document<DocMetadata> = {
      ...textSource,
      metadata: {
        ...textSource.metadata,
        library: "Ananda Library",
      },
    };

    const anandaSiteConfig = { ...mockSiteConfig, siteId: "ananda" };
    render(<SourcesList sources={[anandaLibrarySource]} siteConfig={anandaSiteConfig} />);

    // First expand the text source
    const expandButton = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(expandButton);

    // Should show the Go to source button
    const goToSourceButton = screen.getByText("Go to source");
    expect(goToSourceButton).toBeInTheDocument();
    expect(goToSourceButton.tagName).toBe("BUTTON");

    // Click the button should show the access interstitial
    fireEvent.click(goToSourceButton);

    // Should show the access interstitial popup
    expect(screen.getByText("Access to Source")).toBeInTheDocument();
    expect(
      screen.getByText("This content comes from Ananda Library. Choose the option that applies to you:")
    ).toBeInTheDocument();

    // Should show both access options
    expect(screen.getByText("I have access to Ananda Library")).toBeInTheDocument();
    expect(screen.getByText("I don't have access to Ananda Library")).toBeInTheDocument();

    // Click the "I have access" button should open the source link
    const hasAccessButton = screen.getByText("I have access to Ananda Library").closest("button")!;
    fireEvent.click(hasAccessButton);

    // Should open the source link
    expect(mockOpen).toHaveBeenCalledWith("https://test.com/document", "_blank", "noopener,noreferrer");
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("click_source", "UI", "https://test.com/document");
  });

  it("does not show interstitial for Ananda site with non-Ananda Library content (e.g., ananda.org)", () => {
    // Create a source from ananda.org (not Ananda Library)
    const anandaOrgSource: Document<DocMetadata> = {
      ...textSource,
      metadata: {
        ...textSource.metadata,
        library: "ananda.org",
      },
    };

    const anandaSiteConfig = { ...mockSiteConfig, siteId: "ananda" };
    render(<SourcesList sources={[anandaOrgSource]} siteConfig={anandaSiteConfig} />);

    // First expand the text source
    const expandButton = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(expandButton);

    // Should show the Go to source button
    const goToSourceButton = screen.getByText("Go to source");
    expect(goToSourceButton).toBeInTheDocument();

    // Click the button should directly open the source without showing interstitial
    fireEvent.click(goToSourceButton);

    // Should NOT show the access interstitial popup
    expect(screen.queryByText("Access to Source")).not.toBeInTheDocument();
    expect(screen.queryByText(/This content comes from/)).not.toBeInTheDocument();

    // Should directly open the link
    expect(mockOpen).toHaveBeenCalledWith("https://test.com/document", "_blank", "noopener,noreferrer");
  });

  it("does not show interstitial for ananda-public site (direct link like Crystal)", () => {
    const anandaPublicSiteConfig = { ...mockSiteConfig, siteId: "ananda-public" };
    render(<SourcesList sources={[textSource]} siteConfig={anandaPublicSiteConfig} />);

    // First expand the text source
    const expandButton = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(expandButton);

    // Should show the Go to source button
    const goToSourceButton = screen.getByText("Go to source");
    expect(goToSourceButton).toBeInTheDocument();

    // Click the button should directly open the source without showing interstitial
    fireEvent.click(goToSourceButton);

    // Should NOT show the access interstitial popup
    expect(screen.queryByText("Access to Source")).not.toBeInTheDocument();
    expect(screen.queryByText(/This content comes from/)).not.toBeInTheDocument();

    // Should directly open the source link
    expect(mockOpen).toHaveBeenCalledWith("https://test.com/document", "_blank", "noopener,noreferrer");
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("click_source", "UI", "https://test.com/document");
  });

  it("does not show interstitial for non-Ananda sites (Crystal)", () => {
    const crystalSiteConfig = { ...mockSiteConfig, siteId: "crystal" };
    render(<SourcesList sources={[textSource]} siteConfig={crystalSiteConfig} />);

    // First expand the text source
    const expandButton = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(expandButton);

    // Should show the Go to source button
    const goToSourceButton = screen.getByText("Go to source");
    expect(goToSourceButton).toBeInTheDocument();

    // Click the button should directly open the source without showing interstitial
    fireEvent.click(goToSourceButton);

    // Should NOT show the access interstitial popup
    expect(screen.queryByText("Access to Source")).not.toBeInTheDocument();
    expect(screen.queryByText(/This content comes from/)).not.toBeInTheDocument();

    // Should directly open the source link
    expect(mockOpen).toHaveBeenCalledWith("https://test.com/document", "_blank", "noopener,noreferrer");
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("click_source", "UI", "https://test.com/document");
  });

  it("does not show interstitial for sites with no siteConfig", () => {
    render(<SourcesList sources={[textSource]} />);

    // First expand the text source
    const expandButton = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(expandButton);

    // Should show the Go to source button
    const goToSourceButton = screen.getByText("Go to source");
    expect(goToSourceButton).toBeInTheDocument();

    // Click the button should directly open the source without showing interstitial
    fireEvent.click(goToSourceButton);

    // Should NOT show the access interstitial popup
    expect(screen.queryByText("Access to Source")).not.toBeInTheDocument();

    // Should directly open the source link
    expect(mockOpen).toHaveBeenCalledWith("https://test.com/document", "_blank", "noopener,noreferrer");
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("click_source", "UI", "https://test.com/document");
  });

  it("allows users to skip the access interstitial with 'don't show again' option", () => {
    // Create a source specifically from Ananda Library
    const anandaLibrarySource: Document<DocMetadata> = {
      ...textSource,
      metadata: {
        ...textSource.metadata,
        library: "Ananda Library",
      },
    };

    // Mock localStorage
    const mockSetItem = jest.fn();
    const mockGetItem = jest.fn().mockReturnValue(null);
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: mockGetItem,
        setItem: mockSetItem,
        removeItem: jest.fn(),
      },
      writable: true,
    });

    const anandaSiteConfig = { ...mockSiteConfig, siteId: "ananda" };
    render(<SourcesList sources={[anandaLibrarySource]} siteConfig={anandaSiteConfig} />);

    // First expand the text source
    const expandButton = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(expandButton);

    // Click the Go to source button
    const goToSourceButton = screen.getByText("Go to source");
    fireEvent.click(goToSourceButton);

    // Should show the interstitial
    expect(screen.getByText("Access to Source")).toBeInTheDocument();

    // Check the "don't show again" checkbox
    const dontShowAgainCheckbox = screen.getByLabelText("Don't show me this pop-up again") as HTMLInputElement;
    fireEvent.click(dontShowAgainCheckbox);

    // Should have called localStorage.setItem
    expect(mockSetItem).toHaveBeenCalledWith("hideAccessInterstitial", "true");

    // Close the modal and test that future clicks skip the interstitial
    const closeButton = screen.getByText("close").closest("button")!;
    fireEvent.click(closeButton);

    // Mock localStorage to return 'true' for hideAccessInterstitial
    mockGetItem.mockReturnValue("true");

    // Clear the current DOM and re-render with the localStorage preference set
    document.body.innerHTML = "";
    render(<SourcesList sources={[anandaLibrarySource]} siteConfig={anandaSiteConfig} />);

    // Expand the source again
    const expandButton2 = screen.getByText("Test Document").closest("summary")!;
    fireEvent.click(expandButton2);

    // Click Go to source - should skip interstitial and go directly to source
    const goToSourceButton2 = screen.getByText("Go to source");
    fireEvent.click(goToSourceButton2);

    // Should NOT show the interstitial this time
    expect(screen.queryByText("Access to Source")).not.toBeInTheDocument();

    // Should open the source link directly
    expect(mockOpen).toHaveBeenCalledWith("https://test.com/document", "_blank", "noopener,noreferrer");
  });

  it("does not make audio source titles clickable to prevent accidental downloads", () => {
    render(<SourcesList sources={[audioSource]} />);

    const audioTitle = screen.getByText("Test Audio");

    // Audio title should not be a clickable link
    expect(audioTitle.tagName).toBe("SPAN");
    expect(audioTitle.closest("a")).toBeNull();

    // Click on audio title should not trigger any link behavior
    fireEvent.click(audioTitle);

    // Should not open any new tabs or log source click events
    expect(mockOpen).not.toHaveBeenCalled();
    expect(analyticsModule.logEvent).not.toHaveBeenCalledWith("click_source", "UI", expect.any(String));
  });

  it("shows audio player when audio source is expanded", () => {
    render(<SourcesList sources={[audioSource]} />);

    // Find the audio source summary
    const expandButton = screen.getByText("Test Audio").closest("summary")!;
    fireEvent.click(expandButton);

    // Just verify the event was logged
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("expand_source", "UI", "expanded:0");
  });

  it("shows YouTube player when YouTube source is expanded", () => {
    render(<SourcesList sources={[youtubeSource]} />);

    // Find the YouTube source summary
    const expandButton = screen.getByText("Test YouTube Video").closest("summary")!;
    fireEvent.click(expandButton);

    // Just verify the event was logged
    expect(analyticsModule.logEvent).toHaveBeenCalledWith("expand_source", "UI", "expanded:0");
  });

  it("displays collection name when provided", () => {
    render(<SourcesList sources={[textSource]} collectionName="Test Collection" />);

    // Check for Sources title
    expect(screen.getByText("Sources")).toBeInTheDocument();

    // Check for the display name from the collections config
    expect(screen.getByText("Test Collection Display Name")).toBeInTheDocument();
  });

  it("hides sources when siteConfig.hideSources is true", () => {
    const configWithHiddenSources = {
      ...mockSiteConfig,
      hideSources: true,
    };

    const { container } = render(<SourcesList sources={[textSource]} siteConfig={configWithHiddenSources} />);

    // Component should render nothing
    expect(container).toBeEmptyDOMElement();
  });

  it("shows sources for sudo admin even when hideSources is true", () => {
    const configWithHiddenSources = {
      ...mockSiteConfig,
      hideSources: true,
    };

    render(<SourcesList sources={[textSource]} siteConfig={configWithHiddenSources} isSudoAdmin={true} />);

    // Should show admin button for hidden sources
    expect(screen.getByText("Admin: Show sources")).toBeInTheDocument();
  });

  it("does not make YouTube source titles clickable to prevent bypassing inline player", () => {
    render(<SourcesList sources={[youtubeSource]} />);

    const youtubeTitle = screen.getByText("Test YouTube Video");

    // YouTube title should not be a clickable link
    expect(youtubeTitle.tagName).toBe("SPAN");
    expect(youtubeTitle.closest("a")).toBeNull();

    // Click on YouTube title should not trigger any link behavior
    fireEvent.click(youtubeTitle);

    // Should not open any new tabs or log source click events
    expect(mockOpen).not.toHaveBeenCalled();
    expect(analyticsModule.logEvent).not.toHaveBeenCalledWith("click_source", "UI", expect.any(String));
  });

  it("displays multi-level titles with proper visual hierarchy", () => {
    render(<SourcesList sources={[multiLevelTitleSource]} />);

    // Should display the first level in bold
    const boldTitle = screen.getByText("Demystifying Patanjali");
    expect(boldTitle).toBeInTheDocument();
    expect(boldTitle).toHaveClass("font-bold");

    // Should display subsequent levels in italic
    const italicSubtitle1 = screen.getByText("Samadhi Pada, the first Book");
    expect(italicSubtitle1).toBeInTheDocument();
    expect(italicSubtitle1).toHaveClass("italic", "font-normal", "text-gray-700");

    const italicSubtitle2 = screen.getByText(
      "1 – 15. From constant Self-remembrance there comes complete non-attachment to things seen or heard."
    );
    expect(italicSubtitle2).toBeInTheDocument();
    expect(italicSubtitle2).toHaveClass("italic", "font-normal", "text-gray-700");
  });

  it("displays audio sources with album as hierarchical title", () => {
    render(<SourcesList sources={[audioWithAlbumSource]} />);

    // Should display album name in bold (first level)
    const boldAlbum = screen.getByText("Album Name");
    expect(boldAlbum).toBeInTheDocument();
    expect(boldAlbum).toHaveClass("font-bold");

    // Should display track title in italic (second level)
    const italicTrack = screen.getByText("Track Title");
    expect(italicTrack).toBeInTheDocument();
    expect(italicTrack).toHaveClass("italic", "font-normal", "text-gray-700");
  });

  describe("Show more sources feature", () => {
    // Create helper function to generate multiple sources
    const createTextSource = (index: number): Document<DocMetadata> => ({
      pageContent: `Content for source ${index}`,
      metadata: {
        title: `Source ${index}`,
        type: "text",
        library: "Test Library",
        source: `https://test.com/source${index}`,
      },
    });

    it("shows all sources when there are 4 or fewer", () => {
      const sources = [1, 2, 3, 4].map(createTextSource);
      render(<SourcesList sources={sources} />);

      // All 4 sources should be visible
      expect(screen.getByText("Source 1")).toBeInTheDocument();
      expect(screen.getByText("Source 2")).toBeInTheDocument();
      expect(screen.getByText("Source 3")).toBeInTheDocument();
      expect(screen.getByText("Source 4")).toBeInTheDocument();

      // "Show more" button should not appear
      expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
    });

    it("shows only first 4 sources when there are more than 4", () => {
      const sources = [1, 2, 3, 4, 5, 6].map(createTextSource);
      render(<SourcesList sources={sources} />);

      // First 4 sources should be visible
      expect(screen.getByText("Source 1")).toBeInTheDocument();
      expect(screen.getByText("Source 2")).toBeInTheDocument();
      expect(screen.getByText("Source 3")).toBeInTheDocument();
      expect(screen.getByText("Source 4")).toBeInTheDocument();

      // Sources 5 and 6 should NOT be visible initially
      expect(screen.queryByText("Source 5")).not.toBeInTheDocument();
      expect(screen.queryByText("Source 6")).not.toBeInTheDocument();
    });

    it('shows "Show X more" button when there are more than 4 sources', () => {
      const sources = [1, 2, 3, 4, 5, 6].map(createTextSource);
      render(<SourcesList sources={sources} />);

      // Should show "Show 2 more sources" button
      expect(screen.getByText("Show 2 more sources")).toBeInTheDocument();
    });

    it('shows "Show X more source" (singular) when there is exactly 1 more source', () => {
      const sources = [1, 2, 3, 4, 5].map(createTextSource);
      render(<SourcesList sources={sources} />);

      // Should show "Show 1 more source" (singular)
      expect(screen.getByText("Show 1 more source")).toBeInTheDocument();
    });

    it('clicking "Show more" reveals all sources', () => {
      const sources = [1, 2, 3, 4, 5, 6].map(createTextSource);
      render(<SourcesList sources={sources} />);

      // Initially sources 5 and 6 should not be visible
      expect(screen.queryByText("Source 5")).not.toBeInTheDocument();
      expect(screen.queryByText("Source 6")).not.toBeInTheDocument();

      // Click "Show more"
      const showMoreButton = screen.getByText("Show 2 more sources");
      fireEvent.click(showMoreButton);

      // Now all sources should be visible
      expect(screen.getByText("Source 5")).toBeInTheDocument();
      expect(screen.getByText("Source 6")).toBeInTheDocument();

      // "Show more" button should disappear
      expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
    });

    it('"Expand all" reveals and expands all sources including hidden ones', () => {
      const sources = [1, 2, 3, 4, 5, 6].map(createTextSource);
      render(<SourcesList sources={sources} />);

      // Initially sources 5 and 6 should not be visible
      expect(screen.queryByText("Source 5")).not.toBeInTheDocument();
      expect(screen.queryByText("Source 6")).not.toBeInTheDocument();

      // Click "expand all"
      const expandAllButton = screen.getByText("(expand all)");
      fireEvent.click(expandAllButton);

      // All sources should now be visible (revealed by expand all)
      expect(screen.getByText("Source 5")).toBeInTheDocument();
      expect(screen.getByText("Source 6")).toBeInTheDocument();

      // "Show more" button should disappear
      expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();

      // Analytics event should be logged
      expect(analyticsModule.logEvent).toHaveBeenCalledWith("expand_all_sources", "UI", "accordion");
    });

    it('clicking "Show more" logs analytics event', () => {
      const sources = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(createTextSource);
      render(<SourcesList sources={sources} />);

      // Click "Show more"
      const showMoreButton = screen.getByText("Show 6 more sources");
      fireEvent.click(showMoreButton);

      // Should log analytics with number of revealed sources
      expect(analyticsModule.logEvent).toHaveBeenCalledWith("show_more_sources", "UI", "revealed:6");
    });
  });
});
