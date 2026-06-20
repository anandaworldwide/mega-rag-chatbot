/**
 * FilterDropdown Component
 *
 * This component renders a dropdown menu for content filtering options:
 * - Media type checkboxes (text, audio, video) if enabled
 * - Author/collection radio buttons if enabled
 * - Library/content collection checkboxes if enabled
 *
 * Split from SearchOptionsDropdown to separate content filters from AI settings.
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { SiteConfig } from "@/types/siteConfig";
import {
  getEnableMediaTypeSelection,
  getEnableAuthorSelection,
  getEnabledMediaTypes,
  getCollectionsConfig,
  getDefaultCollectionKey,
} from "@/utils/client/siteConfig";
import { logEvent } from "@/utils/client/analytics";
import { useLibraryStats } from "@/hooks/useLibraryStats";

interface FilterDropdownProps {
  siteConfig: SiteConfig | null;
  mediaTypes: { text: boolean; audio: boolean; youtube: boolean };
  handleMediaTypeChange: (type: "text" | "audio" | "youtube") => void;
  collection: string;
  handleCollectionChange: (newCollection: string) => void;
  selectedLibraries: string[];
  handleLibraryChange: (library: string) => void;
  sourceCount: number;
  setSourceCount: (count: number) => void;
}

export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  siteConfig,
  mediaTypes,
  handleMediaTypeChange,
  collection,
  handleCollectionChange,
  selectedLibraries = [],
  handleLibraryChange,
  sourceCount,
  setSourceCount,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);
  const [showControlsInfo, setShowControlsInfo] = useState(false);
  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Fetch library stats
  const { stats } = useLibraryStats(siteConfig);

  // Get configuration options from siteConfig
  const showMediaTypeSelection = getEnableMediaTypeSelection(siteConfig);
  const showAuthorSelection = getEnableAuthorSelection(siteConfig);
  const enabledMediaTypes = getEnabledMediaTypes(siteConfig);
  const collectionsConfig = getCollectionsConfig(siteConfig);

  // Get available libraries and check if we should show library selector
  const availableLibraries = (siteConfig?.includedLibraries || []).slice().sort((a, b) => {
    const nameA = typeof a === "string" ? a : a.name;
    const nameB = typeof b === "string" ? b : b.name;
    return nameA.toLowerCase().localeCompare(nameB.toLowerCase());
  });
  const showLibrarySelection = availableLibraries.length > 1;

  // Check if extra sources option should be shown
  const showSourceCountSelector = siteConfig?.showSourceCountSelector ?? false;

  // Check if any filter options are available
  const hasAnyFilters =
    showMediaTypeSelection || showAuthorSelection || showLibrarySelection || showSourceCountSelector;

  // Determine if options have been changed from defaults
  const isModified = useMemo((): boolean => {
    const siteEnabledMediaTypes = getEnabledMediaTypes(siteConfig);
    const defaultMediaTypes = {
      text: siteEnabledMediaTypes.includes("text"),
      audio: siteEnabledMediaTypes.includes("audio"),
      youtube: siteEnabledMediaTypes.includes("youtube"),
    };

    const defaultCollection = getDefaultCollectionKey(siteConfig);

    // Check media types (treat "none checked" as "all enabled checked")
    const mediaTypesChanged =
      showMediaTypeSelection &&
      (() => {
        const normalizeMediaTypes = (types: { text: boolean; audio: boolean; youtube: boolean }) => {
          const checkedCount = Object.values(types).filter(Boolean).length;
          if (checkedCount === 0) {
            return {
              text: siteEnabledMediaTypes.includes("text"),
              audio: siteEnabledMediaTypes.includes("audio"),
              youtube: siteEnabledMediaTypes.includes("youtube"),
            };
          }
          return types;
        };

        const normalizedCurrent = normalizeMediaTypes(mediaTypes);
        const normalizedDefault = normalizeMediaTypes(defaultMediaTypes);

        return (
          normalizedCurrent.text !== normalizedDefault.text ||
          normalizedCurrent.audio !== normalizedDefault.audio ||
          normalizedCurrent.youtube !== normalizedDefault.youtube
        );
      })();

    const collectionChanged = showAuthorSelection && collection !== defaultCollection;

    const defaultLibraries = availableLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
    const librariesChanged =
      showLibrarySelection &&
      (selectedLibraries.length !== defaultLibraries.length ||
        !selectedLibraries.every((lib) => defaultLibraries.includes(lib)));

    // Check if source count has been changed from default
    const defaultSourceCount = siteConfig?.defaultNumSources || 4;
    const sourceCountChanged = showSourceCountSelector && sourceCount !== defaultSourceCount;

    return mediaTypesChanged || collectionChanged || librariesChanged || sourceCountChanged;
  }, [
    showMediaTypeSelection,
    showAuthorSelection,
    showLibrarySelection,
    showSourceCountSelector,
    mediaTypes,
    collection,
    selectedLibraries,
    sourceCount,
    siteConfig,
    availableLibraries,
  ]);

  // Helper function to format large numbers
  const formatCount = (count: number): string => {
    if (count >= 1000) {
      return `${Math.round(count / 1000)}k`;
    }
    return count.toLocaleString();
  };

  // Helper function to get collection count
  const getCollectionCount = (collectionKey: string): number => {
    if (!stats?.authors) return 0;

    if (collectionKey === "auto") {
      return 0;
    }

    if (collectionKey === "master_swami") {
      return (stats.authors["Paramhansa Yogananda"] || 0) + (stats.authors["Swami Kriyananda"] || 0);
    }

    if (collectionKey === "whole_library") {
      if (stats.authors["whole_library"] !== undefined) {
        return stats.authors["whole_library"];
      }
      return Object.entries(stats.authors)
        .filter(([key]) => key !== "whole_library")
        .reduce((sum, [, count]) => sum + count, 0);
    }

    return 0;
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isClickOnButton = buttonRef.current && buttonRef.current.contains(target);
      const isClickInDropdown = dropdownMenuRef.current && dropdownMenuRef.current.contains(target);

      if (!isClickOnButton && !isClickInDropdown) {
        setIsOpen(false);
        setIsPositioned(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Close dropdown on Escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (showControlsInfo) {
          event.stopPropagation();
          setShowControlsInfo(false);
          return;
        }
        if (isOpen) {
          setIsOpen(false);
          setIsPositioned(false);
          buttonRef.current?.focus();
        }
      }
    };

    if (isOpen || showControlsInfo) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, showControlsInfo]);

  // Calculate dropdown position
  const calculateDropdownPosition = () => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 4;
    const dropdownWidth = 300;

    let top = rect.bottom + gap;
    const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 10);

    setDropdownPosition({ top: Math.max(10, top), left: Math.max(10, left) });

    requestAnimationFrame(() => {
      const height = dropdownMenuRef.current?.offsetHeight || 0;
      const bottom = top + height;
      if (bottom > window.innerHeight - 10) {
        top = Math.max(10, rect.top - height - gap);
        setDropdownPosition({ top, left });
      }
      setIsPositioned(true);
    });
  };

  // Recalculate position on open/resize/scroll
  useEffect(() => {
    const handleUpdate = () => {
      if (isOpen) calculateDropdownPosition();
    };

    if (isOpen) {
      calculateDropdownPosition();
      window.addEventListener("resize", handleUpdate);
      window.addEventListener("scroll", handleUpdate, true);
    }

    return () => {
      window.removeEventListener("resize", handleUpdate);
      window.removeEventListener("scroll", handleUpdate, true);
    };
  }, [isOpen]);

  const toggleDropdown = () => {
    if (isOpen) {
      setIsPositioned(false);
    }
    setIsOpen(!isOpen);
    logEvent(isOpen ? "close_filter_options" : "open_filter_options", "UI", "dropdown_toggle");
  };

  const handleMediaTypeToggle = (type: "text" | "audio" | "youtube") => {
    handleMediaTypeChange(type);
    logEvent(`toggle_media_type_${type}`, "Settings", mediaTypes[type] ? "disabled" : "enabled");
  };

  const handleCollectionSelect = (newCollection: string) => {
    if (newCollection !== collection) {
      handleCollectionChange(newCollection);
      logEvent("change_collection", "Settings", newCollection);
    }
  };

  const handleLibraryToggle = (library: string) => {
    handleLibraryChange(library);
    const isCurrentlySelected = selectedLibraries.includes(library);
    const newSelection = isCurrentlySelected
      ? selectedLibraries.filter((lib) => lib !== library)
      : [...selectedLibraries, library];

    if (newSelection.length > 0) {
      const status = isCurrentlySelected ? "disabled" : "enabled";
      logEvent("toggle_library", "Settings", `${library}:${status}`, newSelection.length);
    }
  };

  const handleSourceCountToggle = (checked: boolean) => {
    const defaultSources = siteConfig?.defaultNumSources || 4;
    const extraSources = 10;
    const newSourceCount = checked ? extraSources : defaultSources;

    setSourceCount(newSourceCount);
    logEvent("toggle_extra_sources", "Settings", checked ? "enabled" : "disabled");
  };

  const handleResetOptions = () => {
    const siteEnabledMediaTypes = getEnabledMediaTypes(siteConfig);
    const defaultMediaTypes = {
      text: siteEnabledMediaTypes.includes("text"),
      audio: siteEnabledMediaTypes.includes("audio"),
      youtube: siteEnabledMediaTypes.includes("youtube"),
    };

    // Reset media types
    if (showMediaTypeSelection) {
      (["text", "audio", "youtube"] as const).forEach((type) => {
        if (mediaTypes[type] !== defaultMediaTypes[type]) {
          handleMediaTypeChange(type);
        }
      });
      localStorage.removeItem("searchMediaTypes");
    }

    // Reset collection
    const defaultCollection = getDefaultCollectionKey(siteConfig);
    if (showAuthorSelection && collection !== defaultCollection) {
      handleCollectionChange(defaultCollection);
    }

    // Reset libraries
    if (showLibrarySelection) {
      const defaultLibraries = availableLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
      const librariesToSelect = defaultLibraries.filter((lib) => !selectedLibraries.includes(lib));
      const librariesToDeselect = selectedLibraries.filter((lib) => !defaultLibraries.includes(lib));

      librariesToSelect.forEach((lib) => handleLibraryChange(lib));
      librariesToDeselect.forEach((lib) => handleLibraryChange(lib));
      localStorage.removeItem("selectedLibraries");
    }

    // Reset source count
    const defaultSourceCount = siteConfig?.defaultNumSources || 4;
    if (showSourceCountSelector && sourceCount !== defaultSourceCount) {
      handleSourceCountToggle(false);
    }
    localStorage.removeItem("useExtraSources");

    logEvent("reset_filter_options", "Settings", "reset_to_defaults");
  };

  // Don't render if no filter options are available
  if (!hasAnyFilters) {
    return null;
  }

  return (
    <div className="relative">
      {/* Dropdown Button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleDropdown}
        className="relative flex items-center justify-center p-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="Content filters"
        title="Content Filters"
      >
        <span className="relative inline-block" style={{ width: "20px", height: "20px" }}>
          {isModified && (
            <span
              className="absolute inset-0 rounded-full transition-all duration-200"
              style={{ backgroundColor: "#fff1c2" }}
            />
          )}
          <span
            className={`material-icons text-base absolute inset-0 flex items-center justify-center transition-all duration-200 ${
              isModified ? "text-gray-700" : "text-gray-500"
            }`}
          >
            filter_list
          </span>
        </span>
      </button>

      {/* Dropdown Menu */}
      {isOpen &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            ref={dropdownMenuRef}
            className="fixed bg-white border border-gray-200 rounded-xl shadow-lg z-[90] max-h-[calc(100vh-8rem)] overflow-y-auto transition-opacity duration-75"
            style={{
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              width: "300px",
              opacity: isPositioned ? 1 : 0,
            }}
          >
            <div className="p-4 space-y-4">
              {/* Header with info button */}
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium text-gray-900">Content Filters</h3>
                <button
                  type="button"
                  onClick={() => {
                    setShowControlsInfo(true);
                    logEvent("show_controls_info", "UI", "info_button");
                  }}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                  aria-label="Filter options information"
                >
                  <span className="material-icons text-lg">info_outline</span>
                </button>
              </div>

              {/* Media Type Selection */}
              {showMediaTypeSelection && enabledMediaTypes.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-900 mb-2">Media Types</h4>
                  <div className="space-y-2">
                    {enabledMediaTypes.includes("text") && (
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={mediaTypes.text}
                          onChange={() => handleMediaTypeToggle("text")}
                          className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">
                          Writings
                          {stats?.mediaTypes?.text && (
                            <span className="text-gray-400 ml-1">({formatCount(stats.mediaTypes.text)})</span>
                          )}
                        </span>
                      </label>
                    )}
                    {enabledMediaTypes.includes("audio") && (
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={mediaTypes.audio}
                          onChange={() => handleMediaTypeToggle("audio")}
                          className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">
                          Audio
                          {stats?.mediaTypes?.audio && (
                            <span className="text-gray-400 ml-1">({formatCount(stats.mediaTypes.audio)})</span>
                          )}
                        </span>
                      </label>
                    )}
                    {enabledMediaTypes.includes("youtube") && (
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={mediaTypes.youtube}
                          onChange={() => handleMediaTypeToggle("youtube")}
                          className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">
                          Video
                          {stats?.mediaTypes?.youtube && (
                            <span className="text-gray-400 ml-1">({formatCount(stats.mediaTypes.youtube)})</span>
                          )}
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              )}

              {/* Author/Collection Selection */}
              {showAuthorSelection && Object.keys(collectionsConfig).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-900 mb-2">Authors</h4>
                  <div className="space-y-2">
                    {Object.entries(collectionsConfig).map(([key, value]) => {
                      const count = getCollectionCount(key);
                      return (
                        <label key={key} className="flex items-center">
                          <input
                            type="radio"
                            name="collection"
                            value={key}
                            checked={collection === key}
                            onChange={() => handleCollectionSelect(key)}
                            className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                          />
                          <span className="text-sm text-gray-700">
                            {value}
                            {count > 0 && <span className="text-gray-400 ml-1">({formatCount(count)})</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Library Selection */}
              {showLibrarySelection && (
                <div>
                  <h4 className="text-sm font-medium text-gray-900 mb-2">Content Collections</h4>
                  <div className="space-y-2">
                    {availableLibraries.map((lib) => {
                      const libraryName = typeof lib === "string" ? lib : lib.name;
                      const isLastSelected = selectedLibraries.length === 1 && selectedLibraries.includes(libraryName);
                      return (
                        <label key={libraryName} className="flex items-center cursor-pointer py-1">
                          <input
                            type="checkbox"
                            checked={selectedLibraries.includes(libraryName)}
                            onChange={() => handleLibraryToggle(libraryName)}
                            disabled={isLastSelected}
                            className="mr-2 h-5 w-5 text-blue-600 focus:ring-blue-500 border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          <span className={`text-sm ${isLastSelected ? "text-gray-500" : "text-gray-700"}`}>
                            {libraryName}
                            {stats?.libraries?.[libraryName] && (
                              <span className="text-gray-400 ml-1">({formatCount(stats.libraries[libraryName])})</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Extra Sources Option */}
              {showSourceCountSelector && (
                <div>
                  <h4 className="text-sm font-medium text-gray-900 mb-2">Response Depth</h4>
                  <label className="flex items-start">
                    <input
                      type="checkbox"
                      checked={sourceCount === 10}
                      onChange={(e) => handleSourceCountToggle(e.target.checked)}
                      className="mr-2 mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">
                      Use 10 sources instead of 4 for more comprehensive responses
                    </span>
                  </label>
                </div>
              )}

              {/* Reset Button */}
              {isModified && (
                <div className="pt-3 mt-3 border-t border-gray-200">
                  <button
                    type="button"
                    onClick={handleResetOptions}
                    className="w-full flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                  >
                    <span className="material-icons text-base mr-2">refresh</span>
                    Reset to Defaults
                  </button>
                </div>
              )}

              {/* Stats Legend */}
              {stats && (
                <div className="pt-3 mt-3 border-t border-gray-200">
                  <div className="flex items-start text-xs text-gray-500">
                    <svg
                      className="w-4 h-4 mr-1.5 mt-0.5 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>Numbers indicate searchable content chunks available in each category</span>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

      {/* Controls Info Modal */}
      {showControlsInfo &&
        typeof window !== "undefined" &&
        createPortal(
          <>
            <div
              className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100]"
              onMouseDown={(e) => {
                e.stopPropagation();
                setShowControlsInfo(false);
                logEvent("dismiss_controls_info", "UI", "backdrop_click");
              }}
              aria-hidden="true"
            />
            <div className="fixed z-[101] top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white p-6 rounded-xl shadow-lg max-w-md w-full mx-4">
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-lg font-semibold">Available Controls</h3>
                <button
                  onClick={() => {
                    setShowControlsInfo(false);
                    logEvent("dismiss_controls_info", "UI", "close_button");
                  }}
                  className="text-gray-500 hover:text-gray-700"
                  aria-label="Close"
                >
                  <span className="material-icons">close</span>
                </button>
              </div>

              <div className="space-y-4">
                {showAuthorSelection && (
                  <div>
                    <h4 className="font-medium mb-1">Collection Selection</h4>
                    <p className="text-sm text-gray-600">
                      Select specific collections or authors to focus your search.
                    </p>
                  </div>
                )}

                {showMediaTypeSelection && (
                  <div>
                    <h4 className="font-medium mb-1">Media Type Selection</h4>
                    <p className="text-sm text-gray-600">
                      Choose which media types (
                      {enabledMediaTypes.map((type) => (type === "youtube" ? "video" : type)).join(", ")}) to include
                      for your query.
                    </p>
                  </div>
                )}

                {showLibrarySelection && (
                  <div>
                    <h4 className="font-medium mb-1">Library Selection</h4>
                    <p className="text-sm text-gray-600">
                      Choose which content collections to search. You can select one or more libraries to narrow your
                      search to specific sources. At least one library must remain selected.
                    </p>
                  </div>
                )}

                {showSourceCountSelector && (
                  <div>
                    <h4 className="font-medium mb-1">Use Extra Sources</h4>
                    <p className="text-sm text-gray-600">
                      Enable to use more sources (10 instead of {siteConfig?.defaultNumSources || 4}) for potentially
                      more comprehensive responses. Relevant text passages are retrieved based on similarity to your
                      query and used as context for generating answers.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
};
