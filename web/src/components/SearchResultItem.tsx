import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/router";
import { SearchResult } from "@/types/SearchTypes";
import { highlightQueryTerms } from "@/utils/client/highlightText";
import { getMappedLibraryName, getLibraryUrl } from "@/utils/client/libraryMappings";
import { logEvent } from "@/utils/client/analytics";
import { Modal } from "@/components/ui/Modal";
import { AudioPlayer } from "@/components/AudioPlayer";
import ConceptGraphModal from "@/components/ConceptGraphModal";
import { transformYouTubeUrl } from "@/utils/client/youtubeUtils";
import { Document } from "langchain/document";
import { DocMetadata } from "@/types/DocMetadata";

const WORD_LIMIT = 50;

interface SearchResultItemProps {
  result: SearchResult;
  query: string;
}

export default function SearchResultItem({ result, query }: SearchResultItemProps) {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = useState(false);
  const [showMediaPlayer, setShowMediaPlayer] = useState(false);
  const [showConceptGraph, setShowConceptGraph] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);

  // Truncate content to first N words
  const { truncatedContent, isTruncated } = useMemo(() => {
    const words = result.pageContent.split(/\s+/);
    if (words.length <= WORD_LIMIT) {
      return { truncatedContent: result.pageContent, isTruncated: false };
    }
    return {
      truncatedContent: words.slice(0, WORD_LIMIT).join(" "),
      isTruncated: true,
    };
  }, [result.pageContent]);

  const getSourceIcon = () => {
    switch (result.metadata.type) {
      case "audio":
        return "mic";
      case "youtube":
        return "videocam";
      default:
        return "description";
    }
  };

  const formatSimilarityScore = (score: number): string => {
    return `${Math.round(score * 100)}%`;
  };

  const handleExplainThis = () => {
    logEvent("search_explain_this", "Search", result.metadata.title || "unknown");

    // Build the explanation request query
    const title = result.metadata.title || "Unknown Title";
    const author = result.metadata.author && result.metadata.author !== "Unknown" ? result.metadata.author : null;

    const titleByAuthor = author ? `${title} by ${author}` : title;
    const question = `Give me a brief summary and one clarifying question I could ask next about "${titleByAuthor}".\n\nContent:\n${result.pageContent}`;

    // Navigate to chat with pre-filled query and auto-submit flag
    router.push({
      pathname: "/",
      query: { q: question, submit: "true" },
    });
  };

  // Normalize source URLs (prepend https:// when missing, support relative paths with library base)
  const buildSourceUrl = () => {
    const raw = result.metadata.source?.trim();
    if (!raw) return null;

    // If already absolute
    if (/^https?:\/\//i.test(raw)) return raw;

    // If starts with // (protocol-relative)
    if (/^\/\//.test(raw)) return `https:${raw}`;

    // If starts with / and we have a library base URL, resolve against it
    if (raw.startsWith("/") && getLibraryUrl(result.metadata.library)) {
      try {
        return new URL(raw, getLibraryUrl(result.metadata.library)).toString();
      } catch {
        return `https:${raw}`;
      }
    }

    // Otherwise, treat as domain/path without protocol
    return `https://${raw}`;
  };

  const handleViewSource = () => {
    logEvent("search_view_source", "Search", result.metadata.type || "unknown");

    if (result.metadata.type === "text") {
      const url = buildSourceUrl();
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    }
  };

  const handleOpenMediaPlayer = () => {
    logEvent("search_open_media_player", "Search", result.metadata.type || "unknown");
    setShowMediaPlayer(true);
    setIsVideoPlaying(false);
  };

  const libraryName = getMappedLibraryName(result.metadata.library);
  const libraryUrl = getLibraryUrl(result.metadata.library);

  const toggleYouTubePlayback = useCallback(() => {
    if (!iframeRef.current || !iframeRef.current.contentWindow) {
      return;
    }
    const message = isVideoPlaying
      ? { event: "command", func: "pauseVideo", args: [] }
      : { event: "command", func: "playVideo", args: [] };

    iframeRef.current.contentWindow.postMessage(JSON.stringify(message), "*");
    setIsVideoPlaying((prev) => !prev);
  }, [isVideoPlaying]);

  // Spacebar play/pause for YouTube without needing to click inside the iframe
  useEffect(() => {
    if (!showMediaPlayer || result.metadata.type !== "youtube") return;

    const handleSpaceToggle = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " " && event.key !== "Spacebar") return;

      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        const isFormControl = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
        if (isFormControl || target.isContentEditable) return;
      }

      event.preventDefault();
      toggleYouTubePlayback();
    };

    window.addEventListener("keydown", handleSpaceToggle);
    return () => window.removeEventListener("keydown", handleSpaceToggle);
  }, [showMediaPlayer, result.metadata.type, toggleYouTubePlayback]);

  return (
    <div className="border border-gray-200 rounded-lg p-4 mb-4 hover:shadow-md transition-shadow">
      {/* Header with title, type, and score */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="material-icons text-lg text-gray-500 flex-shrink-0">{getSourceIcon()}</span>
          <h3 className="font-semibold text-lg text-gray-900">{result.metadata.title || "Untitled"}</h3>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
            {formatSimilarityScore(result.score)}
          </span>
        </div>
      </div>

      {/* Author and library info */}
      <div className="flex flex-wrap items-center gap-2 mb-2 text-sm text-gray-600">
        {result.metadata.author && result.metadata.author !== "Unknown" && (
          <span className="italic">by {result.metadata.author}</span>
        )}
        {result.metadata.library && (
          <>
            {result.metadata.author && <span>•</span>}
            {libraryUrl ? (
              <a
                href={libraryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-800 hover:underline"
              >
                {libraryName}
              </a>
            ) : (
              <span>{libraryName}</span>
            )}
          </>
        )}
        {result.metadata.type && (
          <>
            <span>•</span>
            <span className="capitalize">{result.metadata.type}</span>
          </>
        )}
      </div>

      {/* Highlighted content */}
      <div className="mb-3 text-gray-700 leading-relaxed">
        <p>
          {highlightQueryTerms(isExpanded ? result.pageContent : truncatedContent, query)}
          {isTruncated && !isExpanded && "… "}
          {isTruncated && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-blue-600 hover:text-blue-800 hover:underline text-sm font-medium ml-1"
            >
              {isExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </p>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleExplainThis}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm"
        >
          <span className="material-icons text-sm">chat</span>
          Summarize & Ask
        </button>

        {/* Concept Graph button */}
        <button
          onClick={() => setShowConceptGraph(true)}
          className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors text-sm"
          title="Explore related concepts"
        >
          <span className="material-icons text-sm">hub</span>
          Concept Graph
        </button>

        {/* Audio Player button */}
        {result.metadata.type === "audio" && result.metadata.filename && (
          <button
            onClick={handleOpenMediaPlayer}
            className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors text-sm"
          >
            <span className="material-icons text-sm">headphones</span>
            Audio Player
          </button>
        )}

        {/* Video Player button */}
        {result.metadata.type === "youtube" && result.metadata.url && (
          <button
            onClick={handleOpenMediaPlayer}
            className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors text-sm"
          >
            <span className="material-icons text-sm">play_circle</span>
            Video Player
          </button>
        )}

        {/* View Source button (text only) */}
        {result.metadata.type === "text" && result.metadata.source && (
          <button
            onClick={handleViewSource}
            className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors text-sm"
          >
            <span className="material-icons text-sm">open_in_new</span>
            View Source
          </button>
        )}
      </div>

      {/* Media Player Modal */}
      <Modal
        isOpen={showMediaPlayer}
        onClose={() => setShowMediaPlayer(false)}
        title={result.metadata.type === "audio" ? "Audio Player" : "Video Player"}
        className={result.metadata.type === "youtube" ? "max-w-2xl" : "max-w-md"}
      >
        <h3 className="font-medium text-gray-900 mb-4 break-words">{result.metadata.title || "Untitled"}</h3>

        {result.metadata.type === "audio" && result.metadata.filename && showMediaPlayer && (
          <div className="[&_.audio-player]:w-full [&_.audio-player]:md:w-full">
            <AudioPlayer
              key={`search-audio-${showMediaPlayer}`}
              src={result.metadata.filename}
              library={result.metadata.library}
              startTime={result.metadata.start_time ?? 0}
              audioId={`search-audio-${result.metadata.file_hash || result.metadata.filename}`}
              lazyLoad={false}
              isExpanded={true}
              enableGlobalSpaceToggle={showMediaPlayer}
            />
          </div>
        )}

        {result.metadata.type === "youtube" && result.metadata.url && showMediaPlayer && (
          <div className="aspect-video">
            <iframe
              className="h-full w-full rounded-xl"
              src={transformYouTubeUrl(
                result.metadata.url,
                result.metadata.start_time,
                false,
                typeof window !== "undefined" ? window.location.origin : undefined
              )}
              title={result.metadata.title || "YouTube Video"}
              style={{ border: "none" }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              referrerPolicy="no-referrer-when-downgrade"
              sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-presentation allow-pointer-lock"
              allowFullScreen
              ref={iframeRef}
            />
          </div>
        )}
      </Modal>

      {/* Concept Graph Modal */}
      {showConceptGraph && (
        <ConceptGraphModal
          isOpen={showConceptGraph}
          onClose={() => setShowConceptGraph(false)}
          sourceDocs={[
            {
              pageContent: result.pageContent,
              metadata: result.metadata,
            } as Document<DocMetadata>,
          ]}
          query={query}
        />
      )}
    </div>
  );
}
