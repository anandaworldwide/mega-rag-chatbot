import { Document } from "@langchain/core/documents";
import { DocMetadata } from "@/types/DocMetadata";
import { generateSourceId, generateSourceDeepLink } from "@/utils/client/sourceUtils";

describe("sourceUtils - generateSourceId", () => {
  it("returns audio hash-based ids when file_hash is available", () => {
    const audioDoc: Document<DocMetadata> = {
      pageContent: "",
      metadata: {
        type: "audio",
        file_hash: "abc123hash",
      } as DocMetadata,
    };

    expect(generateSourceId(audioDoc)).toBe("source-audio-abc123hash");
  });

  it("falls back to sanitized filename and timestamp when no file_hash is present", () => {
    const audioDoc: Document<DocMetadata> = {
      pageContent: "",
      metadata: {
        type: "audio",
        filename: "Bhaktan+-+Talk.mp3",
        start_time: 123.45,
      } as DocMetadata,
    };

    expect(generateSourceId(audioDoc)).toBe("source-audio-Bhaktan---Talk-mp3-123-45");
  });

  it("creates deterministic IDs for YouTube sources including start time", () => {
    const youtubeDoc: Document<DocMetadata> = {
      pageContent: "",
      metadata: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        start_time: 45.8,
      } as DocMetadata,
    };

    expect(generateSourceId(youtubeDoc)).toBe("source-youtube-dQw4w9WgXcQ-45");
  });

  it("builds text source ids using title, library and source metadata", () => {
    const textDoc: Document<DocMetadata> = {
      pageContent: "",
      metadata: {
        type: "text",
        title: "The Wisdom of Yogananda",
        library: "Crystal Clarity",
        source: "https://example.com/articles/wisdom?ref=chatbot",
      } as DocMetadata,
    };

    expect(generateSourceId(textDoc)).toBe("source-text-the-wisdom-of-yogananda-crystal-clarity-https---ex");
  });
});

describe("sourceUtils - generateSourceDeepLink", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      value: {
        ...originalLocation,
        origin: "https://chat.example.com",
      },
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  it("builds share URLs with generated source ids", () => {
    const doc: Document<DocMetadata> = {
      pageContent: "",
      metadata: {
        type: "audio",
        file_hash: "hash999",
      } as DocMetadata,
    };

    expect(generateSourceDeepLink("doc-123", doc)).toBe("https://chat.example.com/share/doc-123#source-audio-hash999");
  });
});
