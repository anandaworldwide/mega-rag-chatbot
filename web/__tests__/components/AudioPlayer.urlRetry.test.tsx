import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AudioPlayer } from "@/components/AudioPlayer";
import { clearAudioUrlCache } from "@/utils/client/getSecureAudioUrl";

const mockTogglePlayPause = jest.fn();

jest.mock("@/hooks/useAudioPlayer", () => ({
  useAudioPlayer: () => ({
    audioRef: { current: document.createElement("audio") },
    isPlaying: false,
    currentTime: 0,
    duration: 60,
    togglePlayPause: mockTogglePlayPause,
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

jest.mock("@/utils/client/tokenManager", () => ({
  getToken: jest.fn().mockResolvedValue("valid-jwt-token"),
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

function mockFetchResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: {
      get: (name: string) => {
        const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
        return match ? headers[match] : null;
      },
    },
  } as Response;
}

async function flushTicks(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(250);
    });
  }
}

function renderPlayer() {
  return render(<AudioPlayer src="missing-talk.mp3" startTime={0} audioId="audio-retry-1" library="treasures" />);
}

describe("AudioPlayer URL fetch retry", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    clearAudioUrlCache();
    jest.useFakeTimers();
    mockTogglePlayPause.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("calls fetch once after a 404 and does not fetch again on later ticks", async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockFetchResponse(404, { message: "Audio file not found" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = renderPlayer();
    try {
      await flushTicks();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Audio file not found/)).toBeInTheDocument();
    } finally {
      view.unmount();
    }
  });

  it("calls fetch once after a 429 and does not fetch again on later ticks", async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockFetchResponse(429, { error: "Too many requests" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = renderPlayer();
    try {
      await flushTicks();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Too many requests, wait a moment/)).toBeInTheDocument();
    } finally {
      view.unmount();
    }
  });

  it("sets the signed URL on success and plays after a play click", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        mockFetchResponse(200, {
          signedUrl: "https://secure.example/audio.mp3",
          contentType: "audio",
          expiresIn: 14400,
        })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = renderPlayer();
    try {
      await flushTicks();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const playButton = screen.getByLabelText("Play audio");
      expect(playButton).not.toBeDisabled();

      await act(async () => {
        fireEvent.click(playButton);
      });

      expect(mockTogglePlayPause).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Audio access error/)).not.toBeInTheDocument();
    } finally {
      view.unmount();
    }
  });

  it("does not fetch again when play is clicked during a 429 cool-down", async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockFetchResponse(429, { error: "Too many requests" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = renderPlayer();
    try {
      await flushTicks();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const playButton = screen.getByLabelText("Play audio");
      await act(async () => {
        fireEvent.click(playButton);
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });
});
