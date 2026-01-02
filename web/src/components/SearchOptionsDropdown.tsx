/**
 * SearchOptionsDropdown Component
 *
 * This component renders a dropdown menu with grouped chat options:
 * - Media type checkboxes (text, audio, video) if enabled
 * - Author/collection radio buttons (Master Swami, All) if enabled
 * - Extra sources checkbox if enabled
 *
 * The component uses a dropdown pattern with proper accessibility
 * and responsive design for mobile and desktop.
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { SiteConfig } from "@/types/siteConfig";
import {
  getEnableMediaTypeSelection,
  getEnableAuthorSelection,
  getEnabledMediaTypes,
  getCollectionsConfig,
} from "@/utils/client/siteConfig";
import { logEvent } from "@/utils/client/analytics";
import { useLibraryStats } from "@/hooks/useLibraryStats";

interface SearchOptionsDropdownProps {
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

export const SearchOptionsDropdown: React.FC<SearchOptionsDropdownProps> = ({
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
  const [showControlsInfo, setShowControlsInfo] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Fetch library stats
  const { stats } = useLibraryStats(siteConfig);

  // Get configuration options from siteConfig
  const showMediaTypeSelection = getEnableMediaTypeSelection(siteConfig);
  const showAuthorSelection = getEnableAuthorSelection(siteConfig);
  const showSourceCountSelector = siteConfig?.showSourceCountSelector ?? false;
  const enabledMediaTypes = getEnabledMediaTypes(siteConfig);
  const collectionsConfig = getCollectionsConfig(siteConfig);

  // Get available libraries and check if we should show library selector
  const availableLibraries = (siteConfig?.includedLibraries || []).slice().sort((a, b) => {
    const nameA = typeof a === "string" ? a : a.name;
    const nameB = typeof b === "string" ? b : b.name;
    return nameA.toLowerCase().localeCompare(nameB.toLowerCase());
  });
  const showLibrarySelection = availableLibraries.length > 1;

  // Determine if options have been changed from defaults
  const isModified = useMemo((): boolean => {
    // Get default media types from site config (defaults to all enabled if not specified)
    const siteEnabledMediaTypes = getEnabledMediaTypes(siteConfig);
    const defaultMediaTypes = {
      text: siteEnabledMediaTypes.includes("text"),
      audio: siteEnabledMediaTypes.includes("audio"),
      youtube: siteEnabledMediaTypes.includes("youtube"),
    };

    // Default collection (first key from collections config)
    const defaultCollection = Object.keys(collectionsConfig)[0] || "";

    // Default source count from site config
    const defaultSourceCount = siteConfig?.defaultNumSources || 4;

    // Check if media types have been changed from defaults (only if feature is enabled)
    // Note: No media types checked is equivalent to all media types checked (searches all content)
    const mediaTypesChanged =
      showMediaTypeSelection &&
      (() => {
        // Helper function to normalize media types: treat "none checked" as "all enabled checked"
        const normalizeMediaTypes = (types: { text: boolean; audio: boolean; youtube: boolean }) => {
          const checkedCount = Object.values(types).filter(Boolean).length;
          if (checkedCount === 0) {
            // No types checked = all enabled types checked
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

    // Check if collection has been changed from default (only if feature is enabled)
    const collectionChanged = showAuthorSelection && collection !== defaultCollection;

    // Check if source count has been changed from default (only if feature is enabled)
    const sourceCountChanged = showSourceCountSelector && sourceCount !== defaultSourceCount;

    // Check if library selection has been changed from default (only if feature is enabled)
    const defaultLibraries = availableLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
    const librariesChanged =
      showLibrarySelection &&
      (selectedLibraries.length !== defaultLibraries.length ||
        !selectedLibraries.every((lib) => defaultLibraries.includes(lib)));

    return mediaTypesChanged || collectionChanged || sourceCountChanged || librariesChanged;
  }, [
    showMediaTypeSelection,
    showAuthorSelection,
    showSourceCountSelector,
    showLibrarySelection,
    mediaTypes,
    collection,
    sourceCount,
    selectedLibraries,
    siteConfig,
    collectionsConfig,
    availableLibraries,
  ]);

  // Helper function to format large numbers
  const formatCount = (count: number): string => {
    if (count >= 1000) {
      return `${Math.round(count / 1000)}k`;
    }
    return count.toLocaleString();
  };

  // Helper function to get collection count based on author filters
  const getCollectionCount = (collectionKey: string): number => {
    if (!stats?.authors) return 0;

    // Map collection to author filters from siteConfig
    if (collectionKey === "master_swami") {
      return (stats.authors["Paramhansa Yogananda"] || 0) + (stats.authors["Swami Kriyananda"] || 0);
    }

    if (collectionKey === "whole_library") {
      // Use the precomputed total from backend if available
      if (stats.authors["whole_library"] !== undefined) {
        return stats.authors["whole_library"];
      }
      // Fallback: sum all authors (excluding whole_library key to avoid double-counting)
      return Object.entries(stats.authors)
        .filter(([key]) => key !== "whole_library")
        .reduce((sum, [, count]) => sum + count, 0);
    }

    return 0;
  };

  // Check if any options are available
  const hasAnyOptions =
    showMediaTypeSelection || showAuthorSelection || showSourceCountSelector || showLibrarySelection;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      // Don't close if the info modal is open - let the modal handle its own closing
      if (showControlsInfo) {
        return;
      }

      // Don't close if clicking on the button or inside the dropdown menu
      const isClickOnButton = buttonRef.current && buttonRef.current.contains(target);
      const isClickInDropdown = dropdownMenuRef.current && dropdownMenuRef.current.contains(target);

      if (!isClickOnButton && !isClickInDropdown) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, showControlsInfo]);

  // Close dropdown on Escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (showControlsInfo) {
          // If info modal is open, close it but keep dropdown open
          setShowControlsInfo(false);
          logEvent("dismiss_controls_info", "UI", "escape_key");
        } else if (isOpen) {
          // If only dropdown is open, close it
          setIsOpen(false);
          buttonRef.current?.focus();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, showControlsInfo]);

  // Calculate dropdown position based on button position (viewport coords)
  const calculateDropdownPosition = () => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 4;
    const dropdownWidth = 320; // w-80

    // Start below button
    let top = rect.bottom + gap;
    const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 10);

    setDropdownPosition({ top: Math.max(10, top), left: Math.max(10, left) });

    // After first paint, if dropdown height causes overflow, move above
    requestAnimationFrame(() => {
      const height = dropdownMenuRef.current?.offsetHeight || 0;
      const bottom = top + height;
      if (bottom > window.innerHeight - 10) {
        top = Math.max(10, rect.top - height - gap);
        setDropdownPosition({ top, left });
      }
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
    setIsOpen(!isOpen);
    logEvent(isOpen ? "close_search_options" : "open_search_options", "UI", "dropdown_toggle");
  };

  const handleMediaTypeToggle = (type: "text" | "audio" | "youtube") => {
    handleMediaTypeChange(type);

    // Save media type preferences to localStorage
    const newMediaTypes = { ...mediaTypes, [type]: !mediaTypes[type] };
    localStorage.setItem("searchMediaTypes", JSON.stringify(newMediaTypes));

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

    // Calculate the new selection for localStorage
    const isCurrentlySelected = selectedLibraries.includes(library);
    const newSelection = isCurrentlySelected
      ? selectedLibraries.filter((lib) => lib !== library)
      : [...selectedLibraries, library];

    // Save library preferences to localStorage (only if change is allowed)
    if (newSelection.length > 0) {
      localStorage.setItem("selectedLibraries", JSON.stringify(newSelection));
      const status = isCurrentlySelected ? "disabled" : "enabled";
      // Log library toggle with status in label and current selected count as value
      logEvent("toggle_library", "Settings", `${library}:${status}`, newSelection.length);
    }
  };

  const handleSourceCountToggle = (checked: boolean) => {
    const defaultSources = siteConfig?.defaultNumSources || 4;
    const extraSources = 10;
    const newSourceCount = checked ? extraSources : defaultSources;

    setSourceCount(newSourceCount);

    // Save extra sources preference to localStorage
    localStorage.setItem("useExtraSources", checked.toString());

    logEvent("toggle_extra_sources", "Settings", checked ? "enabled" : "disabled");
  };

  const handleResetOptions = () => {
    // Get default media types from site config (all enabled types checked)
    const siteEnabledMediaTypes = getEnabledMediaTypes(siteConfig);
    const defaultMediaTypes = {
      text: siteEnabledMediaTypes.includes("text"),
      audio: siteEnabledMediaTypes.includes("audio"),
      youtube: siteEnabledMediaTypes.includes("youtube"),
    };

    // Reset media types - toggle each type if it doesn't match default
    if (showMediaTypeSelection) {
      (["text", "audio", "youtube"] as const).forEach((type) => {
        if (mediaTypes[type] !== defaultMediaTypes[type]) {
          handleMediaTypeChange(type);
        }
      });
      // Clear localStorage for media types
      localStorage.removeItem("searchMediaTypes");
    }

    // Reset collection to default (first key from collections config)
    const defaultCollection = Object.keys(collectionsConfig)[0] || "";
    if (showAuthorSelection && collection !== defaultCollection) {
      handleCollectionChange(defaultCollection);
    }

    // Reset libraries to all available libraries
    if (showLibrarySelection) {
      const defaultLibraries = availableLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
      // Get libraries that need to be selected (in defaults but not currently selected)
      const librariesToSelect = defaultLibraries.filter((lib) => !selectedLibraries.includes(lib));
      // Get libraries that need to be deselected (currently selected but not in defaults)
      const librariesToDeselect = selectedLibraries.filter((lib) => !defaultLibraries.includes(lib));

      // First, select any missing default libraries (this ensures we have at least one selected)
      librariesToSelect.forEach((lib) => {
        handleLibraryChange(lib);
      });

      // Then, deselect any non-default libraries (safe now since we've selected defaults)
      librariesToDeselect.forEach((lib) => {
        handleLibraryChange(lib);
      });

      // Clear localStorage for libraries
      localStorage.removeItem("selectedLibraries");
    }

    // Reset source count to default
    const defaultSourceCount = siteConfig?.defaultNumSources || 4;
    if (showSourceCountSelector) {
      if (sourceCount !== defaultSourceCount) {
        const useExtraSources = sourceCount === 10;
        if (useExtraSources) {
          // Toggle off extra sources if currently enabled
          handleSourceCountToggle(false);
        } else {
          // Set to default (shouldn't happen, but handle it)
          setSourceCount(defaultSourceCount);
          localStorage.removeItem("useExtraSources");
        }
      } else {
        // Already at default, just clear localStorage to ensure clean reset
        localStorage.removeItem("useExtraSources");
      }
    }

    // Log analytics event
    logEvent("reset_chat_options", "Settings", "reset_to_defaults");
  };

  // Don't render if no options are available
  if (!hasAnyOptions) {
    return null;
  }

  return (
    <div className="relative">
      {/* Dropdown Button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleDropdown}
        className="relative flex items-center px-3 py-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-xl hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <span className="relative inline-block mr-2" style={{ width: "20px", height: "20px" }}>
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
            tune
          </span>
        </span>
        Chat Options
        <span className={`material-icons text-base ml-2 transition-transform ${isOpen ? "rotate-180" : ""}`}>
          expand_more
        </span>
      </button>

      {/* Dropdown Menu (portal, fixed to viewport to avoid clipping) */}
      {isOpen &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            ref={dropdownMenuRef}
            className="fixed w-80 bg-white border border-gray-200 rounded-xl shadow-lg z-[90] max-h-[calc(100vh-8rem)] overflow-y-auto"
            style={{ top: `${dropdownPosition.top}px`, left: `${dropdownPosition.left}px` }}
          >
            <div className="p-4 space-y-4">
              {/* Header with info button */}
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium text-gray-900">Chat Options</h3>
                <button
                  type="button"
                  onClick={() => {
                    setShowControlsInfo(true);
                    logEvent("show_controls_info", "UI", "info_button");
                  }}
                  className="px-2 py-1 text-xs rounded-full border border-gray-300 w-6 h-6 flex items-center justify-center hover:bg-gray-100"
                  aria-label="Controls information"
                >
                  <span className="material-icons text-base">info</span>
                </button>
              </div>
              {/* Media Type Selection Group */}
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

              {/* Author/Collection Selection Group */}
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

              {/* Library Selection Group */}
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
                  <h4 className="text-sm font-medium text-gray-900 mb-2">Use Extra Sources</h4>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={sourceCount === 10}
                      onChange={(e) => handleSourceCountToggle(e.target.checked)}
                      className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">
                      Use 10 sources instead of 4 for more comprehensive responses
                    </span>
                  </label>
                </div>
              )}

              {/* Reset Button */}
              {isModified ? (
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
              ) : null}

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
      {showControlsInfo && (
        <>
          <div
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100]"
            onClick={() => {
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
              {showMediaTypeSelection && (
                <div>
                  <h4 className="font-medium mb-1">Media Type Selection</h4>
                  <p className="text-sm text-gray-600">
                    Choose which media types (
                    {enabledMediaTypes.map((type) => (type === "youtube" ? "video" : type)).join(", ")}) to include for
                    your query.
                  </p>
                </div>
              )}

              {showAuthorSelection && (
                <div>
                  <h4 className="font-medium mb-1">Collection Selection</h4>
                  <p className="text-sm text-gray-600">Select specific collections or authors to focus your search.</p>
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
                    Enable to use more sources (10 instead of {siteConfig?.defaultNumSources || 4}) for potentially more
                    comprehensive responses. Relevant text passages are retrieved based on similarity to your query and
                    used as context for generating answers.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
