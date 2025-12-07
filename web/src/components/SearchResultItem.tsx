import React from "react";
import { useRouter } from "next/router";
import { SearchResult } from "@/types/SearchTypes";
import { highlightQueryTerms } from "@/utils/client/highlightText";
import { getMappedLibraryName, getLibraryUrl } from "@/utils/client/libraryMappings";
import { logEvent } from "@/utils/client/analytics";

interface SearchResultItemProps {
  result: SearchResult;
  query: string;
}

export default function SearchResultItem({ result, query }: SearchResultItemProps) {
  const router = useRouter();

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

  const handleAskAboutThis = () => {
    logEvent("search_ask_about_this", "Search", result.metadata.title || "unknown");

    // Navigate to chat with pre-filled query
    const question = `Tell me more about: ${result.pageContent.substring(0, 200)}...`;
    router.push({
      pathname: "/",
      query: { q: question },
    });
  };

  const handleViewSource = () => {
    logEvent("search_view_source", "Search", result.metadata.type || "unknown");

    if (result.metadata.type === "text" && result.metadata.source) {
      window.open(result.metadata.source, "_blank", "noopener,noreferrer");
    } else if (result.metadata.type === "youtube" && result.metadata.url) {
      window.open(result.metadata.url, "_blank", "noopener,noreferrer");
    } else if (result.metadata.type === "audio" && result.metadata.filename) {
      // For audio, navigate to chat with the audio context
      router.push({
        pathname: "/",
        query: { q: `Tell me about ${result.metadata.title || "this audio"}` },
      });
    }
  };

  const libraryName = getMappedLibraryName(result.metadata.library);
  const libraryUrl = getLibraryUrl(result.metadata.library);

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
        <p className="line-clamp-3">{highlightQueryTerms(result.pageContent, query)}</p>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleAskAboutThis}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm"
        >
          <span className="material-icons text-sm">chat</span>
          Ask about this
        </button>
        {(result.metadata.source || result.metadata.url || result.metadata.type === "audio") && (
          <button
            onClick={handleViewSource}
            className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors text-sm"
          >
            <span className="material-icons text-sm">open_in_new</span>
            View Source
          </button>
        )}
      </div>
    </div>
  );
}
