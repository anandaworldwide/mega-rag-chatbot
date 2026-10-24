// This component renders an audio player with play/pause controls, a seek bar,
// and time display. It supports lazy loading and handles audio playback states.

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { useAudioContext } from "@/contexts/AudioContext";
import { logEvent } from "@/utils/client/analytics";
import { getCachedSecureAudioUrl } from "@/utils/client/getSecureAudioUrl";
import { generateSourceDeepLink, generateSourceId } from "@/utils/client/sourceUtils";
import { Document } from "@langchain/core/documents";
import { DocMetadata } from "@/types/DocMetadata";

const RATE_LIMIT_COOLDOWN_MS = 10 * 1000;

function getUrlErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Failed to load audio";
  if (message === "Audio file not found" || /\b404\b/.test(message)) {
    return "Audio file not found";
  }
  if (message.includes("Too many requests") || /\b429\b/.test(message)) {
    return "Too many requests, wait a moment";
  }
  return message;
}

function getRetryAfterMs(error: unknown): number | null {
  if (error && typeof error === "object" && "retryAfterMs" in error) {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

interface AudioPlayerProps {
  src: string;
  startTime: number;
  audioId: string;
  lazyLoad?: boolean;
  isExpanded?: boolean;
  library?: string; // Add library property for path resolution
  docId?: string;
  sourceDoc?: Document<DocMetadata>; // Source document for deep linking
  sourceLinkCopied?: string | null; // Source ID that was copied (for visual feedback)
  onCopySourceLink?: () => void; // Callback when link is copied
  enableGlobalSpaceToggle?: boolean; // Allow spacebar to toggle play/pause (e.g., in modal overlays)
}

// Loading spinner component for visual feedback during audio loading
export const LoadingSpinner = () => (
  <div className="flex justify-center items-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
  </div>
);

export function AudioPlayer({
  src,
  startTime,
  audioId,
  lazyLoad = false,
  isExpanded = false,
  library,
  docId,
  sourceDoc,
  sourceLinkCopied,
  onCopySourceLink,
  enableGlobalSpaceToggle = false,
}: AudioPlayerProps) {
  const [isLoaded, setIsLoaded] = useState(!lazyLoad);
  const [secureAudioUrl, setSecureAudioUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const rateLimitedUntilRef = useRef(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { currentlyPlayingId, setCurrentlyPlayingId } = useAudioContext();
  const [error, setError] = useState<string | null>(null);

  const startRateLimitCoolDown = useCallback((waitMs: number) => {
    rateLimitedUntilRef.current = Date.now() + waitMs;
    setIsCoolingDown(true);
    if (cooldownTimerRef.current !== null) {
      clearTimeout(cooldownTimerRef.current);
    }
    cooldownTimerRef.current = setTimeout(() => {
      rateLimitedUntilRef.current = 0;
      setIsCoolingDown(false);
      cooldownTimerRef.current = null;
    }, waitMs);
  }, []);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current !== null) {
        clearTimeout(cooldownTimerRef.current);
      }
    };
  }, []);

  // Custom hook for managing audio playback
  const {
    audioRef,
    isPlaying,
    currentTime,
    duration,
    togglePlayPause,
    setAudioTime,
    error: audioError,
    isSeeking,
  } = useAudioPlayer({
    src: secureAudioUrl, // Use secure URL instead of direct S3 URL
    startTime,
  });

  // Fetch the signed URL. Do not start a new fetch when the last fetch failed.
  const fetchSecureAudioUrl = useCallback(async () => {
    if (!src) {
      setUrlError("No audio source provided");
      return;
    }

    // After HTTP 429, wait before a new fetch.
    if (Date.now() < rateLimitedUntilRef.current) {
      setUrlError("Too many requests, wait a moment");
      return;
    }

    setIsLoadingUrl(true);
    setUrlError(null);

    try {
      const url = await getCachedSecureAudioUrl(src, library, docId);
      setSecureAudioUrl(url);
      logEvent("audio_url_fetch_success", "Engagement", audioId);
    } catch (error) {
      const errorMessage = getUrlErrorMessage(error);
      setUrlError(errorMessage);
      if (errorMessage === "Too many requests, wait a moment") {
        startRateLimitCoolDown(getRetryAfterMs(error) ?? RATE_LIMIT_COOLDOWN_MS);
      }
      console.error("Failed to fetch secure audio URL:", error);
      logEvent("audio_url_fetch_error", "Error", `${audioId}:${errorMessage}`);
    } finally {
      setIsLoadingUrl(false);
    }
  }, [src, library, docId, audioId, startRateLimitCoolDown]);

  // Load the signed URL on mount or when the player opens.
  // A failed fetch sets urlError, so this effect does not run again.
  useEffect(() => {
    if ((!lazyLoad || isExpanded) && !secureAudioUrl && !isLoadingUrl && !urlError) {
      fetchSecureAudioUrl();
      setIsLoaded(true);
    }
  }, [lazyLoad, isExpanded, secureAudioUrl, isLoadingUrl, urlError, fetchSecureAudioUrl]);

  // Pause this audio if another audio starts playing
  useEffect(() => {
    if (currentlyPlayingId && currentlyPlayingId !== audioId && isPlaying) {
      togglePlayPause();
    }
  }, [currentlyPlayingId, audioId, isPlaying, togglePlayPause]);

  // Format time in HH:MM:SS or MM:SS format
  const formatTime = (time: number) => {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    return hours > 0
      ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
      : `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // A play click can start one more fetch after a failure.
  const handleTogglePlayPause = useCallback(async () => {
    if (!secureAudioUrl && !isLoadingUrl) {
      await fetchSecureAudioUrl();
      return;
    }

    if (secureAudioUrl && isLoaded) {
      // Only toggle if loaded and URL exists
      if (!isPlaying) {
        setCurrentlyPlayingId(audioId);
        logEvent("play_audio", "Engagement", audioId);
      } else {
        setCurrentlyPlayingId(null);
        logEvent("pause_audio", "Engagement", audioId);
      }
      togglePlayPause();
    }
  }, [
    audioId,
    fetchSecureAudioUrl,
    isLoaded,
    isLoadingUrl,
    isPlaying,
    secureAudioUrl,
    setCurrentlyPlayingId,
    togglePlayPause,
  ]);

  // Enable spacebar play/pause when requested (e.g., modal overlay)
  useEffect(() => {
    if (!enableGlobalSpaceToggle) return;

    const handleSpaceToggle = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " " && event.key !== "Spacebar") return;

      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        const isFormControl = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
        if (isFormControl || target.isContentEditable) return;
      }

      event.preventDefault(); // Prevent page scroll
      handleTogglePlayPause();
    };

    window.addEventListener("keydown", handleSpaceToggle);
    return () => window.removeEventListener("keydown", handleSpaceToggle);
  }, [enableGlobalSpaceToggle, handleTogglePlayPause]);

  // Handle seek bar change
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setAudioTime(newTime);
    logEvent("seek_audio", "Engagement", `${audioId}:${newTime}`);
  };

  // Handle audio playback errors (from useAudioPlayer hook)
  useEffect(() => {
    if (audioError) {
      logEvent("audio_playback_error", "Error", `${audioId}:${audioError}`);
    }
  }, [audioError, audioId]);

  // Handle download button click
  const handleDownload = () => {
    if (secureAudioUrl) {
      // Pause playback if currently playing
      if (isPlaying) {
        togglePlayPause();
        setCurrentlyPlayingId(null);
      }

      // Create a temporary link element for secure download (mobile Safari compatible)
      const link = document.createElement("a");
      link.href = secureAudioUrl;
      link.download = src || "audio.mp3";
      link.target = "_blank"; // Open download in new tab
      link.rel = "noopener noreferrer"; // Security best practice
      link.style.display = "none";

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Log the download attempt
      logEvent("download_audio", "Engagement", audioId);
    }
  };

  // Local state for link copy feedback
  const [localLinkCopied, setLocalLinkCopied] = useState(false);

  // Handle copy source link button click
  const handleCopySourceLink = async () => {
    if (!docId || !sourceDoc) {
      return;
    }

    try {
      const deepLink = generateSourceDeepLink(docId, sourceDoc);
      await navigator.clipboard.writeText(deepLink);
      logEvent("copy_source_link", "Engagement", audioId);

      // Show local feedback immediately
      setLocalLinkCopied(true);

      // Clear feedback after 1.5 seconds
      setTimeout(() => {
        setLocalLinkCopied(false);
      }, 1500);

      // Notify parent component (for any other purposes)
      if (onCopySourceLink) {
        onCopySourceLink();
      }
    } catch (error) {
      console.error("Failed to copy source link:", error);
      logEvent("copy_source_link_error", "Error", audioId);
    }
  };

  // Determine if this source link was copied (for visual feedback)
  // Use local state for immediate feedback, fallback to parent state
  const sourceId = sourceDoc ? generateSourceId(sourceDoc) : null;
  const isLinkCopied = localLinkCopied || sourceLinkCopied === sourceId;

  const hasPlaybackError = !!error || !!audioError;
  const isPlayDisabled = isLoadingUrl || isSeeking || hasPlaybackError || isCoolingDown;
  const isDisabled = !secureAudioUrl || isPlayDisabled || !!urlError;

  return (
    <div className="audio-player bg-gray-100 rounded-xl w-full md:w-1/2">
      <audio
        ref={audioRef}
        preload="metadata"
        onLoadedMetadata={() => {
          setAudioTime(startTime);
          logEvent("audio_loaded", "Engagement", audioId);
        }}
        onEnded={() => logEvent("audio_completed", "Engagement", audioId)}
        onError={() => {
          setError("Failed to load audio. Please try again.");
          logEvent("audio_load_error", "Error", audioId);
        }}
      />

      {/* Error display */}
      {error && <div className="text-red-500 mb-1 text-sm px-2">{error}</div>}
      {audioError && <div className="text-red-500 mb-1 text-sm px-2">{audioError}</div>}
      {urlError && <div className="text-red-500 mb-1 text-sm px-2">Audio access error: {urlError}</div>}

      {/* Loading indicator */}
      {isLoadingUrl && (
        <div className="text-blue-500 mb-1 text-sm px-2 flex items-center">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500 mr-2"></div>
          Loading audio...
        </div>
      )}

      <div className="flex items-center justify-between px-2">
        <button
          onClick={handleTogglePlayPause}
          className={`text-blue-500 p-1 rounded-full hover:bg-blue-100 focus:outline-none ${
            isPlayDisabled ? "opacity-50 cursor-not-allowed" : ""
          }`}
          disabled={isPlayDisabled}
          aria-label={isPlaying ? "Pause audio" : "Play audio"}
        >
          <span className="material-icons text-2xl">
            {isLoadingUrl ? "hourglass_empty" : isPlaying ? "pause" : "play_arrow"}
          </span>
        </button>
        <div className="text-xs">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>
        <div className="flex items-center gap-1">
          {docId && sourceDoc && (
            <button
              onClick={handleCopySourceLink}
              className={`p-1 rounded-full hover:bg-gray-200 focus:outline-none ${
                isDisabled ? "opacity-50 cursor-not-allowed" : ""
              } ${isLinkCopied ? "text-black" : "text-gray-500"}`}
              disabled={isDisabled}
              aria-label="Copy source link"
              title="Copy link to this source"
            >
              <span className="material-icons text-2xl">{isLinkCopied ? "check" : "link"}</span>
            </button>
          )}
          <button
            onClick={handleDownload}
            className={`text-gray-500 p-1 rounded-full hover:bg-gray-200 focus:outline-none ${
              isDisabled ? "opacity-50 cursor-not-allowed" : ""
            }`}
            disabled={isDisabled}
            aria-label="Download audio"
          >
            <span className="material-icons text-2xl">download</span>
          </button>
        </div>
      </div>
      <div className="px-2 pb-2">
        <input
          type="range"
          min={0}
          max={duration}
          value={currentTime}
          onChange={handleSeek}
          className="w-full"
          disabled={isDisabled}
          aria-label="Audio playback position"
        />
      </div>
    </div>
  );
}
