/**
 * ChatInput Component
 *
 * This component renders a chat input interface with various options and controls.
 * It handles user input, submission, and displays suggested queries and media type options.
 *
 * Key features:
 * - Text input area with auto-resizing
 * - Submit button that toggles between send and stop based on loading state
 * - Media type selection (text, audio, YouTube) if enabled
 * - Collection selector for choosing different content sources
 * - Private session toggle
 * - Suggested queries with expand/collapse functionality
 * - Mobile-responsive design with collapsible options
 * - Input validation and sanitization
 * - Analytics event logging for user interactions
 *
 * The component is highly configurable through props and site configuration,
 * allowing for easy customization of features and behavior.
 */

import React, { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import validator from "validator";
import styles from "@/styles/Home.module.css";
import SuggestedQueries from "@/components/SuggestedQueries";
import { FilterDropdown } from "@/components/FilterDropdown";
import { TaskPopover } from "@/components/TaskPopover";
import { TipsModal } from "@/components/TipsModal";
import { SiteConfig } from "@/types/siteConfig";
import { getEnableSuggestedQueries } from "@/utils/client/siteConfig";
import { logEvent } from "@/utils/client/analytics";
import { getOrCreateUUID } from "@/utils/client/uuid";
import { FirestoreIndexError, useFirestoreIndexError } from "@/components/FirestoreIndexError";
import { areTipsAvailable } from "@/utils/client/loadTips";
import { loadSiteTips, TipsData } from "@/utils/client/loadTips";
import { isAuthenticated, getToken } from "@/utils/client/tokenManager";

// Define the props interface for the ChatInput component
interface ChatInputProps {
  loading: boolean;
  disabled?: boolean;
  handleSubmit: (e: React.FormEvent, query: string) => void;
  handleStop: () => void;
  handleEnter: (e: React.KeyboardEvent<HTMLTextAreaElement>, query: string) => void;
  handleClick: (query: string) => void;
  handleCollectionChange: (newCollection: string) => void;
  collection: string;
  temporarySession: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  suggestedQueries: string[];
  shuffleQueries: () => void;
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
  mediaTypes: { text: boolean; audio: boolean; youtube: boolean };
  handleMediaTypeChange: (type: "text" | "audio" | "youtube") => void;
  selectedLibraries: string[];
  handleLibraryChange: (library: string) => void;
  siteConfig: SiteConfig | null;
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  setShouldAutoScroll: (should: boolean) => void;
  setQuery: (query: string) => void;
  isNearBottom: boolean;
  setIsNearBottom: React.Dispatch<React.SetStateAction<boolean>>;
  isLoadingQueries: boolean;
  showTemporarySessionOptions?: boolean;
  sourceCount: number;
  setSourceCount: (count: number) => void;
  onTemporarySessionChange?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  categorizedQueries?: { general: string[]; location: string[]; resources: string[] } | null;
  shouldShowSuggestions?: boolean; // Hide suggestions after first question
  onTaskSubmit?: (
    prompt: string,
    sourceCount: number,
    taskMode: string,
    suggestedFollowups: string[],
    authorFilter?: string
  ) => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  loading,
  disabled = false,
  handleSubmit,
  handleStop,
  handleEnter,
  handleClick,
  handleCollectionChange,
  collection,
  temporarySession,
  error,
  setError,
  suggestedQueries,
  shuffleQueries,
  textAreaRef,
  mediaTypes,
  handleMediaTypeChange,
  selectedLibraries,
  handleLibraryChange,
  siteConfig,
  input,
  handleInputChange,
  setQuery,
  setIsNearBottom,
  isLoadingQueries,
  onTemporarySessionChange,
  sourceCount,
  setSourceCount,
  categorizedQueries,
  shouldShowSuggestions = true,
  onTaskSubmit,
}) => {
  // State variables for managing component behavior
  const [, setLocalQuery] = useState<string>("");
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);
  const [isFirstQuery, setIsFirstQuery] = useState<boolean>(true);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [showTipsModal, setShowTipsModal] = useState(false);
  const [tipsAvailable, setTipsAvailable] = useState(false);
  const [hasNewTips, setHasNewTips] = useState(false);
  const [currentTipsVersion, setCurrentTipsVersion] = useState<number | null>(null);
  //const inputRef = useRef<HTMLTextAreaElement>(null);

  // Analyze error to determine if it's a Firestore index error
  const { isIndexError, isBuilding, errorMessage } = useFirestoreIndexError(error);

  // Effect to ensure a persistent UUID exists for this user (cookie-based)
  useEffect(() => {
    try {
      getOrCreateUUID();
    } catch {
      // Silently ignore UUID creation errors - not critical for functionality
    }
  }, []);

  // Effect to check if tips are available for this site
  useEffect(() => {
    if (siteConfig) {
      areTipsAvailable(siteConfig).then(setTipsAvailable);
    }
  }, [siteConfig]);

  // Effect to check if there are new tips the user hasn't seen
  useEffect(() => {
    // Only check if tips are available and we know the current version
    if (!tipsAvailable || currentTipsVersion === null) {
      setHasNewTips(false);
      return;
    }

    let timeoutId: NodeJS.Timeout | null = null;

    const checkTipsStatus = async () => {
      // For login-required sites, check authentication status
      if (siteConfig?.requireLogin) {
        const authStatus = isAuthenticated();

        if (authStatus) {
          try {
            // Get JWT token and make authenticated API call
            const token = await getToken();
            const response = await fetch("/api/user/tips", {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
            });

            if (response.ok) {
              const data = await response.json();
              const lastSeenVersion = data.lastSeenTipVersion || 0;
              setHasNewTips(lastSeenVersion < currentTipsVersion);
            } else {
              throw new Error(`API returned ${response.status}`);
            }
          } catch {
            // Fallback to localStorage if API fails
            const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
            setHasNewTips(localLastSeenVersion < currentTipsVersion);
          }
        } else {
          // User not authenticated yet - try to wait a bit for auth to load, then check again
          // This handles the case where token hasn't loaded yet on initial render
          timeoutId = setTimeout(() => {
            if (isAuthenticated()) {
              // Retry the API call now that we're authenticated
              getToken()
                .then((token) => {
                  return fetch("/api/user/tips", {
                    method: "GET",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${token}`,
                    },
                  });
                })
                .then((response) => {
                  if (response.ok) {
                    return response.json();
                  } else {
                    throw new Error(`API returned ${response.status}`);
                  }
                })
                .then((data) => {
                  const lastSeenVersion = data.lastSeenTipVersion || 0;
                  setHasNewTips(lastSeenVersion < currentTipsVersion);
                })
                .catch(() => {
                  // Fallback to localStorage if API fails
                  const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
                  setHasNewTips(localLastSeenVersion < currentTipsVersion);
                });
            } else {
              // Still not authenticated - use localStorage as fallback
              // For new accounts, localStorage will be empty (0), so if currentTipsVersion > 0, show dot
              const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
              setHasNewTips(localLastSeenVersion < currentTipsVersion);
            }
          }, 500); // Wait 500ms for auth to potentially load

          // Also set initial state based on localStorage
          const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
          setHasNewTips(localLastSeenVersion < currentTipsVersion);
        }
      } else {
        // Use localStorage for non-login sites
        const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
        setHasNewTips(localLastSeenVersion < currentTipsVersion);
      }
    };

    checkTipsStatus();

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [tipsAvailable, currentTipsVersion, siteConfig]);

  // Effect to fetch current site tips version once we know tips exist
  useEffect(() => {
    if (tipsAvailable && currentTipsVersion === null && siteConfig) {
      loadSiteTips(siteConfig)
        .then((data: TipsData | null) => {
          if (data) setCurrentTipsVersion(data.version);
        })
        .catch(() => {
          /* ignore */
        });
    }
  }, [tipsAvailable, currentTipsVersion, siteConfig]);

  // Effect to reset input after submission
  useEffect(() => {
    if (!loading && hasInteracted) {
      setLocalQuery("");
      if (textAreaRef.current) {
        // 1. Reset to auto - now textarea temporarily collapses to fit content
        textAreaRef.current.style.height = "auto";
        // 2. Now we can get the true height needed
        textAreaRef.current.style.height = `${textAreaRef.current.scrollHeight}px`;
      }
    }
  }, [loading, hasInteracted, textAreaRef]);

  // Effect to handle mobile responsiveness
  useEffect(() => {
    const handleResize = () => {
      const newIsMobile = window.innerWidth < 768;
      setIsMobile(newIsMobile);
    };

    handleResize(); // Set initial value
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // Effect to reset input and update first query state
  useEffect(() => {
    if (!loading) {
      setLocalQuery("");
      if (textAreaRef.current) {
        textAreaRef.current.style.height = "auto";
      }
      if (isFirstQuery) {
        setIsFirstQuery(false);
      }
    }
  }, [loading, isFirstQuery, textAreaRef]);

  // Function to focus on the input field
  const focusInput = () => {
    setTimeout(() => {
      if (textAreaRef.current) {
        textAreaRef.current.focus();
      }
    }, 0);
  };

  // Function to sanitize user input
  const sanitizeInput = (input: string) => {
    return DOMPurify.sanitize(input).toString();
  };

  // Function to validate user input
  const validateInput = (input: string) => {
    if (validator.isEmpty(input)) {
      return "Input cannot be empty";
    }
    if (!validator.isLength(input, { min: 1, max: 4000 })) {
      return "Input must be between 1 and 4000 characters";
    }
    return null;
  };

  // Function to handle form submission
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) {
      handleStop();
      logEvent("stop_query", "Engagement", "");
    } else {
      const sanitizedInput = sanitizeInput(input);

      // Skip validation for empty inputs - let parent handle gracefully
      if (sanitizedInput.trim() === "") {
        handleSubmit(e, sanitizedInput);
        return;
      }

      const validationError = validateInput(sanitizedInput);
      if (validationError) {
        setError(validationError);
        return;
      }
      setIsNearBottom(true);
      handleSubmit(e, sanitizedInput);
      setQuery("");
      focusInput();
      logEvent("submit_query", "Engagement", sanitizedInput);
    }
  };

  // Function to handle Enter key press
  const onEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (!loading) {
        e.preventDefault();
        const sanitizedInput = sanitizeInput(input);

        // Skip validation for empty inputs - let parent handle gracefully
        if (sanitizedInput.trim() === "") {
          handleEnter(e, sanitizedInput);
          return;
        }

        const validationError = validateInput(sanitizedInput);
        if (validationError) {
          setError(validationError);
          return;
        }
        logEvent("submit_query_enter", "Engagement", sanitizedInput);
        setHasInteracted(true);
        setIsNearBottom(true);
        handleEnter(e, sanitizedInput);
        setQuery("");
        focusInput();
      }
    }
  };

  // Get configuration options from siteConfig
  const showSuggestedQueries = getEnableSuggestedQueries(siteConfig) && shouldShowSuggestions;

  // Function to handle clicking on a suggested query
  const onQueryClick = (q: string) => {
    setLocalQuery(q);
    setIsNearBottom(true);
    handleClick(q);
  };

  // Function to handle tips button click
  const handleTipsClick = () => {
    setShowTipsModal(true);
    logEvent("tips_modal_open", "Tips", "button_click");
  };

  // Function to handle tips modal close
  const handleTipsClose = () => {
    setShowTipsModal(false);
    logEvent("tips_modal_close", "Tips", "modal_close");

    // Mark tips as seen by updating the user's lastSeenTipVersion
    if (currentTipsVersion && hasNewTips && siteConfig?.requireLogin) {
      const authStatus = isAuthenticated();

      if (authStatus) {
        // Get JWT token and make authenticated API call
        getToken()
          .then((token) => {
            return fetch("/api/user/tips", {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                lastSeenTipVersion: currentTipsVersion,
              }),
            });
          })
          .then(() => {
            setHasNewTips(false);
            logEvent("tips_version_updated", "Tips", "api_success");
          })
          .catch(() => {
            // Don't show error to user, just log it
          });
      } else {
        // Use localStorage for non-authenticated users
        localStorage.setItem("lastSeenTipVersion", currentTipsVersion.toString());
        setHasNewTips(false);
        logEvent("tips_version_updated", "Tips", "localStorage");
      }
    }

    // Always save to localStorage as backup
    if (currentTipsVersion && hasNewTips) {
      localStorage.setItem("lastSeenTipVersion", currentTipsVersion.toString());
      setHasNewTips(false);
    }
  };

  // Dynamic placeholder text based on conversation state
  const placeholderText = shouldShowSuggestions ? "Ask a question..." : "Ask a follow-up question...";

  // Function to adjust textarea height
  const adjustTextAreaHeight = () => {
    if (textAreaRef.current) {
      // 1. Reset to auto - now textarea temporarily collapses to fit content
      textAreaRef.current.style.height = "auto";
      // 2. Now we can get the true height needed
      textAreaRef.current.style.height = `${textAreaRef.current.scrollHeight}px`;
    }
  };

  // Render the chat input interface
  return (
    <div className={`${styles.center} w-full mt-2 md:mt-4 px-2 md:px-0`}>
      <div className="w-full">
        <form onSubmit={onSubmit}>
          {/* Temporary session indicator - now handled in navigation */}
          {temporarySession && (
            <div className="flex items-center justify-center mb-3 px-3 py-2 bg-purple-100 border border-purple-300 rounded-lg">
              <span className="material-icons text-purple-600 text-lg mr-2">lock</span>
              <span className="text-purple-800 text-sm font-medium">
                Temporary Session Active
                <button
                  onClick={onTemporarySessionChange}
                  className="ml-2 px-2 py-1 text-xs bg-purple-200 hover:bg-purple-300 text-purple-800 rounded border border-purple-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!onTemporarySessionChange}
                >
                  End
                </button>
              </span>
            </div>
          )}

          {/* Suggested queries section - above input */}
          {!isLoadingQueries && showSuggestedQueries && (suggestedQueries.length > 0 || categorizedQueries) && (
            <div className="w-full mb-4">
              <SuggestedQueries
                queries={suggestedQueries}
                onQueryClick={onQueryClick}
                isLoading={loading}
                shuffleQueries={shuffleQueries}
                isMobile={isMobile}
                siteConfig={siteConfig}
                categorizedQueries={categorizedQueries}
              />
            </div>
          )}

          {/* Input container with textarea and options row */}
          <div className="mb-4 border border-gray-300 rounded-xl overflow-hidden">
            {/* Input textarea and submit button */}
            <div className="relative">
              <textarea
                onKeyDown={onEnter}
                onChange={(e) => {
                  handleInputChange(e);
                  adjustTextAreaHeight();
                }}
                value={input}
                ref={textAreaRef}
                autoFocus={false}
                rows={1}
                maxLength={4000}
                id="userInput"
                name="userInput"
                placeholder={disabled ? "View-only mode" : hasInteracted ? "" : placeholderText}
                disabled={disabled}
                className={`w-full p-3 pr-12 resize-none focus:outline-none min-h-[48px] overflow-hidden border-0 ${
                  disabled ? "bg-gray-100 cursor-not-allowed" : ""
                }`}
                style={{ height: "auto" }}
              />
              <button
                type="submit"
                disabled={disabled}
                className={`absolute right-3 top-1/2 transform -translate-y-1/2 p-2 rounded-xl flex items-center justify-center w-8 h-8 ${
                  disabled ? "bg-gray-400 text-gray-600 cursor-not-allowed" : "bg-blue-500 text-white hover:bg-blue-600"
                }`}
              >
                {loading ? (
                  <span className="material-icons text-lg leading-none">stop</span>
                ) : (
                  <span className="material-icons text-lg leading-none">arrow_upward</span>
                )}
              </button>
            </div>

            {/* Options row inside input box */}
            <div className="flex gap-2 items-center px-3 py-2">
              {/* Task Popover - only show if tasks are enabled and handler provided */}
              {onTaskSubmit && <TaskPopover siteConfig={siteConfig} onTaskSubmit={onTaskSubmit} />}

              {/* Content Filters - media types, authors, libraries, extra sources */}
              <FilterDropdown
                siteConfig={siteConfig}
                mediaTypes={mediaTypes}
                handleMediaTypeChange={handleMediaTypeChange}
                collection={collection}
                handleCollectionChange={handleCollectionChange}
                selectedLibraries={selectedLibraries}
                handleLibraryChange={handleLibraryChange}
                sourceCount={sourceCount}
                setSourceCount={setSourceCount}
              />

              {/* Tips Button - only show if tips are available for this site */}
              {tipsAvailable && (
                <button
                  type="button"
                  onClick={handleTipsClick}
                  className="relative flex items-center justify-center p-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                  title="Tips and tricks"
                  aria-label="View tips and tricks"
                >
                  <span className="material-icons text-base">lightbulb</span>
                  {/* Blue dot indicator when there are new tips */}
                  {hasNewTips && (
                    <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-blue-500 border-2 border-white" />
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Error display */}
          {error &&
            (isIndexError ? (
              <FirestoreIndexError error={errorMessage} isBuilding={isBuilding} className="mb-4" />
            ) : (
              <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4">
                <strong className="font-bold">An error occurred: </strong>
                <span className="block sm:inline">{error}</span>
              </div>
            ))}
        </form>

        {/* Tips Modal */}
        <TipsModal
          isOpen={showTipsModal}
          onClose={handleTipsClose}
          siteConfig={siteConfig}
          onVersionLoaded={setCurrentTipsVersion}
        />
      </div>
    </div>
  );
};
