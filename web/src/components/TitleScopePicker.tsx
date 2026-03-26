import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TitleScopeSelection, TitleScopeSuggestion, TitleScopeSuggestionResponse } from "@/types/titleScope";
import { fetchWithAuth } from "@/utils/client/tokenManager";

/** Header + input + helper + max-h-72 list — used to pick above/below before measure so layout does not flip on inner scroll. */
const TITLE_SCOPE_POPOVER_MAX_HEIGHT_PX = 520;
const VIEW_MARGIN_PX = 10;

interface TitleScopePickerProps {
  disabled?: boolean;
  value: TitleScopeSelection | null;
  onChange: (nextValue: TitleScopeSelection | null) => void;
  externalSuggestions?: TitleScopeSuggestion[];
  externalError?: string | null;
}

export const TitleScopePicker: React.FC<TitleScopePickerProps> = ({
  disabled = false,
  value,
  onChange,
  externalSuggestions = [],
  externalError = null,
}) => {
  const [inputValue, setInputValue] = useState(value?.displayTitle || value?.userInput || "");
  const [suggestions, setSuggestions] = useState<TitleScopeSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    suggestionButtonRefs.current = suggestionButtonRefs.current.slice(0, suggestions.length);
  }, [suggestions]);

  useEffect(() => {
    setInputValue(value?.displayTitle || value?.userInput || "");
  }, [value?.displayTitle, value?.userInput]);

  useEffect(() => {
    if (externalSuggestions.length > 0 || externalError) {
      setSuggestions(externalSuggestions);
      setError(externalError);
      setIsOpen(true);
      setIsPositioned(false);
    }
  }, [externalError, externalSuggestions]);

  useEffect(() => {
    if (!isOpen || typeof window === "undefined" || window.innerWidth < 768) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedPopover = popoverRef.current?.contains(target);
      const clickedButton = buttonRef.current?.contains(target);
      if (!clickedPopover && !clickedButton) {
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

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        setIsOpen(false);
        setIsPositioned(false);
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

  useEffect(() => {
    const updatePosition = () => {
      if (!isOpen || !buttonRef.current) {
        return;
      }

      const rect = buttonRef.current.getBoundingClientRect();
      const gap = 8;
      const popoverWidth = 360;
      let left = rect.left;

      if (left + popoverWidth > window.innerWidth - VIEW_MARGIN_PX) {
        left = window.innerWidth - popoverWidth - VIEW_MARGIN_PX;
      }
      if (left < VIEW_MARGIN_PX) {
        left = VIEW_MARGIN_PX;
      }

      const belowSpace = window.innerHeight - rect.bottom - gap - VIEW_MARGIN_PX;
      const aboveSpace = rect.top - gap - VIEW_MARGIN_PX;

      let top: number;
      if (belowSpace >= TITLE_SCOPE_POPOVER_MAX_HEIGHT_PX) {
        top = rect.bottom + gap;
      } else if (aboveSpace >= TITLE_SCOPE_POPOVER_MAX_HEIGHT_PX) {
        top = Math.max(VIEW_MARGIN_PX, rect.top - TITLE_SCOPE_POPOVER_MAX_HEIGHT_PX - gap);
      } else if (belowSpace >= aboveSpace) {
        top = rect.bottom + gap;
      } else {
        top = Math.max(VIEW_MARGIN_PX, rect.top - TITLE_SCOPE_POPOVER_MAX_HEIGHT_PX - gap);
      }

      setPopoverPosition({ top, left });

      requestAnimationFrame(() => {
        const popoverHeight = popoverRef.current?.offsetHeight || 0;
        let nextTop = top;

        if (nextTop + popoverHeight > window.innerHeight - VIEW_MARGIN_PX) {
          nextTop = Math.max(VIEW_MARGIN_PX, rect.top - popoverHeight - gap);
        }
        if (nextTop < VIEW_MARGIN_PX) {
          nextTop = VIEW_MARGIN_PX;
        }

        setPopoverPosition({ top: nextTop, left });
        setIsPositioned(true);
      });
    };

    const handleWindowScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) {
        return;
      }
      updatePosition();
    };

    if (isOpen) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", handleWindowScroll, true);
    }

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", handleWindowScroll, true);
    };
  }, [isOpen, suggestions.length, isLoading, inputValue, value?.canonicalPrefix, error]);

  useEffect(() => {
    if (disabled) {
      return;
    }

    const trimmedInput = inputValue.trim();
    if (trimmedInput.length < 2) {
      setSuggestions([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      try {
        setIsLoading(true);
        setError(null);
        const response = await fetchWithAuth(`/api/titleScope/suggest?q=${encodeURIComponent(trimmedInput)}&limit=50`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          const responseBody = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(responseBody.error || "Failed to load source suggestions");
        }

        const payload = (await response.json()) as TitleScopeSuggestionResponse;
        setSuggestions(payload.suggestions);
      } catch (fetchError) {
        if (controller.signal.aborted) {
          return;
        }
        setSuggestions([]);
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load source suggestions");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }, 180);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [disabled, inputValue]);

  const hasSelection = Boolean(value?.canonicalPrefix);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    setInputValue(nextValue);
    setIsOpen(true);
    setError(null);

    if (nextValue.trim().length === 0) {
      onChange(null);
      return;
    }

    onChange({
      userInput: nextValue,
    });
  };

  const handleSuggestionSelect = (suggestion: TitleScopeSuggestion) => {
    setInputValue(suggestion.displayTitle);
    setSuggestions([]);
    setError(null);
    setIsOpen(false);
    setIsPositioned(false);
    onChange({
      canonicalPrefix: suggestion.canonicalPrefix,
      displayTitle: suggestion.displayTitle,
      userInput: suggestion.displayTitle,
    });
  };

  const clearSelection = () => {
    setInputValue("");
    setSuggestions([]);
    setError(null);
    setIsOpen(false);
    setIsPositioned(false);
    onChange(null);
  };

  const togglePopover = () => {
    if (disabled) {
      return;
    }
    if (isOpen) {
      setIsPositioned(false);
    }
    setIsOpen((previous) => !previous);
  };

  const focusSuggestionAtIndex = (index: number) => {
    suggestionButtonRefs.current[index]?.focus();
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusSuggestionAtIndex(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusSuggestionAtIndex(suggestions.length - 1);
    }
  };

  const handleSuggestionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (index < suggestions.length - 1) {
        focusSuggestionAtIndex(index + 1);
      } else {
        inputRef.current?.focus();
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index > 0) {
        focusSuggestionAtIndex(index - 1);
      } else {
        inputRef.current?.focus();
      }
    }
  };

  const showEmptyState = inputValue.trim().length >= 2 && !isLoading && suggestions.length === 0 && !error;
  const buttonClassName = `relative flex items-center justify-center p-2 text-sm border rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
    disabled
      ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
      : hasSelection
        ? "bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100"
        : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
  }`;

  const popover = (
    <div
      ref={popoverRef}
      className="fixed z-[95] rounded-xl border border-gray-200 bg-white shadow-lg transition-opacity duration-75"
      style={{
        top: `${popoverPosition.top}px`,
        left: `${popoverPosition.left}px`,
        width: "360px",
        opacity: isPositioned ? 1 : 0,
      }}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-gray-900">Focus on one source</h3>
            <p className="mt-1 text-xs text-gray-500">Narrow the next answer to one book, text family, or source branch.</p>
          </div>
          {hasSelection && (
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
            >
              <span className="material-icons text-sm">close</span>
              Clear
            </button>
          )}
        </div>

        <div className="relative mt-3">
          <input
            ref={inputRef}
            id="titleScopeInput"
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onFocus={() => setIsOpen(true)}
            disabled={disabled}
            placeholder="Lessons in Meditation, Bible Genesis, etc."
            className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
              disabled
                ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-500"
                : "border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-blue-200"
            }`}
          />
        </div>

        {hasSelection && (
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <div className="font-medium">{value?.displayTitle || value?.canonicalPrefix}</div>
            <div className="mt-1 text-xs text-amber-800">Only this source scope will be used for the next answer.</div>
          </div>
        )}

        <div className="mt-3 min-h-[1.25rem] text-xs">
          {error ? <p className="text-red-600">{error}</p> : <p className="text-gray-500">Type at least 2 characters to search.</p>}
        </div>

        {(isLoading || suggestions.length > 0 || showEmptyState) && (
          <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-gray-200 bg-white">
            {isLoading ? (
              <div className="px-3 py-3 text-sm text-gray-500">Loading source suggestions...</div>
            ) : showEmptyState ? (
              <div className="px-3 py-3 text-sm text-gray-500">No matching source scopes found yet.</div>
            ) : (
              suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.canonicalPrefix}
                  ref={(element) => {
                    suggestionButtonRefs.current[index] = element;
                  }}
                  type="button"
                  onClick={() => handleSuggestionSelect(suggestion)}
                  onKeyDown={(event) => handleSuggestionKeyDown(event, index)}
                  className="block w-full border-b border-gray-100 px-3 py-3 text-left last:border-b-0 hover:bg-gray-50"
                >
                  <div className="text-sm font-medium text-gray-900">{suggestion.displayTitle}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {suggestion.fullTitleCount} title{suggestion.fullTitleCount === 1 ? "" : "s"} · {suggestion.matchType}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={togglePopover}
        disabled={disabled}
        className={buttonClassName}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Focus on one source"
        title={hasSelection ? `Focused on ${value?.displayTitle || value?.canonicalPrefix}` : "Focus on one source"}
      >
        <span className="relative inline-block" style={{ width: "20px", height: "20px" }}>
          {hasSelection && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-500" />}
          <span className="material-icons text-base absolute inset-0 flex items-center justify-center">menu_book</span>
        </span>
      </button>

      {isOpen && typeof window !== "undefined" && createPortal(popover, document.body)}
    </div>
  );
};
