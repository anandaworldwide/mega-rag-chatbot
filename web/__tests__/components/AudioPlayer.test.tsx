import React from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AudioPlayer } from "@/components/AudioPlayer";
import { Document } from "langchain/document";
import { DocMetadata } from "@/types/DocMetadata";
import { logEvent } from "@/utils/client/analytics";
import { getCachedSecureAudioUrl } from "@/utils/client/getSecureAudioUrl";

jest.mock("@/hooks/useAudioPlayer", () => ({
  useAudioPlayer: () => ({
    audioRef: { current: document.createElement("audio") },
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    togglePlayPause: jest.fn(),
    setAudioTime: jest.fn(),
    error: null,
    isSeeking: false,
  }),
}));

jest.mock("@/contexts/AudioContext", () => ({
  useAudioContext: () => ({
    currentlyPlayingId: null,
    setCurrentlyPlayingId: jest.fn(),
  }),
}));

jest.mock("@/utils/client/getSecureAudioUrl", () => ({
  getCachedSecureAudioUrl: jest.fn().mockResolvedValue("https://secure/audio.mp3"),
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

describe("AudioPlayer copy source link", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, "location", {
      value: {
        ...originalLocation,
        origin: "https://chat.example.com",
      },
      writable: true,
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  it("copies deep link to clipboard and shows visual feedback", async () => {
    const sourceDoc: Document<DocMetadata> = {
      pageContent: "",
      metadata: {
        type: "audio",
        file_hash: "hash123",
      } as DocMetadata,
    };

    const onCopySourceLink = jest.fn();

    await act(async () => {
      render(
        <AudioPlayer
          src="s3://audio.mp3"
          startTime={0}
          audioId="audio-1"
          docId="doc-abc"
          sourceDoc={sourceDoc}
          onCopySourceLink={onCopySourceLink}
          lazyLoad
          isExpanded
        />
      );
    });

    const copyButton = await screen.findByLabelText("Copy source link");
    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(getCachedSecureAudioUrl).toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://chat.example.com/share/doc-abc#source-audio-hash123"
    );
    expect(logEvent).toHaveBeenCalledWith("copy_source_link", "Engagement", "audio-1");
    expect(onCopySourceLink).toHaveBeenCalled();
    expect(within(copyButton).getByText("check")).toBeInTheDocument();
  });
});
