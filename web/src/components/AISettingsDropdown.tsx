/**
 * AISettingsDropdown Component
 *
 * This component renders a dropdown menu for AI-related settings:
 * - AI Model selection (GPT-4o, GPT-4, etc.)
 * - Extra sources toggle
 * - Compare AI Models link
 *
 * Split from SearchOptionsDropdown to separate AI settings from content filters.
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { SiteConfig } from "@/types/siteConfig";
import { logEvent } from "@/utils/client/analytics";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "@/config/modelOptions";

interface AISettingsDropdownProps {
  siteConfig: SiteConfig | null;
  sourceCount: number;
  setSourceCount: (count: number) => void;
  selectedModel: string;
  handleModelChange: (model: string) => void;
}

export const AISettingsDropdown: React.FC<AISettingsDropdownProps> = ({
  siteConfig,
  sourceCount,
  setSourceCount,
  selectedModel,
  handleModelChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const showSourceCountSelector = siteConfig?.showSourceCountSelector ?? false;
  const showModelComparison = siteConfig?.enableModelComparison ?? false;

  // Determine if options have been changed from defaults
  const isModified = useMemo((): boolean => {
    const defaultSourceCount = siteConfig?.defaultNumSources || 4;
    const sourceCountChanged = showSourceCountSelector && sourceCount !== defaultSourceCount;
    const modelChanged = selectedModel !== DEFAULT_MODEL;

    return sourceCountChanged || modelChanged;
  }, [showSourceCountSelector, sourceCount, siteConfig, selectedModel]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
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
  }, [isOpen]);

  // Close dropdown on Escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  // Calculate dropdown position based on button position
  const calculateDropdownPosition = () => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 4;
    const dropdownWidth = 280;

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
    logEvent(isOpen ? "close_ai_settings" : "open_ai_settings", "UI", "dropdown_toggle");
  };

  const handleSourceCountToggle = (checked: boolean) => {
    const defaultSources = siteConfig?.defaultNumSources || 4;
    const extraSources = 10;
    const newSourceCount = checked ? extraSources : defaultSources;

    setSourceCount(newSourceCount);
    localStorage.setItem("useExtraSources", checked.toString());
    logEvent("toggle_extra_sources", "Settings", checked ? "enabled" : "disabled");
  };

  const handleResetOptions = () => {
    // Reset model to default
    if (selectedModel !== DEFAULT_MODEL) {
      handleModelChange(DEFAULT_MODEL);
      localStorage.removeItem("selectedModel");
    }

    // Reset source count to default
    const defaultSourceCount = siteConfig?.defaultNumSources || 4;
    if (showSourceCountSelector && sourceCount !== defaultSourceCount) {
      handleSourceCountToggle(false);
    }
    localStorage.removeItem("useExtraSources");

    logEvent("reset_ai_settings", "Settings", "reset_to_defaults");
  };

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
        aria-label="AI settings"
        title="AI Settings"
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
            auto_awesome
          </span>
        </span>
      </button>

      {/* Dropdown Menu */}
      {isOpen &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            ref={dropdownMenuRef}
            className="fixed w-70 bg-white border border-gray-200 rounded-xl shadow-lg z-[90] max-h-[calc(100vh-8rem)] overflow-y-auto"
            style={{ top: `${dropdownPosition.top}px`, left: `${dropdownPosition.left}px`, width: "280px" }}
          >
            <div className="p-4 space-y-4">
              {/* Header */}
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium text-gray-900">AI Settings</h3>
              </div>

              {/* AI Model Selection */}
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-2">AI Model</h4>
                <div className="space-y-2">
                  {MODEL_OPTIONS.map((option) => (
                    <label key={option.value} className="flex items-center">
                      <input
                        type="radio"
                        name="model"
                        value={option.value}
                        checked={selectedModel === option.value}
                        onChange={() => {
                          handleModelChange(option.value);
                          localStorage.setItem("selectedModel", option.value);
                          logEvent("change_model", "Settings", option.value);
                        }}
                        className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                      />
                      <span className="text-sm text-gray-700">{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>

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

              {/* Compare AI Models Link */}
              {showModelComparison && (
                <div className="pt-2">
                  <Link
                    href="/compare-models"
                    onClick={() => {
                      setIsOpen(false);
                      logEvent("click_compare_models", "Navigation", "ai_settings_dropdown");
                    }}
                    className="flex items-center text-sm text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    <span className="material-icons text-base mr-1.5">compare</span>
                    Compare AI Models
                  </Link>
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
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
