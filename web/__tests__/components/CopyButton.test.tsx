import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import CopyButton from "../../src/components/CopyButton";
import { copyTextToClipboard } from "../../src/utils/client/clipboard";
import { logEvent } from "../../src/utils/client/analytics";
import { Document } from "langchain/document";
import { DocMetadata } from "../../src/types/DocMetadata";
import { SiteConfig } from "../../src/types/siteConfig";

// Mock the dependencies
jest.mock("../../src/utils/client/clipboard", () => ({
  copyTextToClipboard: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/utils/client/getPublicAudioUrl", () => ({
  getCachedPublicAudioUrl: jest.fn().mockImplementation((filename: string, library?: string) => {
    let path = filename;
    if (library && !filename.includes("/")) {
      path = `${library.toLowerCase()}/${filename}`;
    } else if (library) {
      path = `${library.toLowerCase()}/${filename}`;
    }

    // Properly encode each path segment to match real implementation
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return Promise.resolve(`https://ananda-chatbot.s3.us-west-1.amazonaws.com/public/audio/${encodedPath}`);
  }),
}));

// Cast the mock to the correct type for proper access to mock.calls
const mockedCopyTextToClipboard = copyTextToClipboard as jest.MockedFunction<typeof copyTextToClipboard>;

jest.mock("../../src/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

// Mock environment variable
process.env.NEXT_PUBLIC_BASE_URL = "https://test.com";

describe("CopyButton", () => {
  const mockSources: Document<DocMetadata>[] = [
    {
      pageContent: "test content 1",
      metadata: {
        title: "Test Doc 1",
        type: "text",
        library: "Test Library",
        source: "https://test.com/doc1",
      },
    },
    {
      pageContent: "test content 2",
      metadata: {
        title: "Test Doc 2",
        type: "text",
        library: "Test Library",
      },
    },
    {
      pageContent: "test content 3",
      metadata: {
        title: "Unknown Doc",
        type: "text",
        library: "Test Library",
      },
    },
  ];

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
    showSourceContent: false,
    showVoting: false,
  };

  const mockProps = {
    markdown: "Test markdown",
    answerId: "123",
    question: "Test question",
    siteConfig: null,
    sources: mockSources,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders copy icon by default", () => {
    const { getByTitle } = render(<CopyButton {...mockProps} />);
    const button = getByTitle("Copy answer to clipboard");
    expect(button).toBeInTheDocument();
    expect(button.querySelector(".material-icons")).toHaveTextContent("content_copy");
  });

  it("changes to check icon when clicked", async () => {
    const { getByTitle } = render(<CopyButton {...mockProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      expect(button.querySelector(".material-icons")).toHaveTextContent("check");
    });

    // Wait for icon to change back
    await waitFor(
      () => {
        expect(button.querySelector(".material-icons")).toHaveTextContent("content_copy");
      },
      { timeout: 1100 }
    );
  });

  it("should format audio source with a direct S3 link when filename and library are present", async () => {
    const audioSourceWithFilename: Document<DocMetadata>[] = [
      {
        pageContent: "audio content with filename",
        metadata: {
          title: "Direct Audio Test",
          type: "audio",
          library: "My Treasures", // Mixed case library name
          filename: "audiofile.mp3",
          start_time: 70, // 1:10
        },
      },
    ];
    const props = { ...mockProps, sources: audioSourceWithFilename };
    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];
    expect(callHtml).toContain(
      '<a href="https://ananda-chatbot.s3.us-west-1.amazonaws.com/public/audio/my%20treasures/audiofile.mp3">Direct Audio Test</a> (My Treasures) → 1:10'
    );
  });

  it("should format audio source with a direct S3 link when filename contains a path", async () => {
    const audioSourceWithPathInFilename: Document<DocMetadata>[] = [
      {
        pageContent: "audio content with path in filename",
        metadata: {
          title: "Path Audio Test",
          type: "audio",
          library: "My Lectures",
          filename: "series1/lecture2.mp3",
          start_time: 30,
        },
      },
    ];
    const props = { ...mockProps, sources: audioSourceWithPathInFilename };
    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];
    expect(callHtml).toContain(
      '<a href="https://ananda-chatbot.s3.us-west-1.amazonaws.com/public/audio/my%20lectures/series1/lecture2.mp3">Path Audio Test</a> (My Lectures) → 0:30'
    );
  });

  it("should fall back to metadata.source for audio if filename is not present", async () => {
    const audioSourceWithoutFilename: Document<DocMetadata>[] = [
      {
        pageContent: "audio content without filename",
        metadata: {
          title: "Fallback Audio Test",
          type: "audio",
          library: "Old Collection",
          source: "https://example.com/page-for-audio.html",
          start_time: 90,
        },
      },
    ];
    const props = { ...mockProps, sources: audioSourceWithoutFilename };
    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];
    expect(callHtml).toContain(
      '<a href="https://example.com/page-for-audio.html">Fallback Audio Test</a> (Old Collection) → 1:30'
    );
  });

  it("formats sources correctly with URLs", async () => {
    const { getByTitle } = render(<CopyButton {...mockProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('<a href="https://test.com/doc1">Test Doc 1</a> (Test Library)'),
      true
    );
  });

  it("formats sources correctly without URLs", async () => {
    const { getByTitle } = render(<CopyButton {...mockProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining("Test Doc 2 (Test Library)"), true);
  });

  it("should include YouTube URL when url field is present for YouTube sources", async () => {
    const youtubeSource: Document<DocMetadata>[] = [
      {
        pageContent: "test youtube content",
        metadata: {
          title: "The Healing Power of Silence",
          type: "youtube",
          library: "Ananda Youtube",
          url: "https://www.youtube.com/watch?v=example123",
          start_time: 512, // 8 minutes 32 seconds
        },
      },
    ];

    const props = {
      ...mockProps,
      sources: youtubeSource,
    };

    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    // After implementation, the YouTube URL should be included.
    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const call = mockedCopyTextToClipboard.mock.calls[0][0];
    expect(call).toContain(
      '<a href="https://www.youtube.com/watch?v=example123&t=512">The Healing Power of Silence</a> (Ananda Youtube)'
    );
  });

  it("should correctly format and include start_time for an audio source", async () => {
    const audioSourceWithStartTime: Document<DocMetadata>[] = [
      {
        pageContent: "test audio content",
        metadata: {
          title: "Audio Clip Title",
          type: "audio",
          library: "Audio Library",
          source: "https://example.com/audio.mp3",
          start_time: 125, // 2 minutes 5 seconds
        },
      },
    ];

    const props = {
      ...mockProps,
      sources: audioSourceWithStartTime,
    };

    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const call = mockedCopyTextToClipboard.mock.calls[0][0];
    expect(call).toContain('<a href="https://example.com/audio.mp3">Audio Clip Title</a> (Audio Library) → 2:05');
  });

  it("should correctly format and include start_time with hours for a video source that is youtube type", async () => {
    const videoSourceWithHours: Document<DocMetadata>[] = [
      {
        pageContent: "test video content long",
        metadata: {
          title: "Long Video Title",
          type: "youtube",
          library: "Video Library",
          url: "https://example.com/long_video.mp4",
          start_time: 7505,
        },
      },
    ];

    const props = {
      ...mockProps,
      sources: videoSourceWithHours,
    };

    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const call = mockedCopyTextToClipboard.mock.calls[0][0];
    expect(call).toContain('<a href="https://example.com/long_video.mp4?t=7505">Long Video Title</a> (Video Library)');
  });

  it("should handle start_time of zero correctly for youtube and audio", async () => {
    const sourcesWithZeroStartTime: Document<DocMetadata>[] = [
      {
        pageContent: "test youtube content with zero start",
        metadata: {
          title: "YouTube Zero Start",
          type: "youtube",
          library: "YouTube Library",
          url: "https://www.youtube.com/watch?v=zero_start",
          start_time: 0,
        },
      },
      {
        pageContent: "test audio content with zero start",
        metadata: {
          title: "Audio Zero Start",
          type: "audio",
          library: "Audio Library",
          source: "https://example.com/audio_zero_start.mp3",
          start_time: 0,
        },
      },
      {
        pageContent: "test youtube content without start time",
        metadata: {
          title: "No Start Time Doc (YouTube)",
          type: "youtube",
          library: "Video Library",
          url: "https://example.com/video_no_start",
          // start_time is undefined here
        },
      },
    ];

    const props = {
      ...mockProps,
      sources: sourcesWithZeroStartTime,
    };

    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callText = mockedCopyTextToClipboard.mock.calls[0][0];

    // Check YouTube with start_time: 0
    expect(callText).toContain(
      '<a href="https://www.youtube.com/watch?v=zero_start&t=0">YouTube Zero Start</a> (YouTube Library)'
    );
    const youtubeZeroStartString = callText.split("\n").find((line: string) => line.includes("YouTube Zero Start"));
    expect(youtubeZeroStartString).not.toContain("[");

    // Check Audio with start_time: 0
    expect(callText).toContain(
      '<a href="https://example.com/audio_zero_start.mp3">Audio Zero Start</a> (Audio Library) → 0:00'
    );

    // Check YouTube with undefined start_time (should not have &t= or at)
    expect(callText).toContain(
      '<a href="https://example.com/video_no_start">No Start Time Doc (YouTube)</a> (Video Library)'
    );
    const youtubeNoStartTimeString = callText
      .split("\n")
      .find((line: string) => line.includes("No Start Time Doc (YouTube)"));
    expect(youtubeNoStartTimeString).not.toContain("[");
  });

  it("should not include time parameter or suffix for undefined start_time", async () => {
    const sourcesWithUndefinedStartTime: Document<DocMetadata>[] = [
      {
        pageContent: "test youtube content without start time",
        metadata: {
          title: "No Start Time Doc (YouTube Undefined)",
          type: "youtube",
          library: "Video Library",
          url: "https://example.com/video_no_start_undefined",
          // start_time is undefined here
        },
      },
      {
        pageContent: "test audio content without start time",
        metadata: {
          title: "No Start Time Doc (Audio Undefined)",
          type: "audio",
          library: "Audio Library",
          source: "https://example.com/audio_no_start_undefined.mp3",
          // start_time is undefined here
        },
      },
    ];

    const props = {
      ...mockProps,
      sources: sourcesWithUndefinedStartTime,
    };

    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callContent = mockedCopyTextToClipboard.mock.calls[0][0];

    // Check YouTube with undefined start_time
    expect(callContent).toContain(
      '<a href="https://example.com/video_no_start_undefined">No Start Time Doc (YouTube Undefined)</a> (Video Library)'
    );
    const ytUndefinedString = callContent
      .split("\n")
      .find((line: string) => line.includes("No Start Time Doc (YouTube Undefined)"));
    expect(ytUndefinedString).not.toContain("[");

    // Check Audio with undefined start_time
    expect(callContent).toContain(
      '<a href="https://example.com/audio_no_start_undefined.mp3">No Start Time Doc (Audio Undefined)</a> (Audio Library)'
    );
    const audioUndefinedString = callContent
      .split("\n")
      .find((line: string) => line.includes("No Start Time Doc (Audio Undefined)"));
    expect(audioUndefinedString).not.toContain("[");
  });

  it("should not include start time for non-audio/youtube types even if start_time is present", async () => {
    const nonMediaSourceWithStartTime: Document<DocMetadata>[] = [
      {
        pageContent: "test text content with time",
        metadata: {
          title: "Text Doc With Time",
          type: "text", // Non-media type
          library: "Text Library",
          source: "https://example.com/text_doc",
          start_time: 60, // 1 minute
        },
      },
      {
        pageContent: "test generic video content with time",
        metadata: {
          title: "Generic Video With Time",
          type: "video", // Generic video, should not include time
          library: "Video Library",
          url: "https://example.com/generic_video",
          start_time: 120, // 2 minutes
        },
      },
    ];

    const props = {
      ...mockProps,
      sources: nonMediaSourceWithStartTime,
    };

    const { getByTitle } = render(<CopyButton {...props} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const call = mockedCopyTextToClipboard.mock.calls[0][0];
    expect(call).toContain('<a href="https://example.com/text_doc">Text Doc With Time</a> (Text Library)');

    // Check specifically for the generic video type
    const genericVideoSourceString = call.split("\n").find((line: string) => line.includes("Generic Video With Time"));
    expect(genericVideoSourceString).toContain("(Video Library)");
    expect(genericVideoSourceString).not.toContain("[");
  });

  it('uses "Unknown source" for missing titles', async () => {
    const sourceWithoutTitle: Document<DocMetadata> = {
      pageContent: "test content",
      metadata: {
        title: "", // Empty title will trigger the "Unknown source" fallback
        type: "text",
        library: "Test Library",
      },
    };
    const propsWithoutTitle = {
      ...mockProps,
      sources: [sourceWithoutTitle],
    };
    const { getByTitle } = render(<CopyButton {...propsWithoutTitle} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining("Unknown source (Test Library)"), true);
  });

  it("handles missing library metadata", async () => {
    const sourceWithoutLibrary: Document<DocMetadata> = {
      pageContent: "test content",
      metadata: {
        title: "Test Doc",
        type: "text",
        library: "", // Empty library should be handled gracefully
      },
    };
    const propsWithoutLibrary = {
      ...mockProps,
      sources: [sourceWithoutLibrary],
    };
    const { getByTitle } = render(<CopyButton {...propsWithoutLibrary} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining("Test Doc ()"), true);
  });

  it("skips sources section when hideSources is true", async () => {
    const propsWithHiddenSources = {
      ...mockProps,
      siteConfig: { ...mockSiteConfig, hideSources: true },
    };
    const { getByTitle } = render(<CopyButton {...propsWithHiddenSources} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.not.stringContaining("Sources"), true);
  });

  it('uses "unknown" for undefined answerId in analytics', async () => {
    const propsWithoutId = {
      ...mockProps,
      answerId: undefined,
    };
    const { getByTitle } = render(<CopyButton {...propsWithoutId} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(logEvent).toHaveBeenCalledWith("copy_answer", "UI", "unknown");
  });

  it("includes question and answer in copied content", async () => {
    const { getByTitle } = render(<CopyButton {...mockProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining('<h2 id="question">Question:</h2>'), true);
    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining("<p>Test question</p>"), true);
    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining('<h2 id="answer">Answer:</h2>'), true);
    expect(copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining("<p>Test markdown</p>"), true);
  });

  it("formats 'From:' section with truncated question as hyperlink and site name in parentheses", async () => {
    const longQuestionProps = {
      ...mockProps,
      question: "This is a very long question that should be truncated because it exceeds the maximum length limit",
      siteConfig: mockSiteConfig,
    };

    const { getByTitle } = render(<CopyButton {...longQuestionProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];

    // Should contain truncated question as link text and site name in parentheses
    expect(callHtml).toContain(
      '<a href="https://test.com/share/123">This is a very long question that should be truncated…</a> (Test Site)'
    );
  });

  it("formats 'From:' section with short question as hyperlink and site name in parentheses", async () => {
    const shortQuestionProps = {
      ...mockProps,
      question: "Short question",
      siteConfig: mockSiteConfig,
    };

    const { getByTitle } = render(<CopyButton {...shortQuestionProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];

    // Should contain full question as link text (no truncation) and site name in parentheses
    expect(callHtml).toContain('<a href="https://test.com/share/123">Short question</a> (Test Site)');
  });

  it("truncates question at word boundary when possible", async () => {
    const wordBoundaryProps = {
      ...mockProps,
      question: "This is a question that should be truncated at a word boundary instead of mid-word",
      siteConfig: mockSiteConfig,
    };

    const { getByTitle } = render(<CopyButton {...wordBoundaryProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];

    // Should truncate at word boundary, not mid-word
    expect(callHtml).toContain(
      '<a href="https://test.com/share/123">This is a question that should be truncated at a word…</a> (Test Site)'
    );
    // Should not contain partial words
    expect(callHtml).not.toContain("boundar…");
  });

  it("should properly convert audio sources to HTML links (regression test)", async () => {
    const audioSourceProps = {
      ...mockProps,
      sources: [
        {
          pageContent: "audio content",
          metadata: {
            title: "Spiritual Marriage & Family 8/2/80",
            type: "audio",
            library: "Treasures",
            filename: "Thumb drive from Krishna 7-2024/MP3 2017/sp-marriage-8-2-80.mp3",
            start_time: 1871, // 31:11
          },
        },
      ],
    };

    const { getByTitle } = render(<CopyButton {...audioSourceProps} />);
    const button = getByTitle("Copy answer to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalled();
    const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];

    // This test ensures audio sources with complex filenames are properly converted to HTML links

    // Should NOT contain raw markdown syntax
    expect(callHtml).not.toContain("[Spiritual Marriage & Family 8/2/80](https://");

    // Should contain properly formatted HTML link with encoded URL
    expect(callHtml).toContain(
      '<a href="https://ananda-chatbot.s3.us-west-1.amazonaws.com/public/audio/treasures/Thumb%20drive%20from%20Krishna%207-2024/MP3%202017/sp-marriage-8-2-80.mp3">Spiritual Marriage & Family 8/2/80</a> (Treasures) → 31:11'
    );
  });

  describe("temporary session handling", () => {
    it("should include temporary chat annotation and exclude 'From:' link section for temporary sessions", async () => {
      const temporarySessionProps = {
        ...mockProps,
        temporarySession: true,
        siteConfig: mockSiteConfig,
      };

      const { getByTitle } = render(<CopyButton {...temporarySessionProps} />);
      const button = getByTitle("Copy answer to clipboard");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockedCopyTextToClipboard).toHaveBeenCalled();
      const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];

      // Should contain temporary chat annotation
      expect(callHtml).toContain("<em>Note: This is from a temporary chat session.</em>");

      // Should NOT contain "From:" section with link (showdown adds id attribute)
      expect(callHtml).not.toContain('<h3 id="from">From:</h3>');
      expect(callHtml).not.toContain("https://test.com/share/123");
      expect(callHtml).not.toContain("(Test Site)");
    });

    it("should include 'From:' link section for regular (non-temporary) sessions", async () => {
      const regularSessionProps = {
        ...mockProps,
        temporarySession: false,
        siteConfig: mockSiteConfig,
      };

      const { getByTitle } = render(<CopyButton {...regularSessionProps} />);
      const button = getByTitle("Copy answer to clipboard");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockedCopyTextToClipboard).toHaveBeenCalled();
      const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];

      // Should NOT contain temporary chat annotation
      expect(callHtml).not.toContain("temporary chat session");

      // Should contain "From:" section with link (showdown adds id attribute)
      expect(callHtml).toContain('<h3 id="from">From:</h3>');
      expect(callHtml).toContain("https://test.com/share/123");
      expect(callHtml).toContain("(Test Site)");
    });

    it("should default to regular session behavior when temporarySession is not provided", async () => {
      const defaultProps = {
        ...mockProps,
        siteConfig: mockSiteConfig,
        // temporarySession not provided, should default to false
      };

      const { getByTitle } = render(<CopyButton {...defaultProps} />);
      const button = getByTitle("Copy answer to clipboard");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockedCopyTextToClipboard).toHaveBeenCalled();
      const callHtml = mockedCopyTextToClipboard.mock.calls[0][0];

      // Should NOT contain temporary chat annotation
      expect(callHtml).not.toContain("temporary chat session");

      // Should contain "From:" section with link (showdown adds id attribute)
      expect(callHtml).toContain('<h3 id="from">From:</h3>');
      expect(callHtml).toContain("https://test.com/share/123");
    });
  });
});
