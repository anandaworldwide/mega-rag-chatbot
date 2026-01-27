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
import { SiteConfig } from "@/types/siteConfig";
import { getEnableSuggestedQueries } from "@/utils/client/siteConfig";
import { logEvent } from "@/utils/client/analytics";
import { getOrCreateUUID } from "@/utils/client/uuid";
import { FirestoreIndexError, useFirestoreIndexError } from "@/components/FirestoreIndexError";

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
      </div>
    </div>
  );
};
