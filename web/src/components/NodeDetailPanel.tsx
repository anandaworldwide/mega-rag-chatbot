import React from "react";
import { GraphNode } from "@/types/ConceptGraph";
import { getMappedLibraryName, getLibraryUrl } from "@/utils/client/libraryMappings";
import { logEvent } from "@/utils/client/analytics";

interface NodeDetailPanelProps {
  node: GraphNode | null;
  onClose: () => void;
  isMobile?: boolean;
}

export default function NodeDetailPanel({ node, onClose, isMobile = false }: NodeDetailPanelProps) {
  if (!node) {
    return null;
  }

  const { metadata } = node;
  const libraryName = getMappedLibraryName(metadata.library);
  const libraryUrl = getLibraryUrl(metadata.library);

  const handleGoToSource = () => {
    if (!metadata.sourceUrl) return;

    logEvent("concept_graph_go_to_source", "ConceptGraph", metadata.title);

    // Ensure URL has protocol
    let fullUrl = metadata.sourceUrl;
    if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
      if (fullUrl.startsWith("//")) {
        fullUrl = `https:${fullUrl}`;
      } else {
        fullUrl = `https://${fullUrl}`;
      }
    }

    window.open(fullUrl, "_blank", "noopener,noreferrer");
  };

  const handleLibraryClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (libraryUrl) {
      logEvent("concept_graph_click_library", "ConceptGraph", metadata.library);
      window.open(libraryUrl, "_blank", "noopener,noreferrer");
    }
  };

  const getContentTypeIcon = () => {
    switch (metadata.contentType) {
      case "audio":
        return "mic";
      case "youtube":
        return "videocam";
      default:
        return "description";
    }
  };

  if (isMobile) {
    // Bottom sheet for mobile
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-xl shadow-2xl max-h-[80vh] overflow-y-auto">
        {/* Handle bar */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-12 h-1 bg-gray-300 rounded-full" />
        </div>

        {/* Close button */}
        <div className="absolute top-3 right-3">
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-2"
            aria-label="Close"
          >
            <span className="material-icons">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 pb-6">
          {/* Header */}
          <div className="flex items-start gap-3 mb-4">
            <span className="material-icons text-2xl text-gray-500 mt-1">{getContentTypeIcon()}</span>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 mb-1">{metadata.title}</h3>
              {metadata.author && metadata.author !== "Unknown" && (
                <p className="text-sm text-gray-600 italic mb-2">by {metadata.author}</p>
              )}
            </div>
          </div>

          {/* Library */}
          {metadata.library && (
            <div className="mb-4">
              {libraryUrl ? (
                <a
                  href={libraryUrl}
                  onClick={handleLibraryClick}
                  className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
                >
                  {libraryName}
                </a>
              ) : (
                <span className="text-sm text-gray-600">{libraryName}</span>
              )}
            </div>
          )}

          {/* Content snippet */}
          <div className="mb-4">
            <p className="text-sm text-gray-700 leading-relaxed">{metadata.snippet}</p>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2">
            {metadata.sourceUrl && (
              <button
                onClick={handleGoToSource}
                className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                <span className="material-icons text-sm">open_in_new</span>
                Go to source
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Slide-in panel for desktop
  return (
    <div className="absolute right-0 top-0 bottom-0 w-96 bg-white border-l border-gray-200 shadow-xl z-10 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 mb-2">
            <span className="material-icons text-lg text-gray-500 mt-1">{getContentTypeIcon()}</span>
            <h3 className="text-lg font-semibold text-gray-900">{metadata.title}</h3>
          </div>
          {metadata.author && metadata.author !== "Unknown" && (
            <p className="text-sm text-gray-600 italic">by {metadata.author}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors ml-2"
          aria-label="Close"
        >
          <span className="material-icons">close</span>
        </button>
      </div>

      {/* Content */}
      <div className="px-6 py-4">
        {/* Library */}
        {metadata.library && (
          <div className="mb-4">
            {libraryUrl ? (
              <a
                href={libraryUrl}
                onClick={handleLibraryClick}
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              >
                {libraryName}
              </a>
            ) : (
              <span className="text-sm text-gray-600">{libraryName}</span>
            )}
          </div>
        )}

        {/* Content snippet */}
        <div className="mb-4">
          <p className="text-sm text-gray-700 leading-relaxed">{metadata.snippet}</p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          {metadata.sourceUrl && (
            <button
              onClick={handleGoToSource}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              <span className="material-icons text-sm">open_in_new</span>
              Go to source
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
