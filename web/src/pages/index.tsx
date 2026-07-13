// It includes features such as real-time chat, collection selection, private sessions,
// and media type filtering. The component manages chat state, handles user input,
// and communicates with a backend API for chat responses.

// Special features:
// - GETHUMAN links: For the 'ananda-public' site ID, links in the format [text](GETHUMAN)
//   are automatically converted to links to the Ananda contact page (https://www.ananda.org/contact-us/)

// React and Next.js imports
import React, { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";

// Component imports
import Layout from "@/components/layout";
import Popup from "@/components/popup";

import { ChatInput } from "@/components/ChatInput";
import MessageItem from "@/components/MessageItem";
import DownvoteFeedbackModal from "@/components/DownvoteFeedbackModal";
import ChatHistorySidebar from "@/components/ChatHistorySidebar";
import AnswerFeedbackPrompt from "@/components/AnswerFeedbackPrompt";
import ConversationTitleBar from "@/components/ConversationTitleBar";

// Hook imports
import usePopup from "@/hooks/usePopup";
import { useSuggestedQueries } from "@/hooks/useSuggestedQueries";
import { useChat } from "@/hooks/useChat";
import { useMultipleCollections } from "@/hooks/useMultipleCollections";
import { useChatHistory } from "@/hooks/useChatHistory";

// Utility imports
import { logEvent } from "@/utils/client/analytics";
import { recordSuggestionPillClick } from "@/utils/client/suggestionInteraction";
import { getCollectionQueries } from "@/utils/client/collectionQueries";
import { handleVote as handleVoteUtil } from "@/utils/client/voteHandler";
import { SiteConfig } from "@/types/siteConfig";
import {
  getSiteName,
  getCollectionsConfig,
  getEnableMediaTypeSelection,
  getEnableAuthorSelection,
  getEnabledMediaTypes,
  getDefaultCollectionKey,
} from "@/utils/client/siteConfig";
import { Document } from "@langchain/core/documents";

// Third-party library imports
import Cookies from "js-cookie";
import { toast } from "react-toastify";

import { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import { StreamingResponseData } from "@/types/StreamingResponseData";
import { TypedSuggestion } from "@/types/Suggestion";
import { SudoProvider, useSudo } from "@/contexts/SudoContext";
import { fetchWithAuth, isAuthenticated, initializeTokenManager } from "@/utils/client/tokenManager";
import { getOrCreateUUID } from "@/utils/client/uuid";
import { ensureVisitorUuidReady } from "@/utils/client/profileUuidSync";
import { ConversationNotFoundError, loadConversationByConvId } from "@/utils/client/conversationLoader";
import { getGreeting } from "@/utils/client/siteConfig";
import { SidebarFunctions, SidebarRefetch } from "@/components/ChatHistorySidebar";
import { generateSourceId } from "@/utils/client/sourceUtils";
import {
  FilterConflictAction,
  TitleScopeFilterConflictPayload,
  TitleScopeSelection,
  TitleScopeSuggestion,
} from "@/types/titleScope";
import { parseSseDataLine, readSseStream } from "@/utils/client/sseLineBuffer";
import {
  buildFilterExplicitnessPayload,
  formatTimingMetricsDisplay,
  generateChatPageTitle,
  getAutoAppliedSourceFocusAction,
  getQueriesForCollection,
  getRepairAllLibrariesSelection,
  shouldShowSuggestions as computeShouldShowSuggestions,
  shouldUsePinnedChatShell as computeShouldUsePinnedChatShell,
} from "@/utils/client/chatPageUtils";

export { getRepairAllLibrariesSelection } from "@/utils/client/chatPageUtils";

function useScrollDepthTracking() {
  const [scrollDepthsTracked, setScrollDepthsTracked] = useState<Set<number>>(new Set());
  const [pageLoadTime] = useState<number>(Date.now());
  const [firstInteractionTime, setFirstInteractionTime] = useState<number | null>(null);
  const [hasTrackedFirstInteraction, setHasTrackedFirstInteraction] = useState<boolean>(false);

  const trackFirstInteraction = useCallback(() => {
    if (!hasTrackedFirstInteraction && firstInteractionTime === null) {
      const timeToFirstInteraction = Date.now() - pageLoadTime;
      setFirstInteractionTime(Date.now());
      setHasTrackedFirstInteraction(true);
      logEvent("first_interaction", "Engagement", "time_to_first_interaction", timeToFirstInteraction);
    }
  }, [hasTrackedFirstInteraction, firstInteractionTime, pageLoadTime]);

  useEffect(() => {
    const handleScroll = () => {
      trackFirstInteraction();

      const scrollTop = window.scrollY;
      const windowHeight = window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;

      const scrollPercentage = Math.round((scrollTop / (documentHeight - windowHeight)) * 100);

      const thresholds = [25, 50, 75, 100];
      thresholds.forEach((threshold) => {
        if (scrollPercentage >= threshold && !scrollDepthsTracked.has(threshold)) {
          setScrollDepthsTracked((prev) => new Set([...prev, threshold]));
          logEvent("scroll_depth", "Engagement", `${threshold}%`, scrollPercentage);
        }
      });
    };

    const handleUserInteraction = () => {
      trackFirstInteraction();
    };

    // Track various user interactions that indicate engagement
    const interactionEvents = ["click", "keydown", "touchstart", "scroll", "mousemove", "mousedown", "touchmove"];

    interactionEvents.forEach((event) => {
      document.addEventListener(event, handleUserInteraction, { passive: true });
    });

    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
      interactionEvents.forEach((event) => {
        document.removeEventListener(event, handleUserInteraction);
      });
    };
  }, [scrollDepthsTracked, trackFirstInteraction]);

  return { trackFirstInteraction };
}

// Main component for the chat interface
export default function Home({ siteConfig }: { siteConfig: SiteConfig | null }) {
  const router = useRouter();

  // Initialize scroll depth and interaction tracking
  useScrollDepthTracking();

  // Handle demo mode cookie based on URL parameters
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const demoParam = urlParams.get("demo");

    if (demoParam === "1") {
      // Set demo cookie to true
      Cookies.set("demo", "true", {
        path: "/",
        expires: 7, // 7 days
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
      });
      // Clean up URL by removing the demo parameter
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete("demo");
      window.history.replaceState({}, document.title, newUrl.pathname + newUrl.search);
    } else if (demoParam === "0") {
      // Delete demo cookie
      Cookies.remove("demo", { path: "/" });
      // Clean up URL by removing the demo parameter
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete("demo");
      window.history.replaceState({}, document.title, newUrl.pathname + newUrl.search);
    }
  }, []);

  // State variables for various features and UI elements
  const [isMaintenanceMode] = useState<boolean>(false);
  const [viewOnlyMode, setViewOnlyMode] = useState<boolean>(false);
  const [collection, setCollection] = useState(() => getDefaultCollectionKey(siteConfig));
  const [collectionChanged, setCollectionChanged] = useState<boolean>(false);
  const [query, setQuery] = useState<string>("");
  const [temporarySession, setTemporarySession] = useState<boolean>(false);
  const [mediaTypes, setMediaTypes] = useState<{
    text: boolean;
    audio: boolean;
    youtube: boolean;
  }>({ text: true, audio: true, youtube: true });

  // Library selection state - initialize with all libraries
  const [selectedLibraries, setSelectedLibraries] = useState<string[]>(() => {
    const availableLibraries = siteConfig?.includedLibraries || [];
    return availableLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
  });
  // Keep a ref in sync to avoid stale closures during rapid toggles/submit
  const selectedLibrariesRef = useRef<string[]>(selectedLibraries);
  useEffect(() => {
    selectedLibrariesRef.current = selectedLibraries;
  }, [selectedLibraries]);
  const [selectedTitleScope, setSelectedTitleScope] = useState<TitleScopeSelection | null>(null);
  const [titleScopeSuggestions, setTitleScopeSuggestions] = useState<TitleScopeSuggestion[]>([]);
  const [titleScopeError, setTitleScopeError] = useState<string | null>(null);
  const [filterConflict, setFilterConflict] = useState<TitleScopeFilterConflictPayload | null>(null);
  const [pendingConflictRetry, setPendingConflictRetry] = useState(false);
  const [librariesExplicit, setLibrariesExplicit] = useState(false);
  const [mediaTypesExplicit, setMediaTypesExplicit] = useState(false);
  const isTitleScopeSelectionEnabled = Boolean(siteConfig?.enableTitleScopeSelection);
  const defaultCollection = useMemo(() => getDefaultCollectionKey(siteConfig), [siteConfig]);
  const defaultMediaTypes = useMemo(() => {
    const enabledTypes = getEnabledMediaTypes(siteConfig);
    return {
      text: enabledTypes.includes("text"),
      audio: enabledTypes.includes("audio"),
      youtube: enabledTypes.includes("youtube"),
    };
  }, [siteConfig]);
  const defaultLibraries = useMemo(
    () => (siteConfig?.includedLibraries || []).map((lib) => (typeof lib === "string" ? lib : lib.name)),
    [siteConfig?.includedLibraries]
  );
  const defaultSourceCount = siteConfig?.defaultNumSources || 4;
  const selectedTitleScopeRef = useRef<TitleScopeSelection | null>(selectedTitleScope);
  useEffect(() => {
    selectedTitleScopeRef.current = selectedTitleScope;
  }, [selectedTitleScope]);
  useEffect(() => {
    if (!isTitleScopeSelectionEnabled && selectedTitleScopeRef.current) {
      setSelectedTitleScope(null);
    }
  }, [isTitleScopeSelectionEnabled, selectedTitleScope]);
  const handleTitleScopeChange = useCallback((scope: TitleScopeSelection | null) => {
    setSelectedTitleScope(scope);
    setTitleScopeSuggestions([]);
    setTitleScopeError(null);
    setFilterConflict(null);
  }, []);

  useEffect(() => {
    const isDefaultLibs =
      defaultLibraries.length > 0 &&
      selectedLibraries.length === defaultLibraries.length &&
      defaultLibraries.every((lib) => selectedLibraries.includes(lib));
    setLibrariesExplicit(!isDefaultLibs);
  }, [defaultLibraries, selectedLibraries]);

  useEffect(() => {
    const enabledMediaTypeKeys = (Object.keys(defaultMediaTypes) as Array<keyof typeof defaultMediaTypes>).filter(
      (type) => defaultMediaTypes[type]
    );
    if (!enabledMediaTypeKeys.length) {
      setMediaTypesExplicit(false);
      return;
    }
    const allOn = enabledMediaTypeKeys.every((type) => mediaTypes[type] === true);
    setMediaTypesExplicit(!allOn);
  }, [defaultMediaTypes, mediaTypes]);

  const buildFilterExplicitnessPayloadFn = useCallback(() => {
    return buildFilterExplicitnessPayload(
      isTitleScopeSelectionEnabled,
      collectionChanged,
      librariesExplicit,
      mediaTypesExplicit
    );
  }, [isTitleScopeSelectionEnabled, collectionChanged, librariesExplicit, mediaTypesExplicit]);

  const applyFilterConflictAction = useCallback(
    (action: FilterConflictAction) => {
      if (action.kind === "repairAll") {
        if (action.collection === "whole_library") {
          setCollection("whole_library");
          setCollectionChanged(true);
        }
        setSelectedLibraries(getRepairAllLibrariesSelection(action.libraries, defaultLibraries));
        if (action.mediaTypes) {
          setMediaTypes({ ...action.mediaTypes });
        }
      } else {
        if (action.kind === "setCollection" && action.collection) {
          setCollection(action.collection);
          setCollectionChanged(true);
        }
        if (action.kind === "setLibraries" && action.libraries && action.libraries.length > 0) {
          setSelectedLibraries([...action.libraries]);
        }
        if (action.kind === "setMediaTypes" && action.mediaTypes) {
          setMediaTypes({ ...action.mediaTypes });
        }
        if (action.kind === "clearTitleScope" || action.clearTitleScope) {
          handleTitleScopeChange(null);
        }
      }

      setPendingConflictRetry(true);
      setFilterConflict(null);
    },
    [defaultLibraries, handleTitleScopeChange]
  );

  // Chat state management using custom hook
  const {
    messageState,
    setMessageState,
    loading,
    setLoading,
    error: chatError,
    setError,
  } = useChat(collection, temporarySession, mediaTypes, siteConfig, selectedLibraries);
  const { messages } = messageState as {
    messages: ExtendedAIMessage[];
  };
  const autoApplySourceFocusConflict = useCallback(
    (payload: TitleScopeFilterConflictPayload) => {
      const autoAction = getAutoAppliedSourceFocusAction(payload);
      if (!autoAction) {
        return false;
      }

      setFilterConflict(null);
      setError(null);
      applyFilterConflictAction(autoAction);
      logEvent("source_focus_auto_author_switch", "Source Focus", payload.titleScopeLabel);
      return true;
    },
    [applyFilterConflictAction, setError]
  );

  // Keep a ref in sync with history to avoid stale closures in callbacks
  // This is critical for the API call to send the correct history for question reformulation
  const historyRef = useRef(messageState.history);
  useEffect(() => {
    historyRef.current = messageState.history;
  }, [messageState.history]);

  // Keep a ref in sync with loading to avoid stale closures in setTimeout callbacks
  // This is critical for updateMessageState to not hide the scroll button during streaming
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  // Chat history hook for star/unstar functionality
  const { starConversation, unstarConversation, conversations } = useChatHistory(20, !!siteConfig?.requireLogin);

  // Track current conversation ID for follow-up messages
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const currentConvIdRef = useRef<string | null>(null);

  // Soft "How did we do?" prompt — once per conversation after first streamed answer
  const [answerFeedbackPromptDocId, setAnswerFeedbackPromptDocId] = useState<string | null>(null);
  const answerFeedbackPromptConsumedRef = useRef(false);
  const maybeShowAnswerFeedbackPromptRef = useRef<(docId: string | null | undefined) => void>(() => {});
  // Cleared synchronously on new query so stream `done` cannot stamp a prior answer's docId
  const savedDocIdRef = useRef<string | null>(null);
  const clearSavedDocId = useCallback(() => {
    savedDocIdRef.current = null;
  }, []);
  const rememberSavedDocId = useCallback((docId: string) => {
    savedDocIdRef.current = docId;
  }, []);

  // Track conversation title for HTML page title
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);

  // Generate page title based on conversation state
  const generatePageTitle = useCallback(() => {
    return generateChatPageTitle(conversationTitle, getSiteName(siteConfig));
  }, [conversationTitle, siteConfig]);

  // Update document title when conversation title changes
  useEffect(() => {
    document.title = generatePageTitle();
  }, [generatePageTitle]);

  // Keep ref in sync with state
  useEffect(() => {
    currentConvIdRef.current = currentConvId;
  }, [currentConvId]);

  // Local ref to track latest path since we sometimes manipulate history without
  // involving Next.js router (pushState). This prevents stale router.asPath
  // values from confusing handleUrlBasedLoading.
  const pathRef = useRef<string>(typeof window !== "undefined" ? window.location.pathname : "/");

  // Track previous path to detect actual navigations to root ("/")
  const previousPathRef = useRef<string>(pathRef.current);

  // Track the current question being processed (for adding to sidebar)
  // We keep both a state variable (for potential future UI use) and a ref so we
  // always have synchronous access to the latest question text when the convId
  // arrives earlier than React state updates.
  const [, _setCurrentQuestion] = useState<string>("");
  const currentQuestionRef = useRef<string>("");

  // Track if current submission is from task wizard
  const isTaskSubmissionRef = useRef<boolean>(false);

  // Helper to update both ref + state
  const setCurrentQuestion = (q: string) => {
    currentQuestionRef.current = q;
    _setCurrentQuestion(q);
  };

  // References to sidebar functions for adding/updating conversations
  const sidebarFunctionsRef = useRef<SidebarFunctions | null>(null);
  const sidebarRefetchRef = useRef<SidebarRefetch>(() => {});

  const handleSidebarFunctions = useCallback((functions: SidebarFunctions, refetch: SidebarRefetch) => {
    sidebarFunctionsRef.current = functions;
    sidebarRefetchRef.current = refetch;
  }, []);

  // Track if star change is coming from sidebar (to avoid duplicate API calls)
  const isStarChangeFromSidebarRef = useRef<boolean>(false);

  // Handler for star/unstar conversation
  const handleStarChange = useCallback(
    async (convId: string, newStarState: boolean) => {
      const isFromSidebar = isStarChangeFromSidebarRef.current;
      isStarChangeFromSidebarRef.current = false; // Reset flag

      try {
        // Only call API if NOT from sidebar (sidebar already called it)
        if (!isFromSidebar) {
          if (newStarState) {
            await starConversation(convId);
          } else {
            await unstarConversation(convId);
          }
        }

        // Update local state immediately for title bar
        setIsCurrentConversationStarred(newStarState);

        // Refetch sidebar in background to sync star state (if action came from title bar)
        // Don't await - useChatHistory already updated state optimistically
        if (!isFromSidebar) {
          sidebarRefetchRef.current();
        }
      } catch (error) {
        console.error("Failed to update star status:", error);
        toast.error("Failed to update star status. Please try again.");
      }
    },
    [starConversation, unstarConversation]
  );

  // (Removed pushedConvIdRef – no longer needed now that we update URL via
  // window.history.replaceState without triggering navigation.)

  // UI state variables

  const [linkCopied, setLinkCopied] = useState<string | null>(null);
  const [sourceLinkCopied, setSourceLinkCopied] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [isCurrentConversationStarred, setIsCurrentConversationStarred] = useState<boolean>(false);
  const sourceExpandedRef = useRef<Set<number>>(new Set());
  const handledHashRef = useRef<string | null>(null);

  // Refs for DOM elements and scroll management
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const bottomOfListRef = useRef<HTMLDivElement>(null);
  const scrollButtonContainerRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollDownButton, setShowScrollDownButton] = useState(false);
  const [shimmerScrollButton, setShimmerScrollButton] = useState(false); // Shimmer animation when new content arrives
  const [_scrollClickState, setScrollClickState] = useState(0); // 0: initial, 1: scrolled to content
  // Track which user message to highlight when clicked from suggested queries
  const [highlightMessageIndex, setHighlightMessageIndex] = useState<number | null>(null);
  const userMessageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const focusChatInput = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth >= 768) {
      textAreaRef.current?.focus();
    }
  }, []);

  const handleFocusSourceScope = useCallback(
    (scope: TitleScopeSelection) => {
      handleTitleScopeChange(scope);
      focusChatInput();
    },
    [focusChatInput, handleTitleScopeChange]
  );

  // Function to handle media type selection
  const handleMediaTypeChange = (type: "text" | "audio" | "youtube") => {
    if (getEnableMediaTypeSelection(siteConfig)) {
      const enabledTypes = getEnabledMediaTypes(siteConfig);
      if (enabledTypes.includes(type)) {
        setMediaTypes((prev) => {
          const newValue = !prev[type];
          logEvent(`select_media_type_${type}`, "Engagement", newValue ? "on" : "off");
          return { ...prev, [type]: newValue };
        });
      }
    }
  };

  // Function to handle library selection
  const handleLibraryChange = (library: string) => {
    setSelectedLibraries((prev) => {
      const isCurrentlySelected = prev.includes(library);

      // Prevent deselecting the last library
      if (isCurrentlySelected && prev.length === 1) {
        logEvent("library_selection_prevented", "Settings", "last_library_deselection_blocked");
        return prev;
      }

      const newSelection = isCurrentlySelected ? prev.filter((lib) => lib !== library) : [...prev, library];

      logEvent("library_selection_changed", "Settings", library, newSelection.length);
      return newSelection;
    });
  };
  const [sourceCount, _setSourceCount] = useState<number>(siteConfig?.defaultNumSources || 4);
  const sourceCountRef = useRef<number>(siteConfig?.defaultNumSources || 4); // Ref mirror for immediate access in async contexts
  const setSourceCount = (count: number) => {
    sourceCountRef.current = count;
    _setSourceCount(count);
  };
  const clearLegacyFilterStorage = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    Cookies.remove("selectedCollection", { path: "/" });
    localStorage.removeItem("searchMediaTypes");
    localStorage.removeItem("selectedLibraries");
    localStorage.removeItem("useExtraSources");
  }, []);
  const resetRetrievalFiltersToDefaults = useCallback(() => {
    setCollection(defaultCollection);
    setCollectionChanged(false);
    setMediaTypes(defaultMediaTypes);
    setSelectedLibraries(defaultLibraries);
    setSourceCount(defaultSourceCount);
    handleTitleScopeChange(null);
    setPendingConflictRetry(false);
  }, [defaultCollection, defaultLibraries, defaultMediaTypes, defaultSourceCount, handleTitleScopeChange]);
  const restoreConversationFilters = useCallback(
    (filters?: {
      collection?: string | null;
      mediaTypes?: { text?: boolean; audio?: boolean; youtube?: boolean } | null;
      selectedLibraries?: string[] | null;
      sourceCount?: number | null;
      titleScope?: TitleScopeSelection | null;
    }) => {
      const collectionsConfig = getCollectionsConfig(siteConfig);
      const restoredCollection =
        filters?.collection && collectionsConfig[filters.collection] ? filters.collection : defaultCollection;
      const restoredMediaTypes = {
        text: filters?.mediaTypes?.text ?? defaultMediaTypes.text,
        audio: filters?.mediaTypes?.audio ?? defaultMediaTypes.audio,
        youtube: filters?.mediaTypes?.youtube ?? defaultMediaTypes.youtube,
      };
      const restoredLibraries =
        filters?.selectedLibraries?.filter((library) => defaultLibraries.includes(library)) || defaultLibraries;
      const restoredSourceCount =
        typeof filters?.sourceCount === "number" && filters.sourceCount > 0 ? filters.sourceCount : defaultSourceCount;

      setCollection(restoredCollection);
      setCollectionChanged(restoredCollection !== defaultCollection);
      setMediaTypes(restoredMediaTypes);
      setSelectedLibraries(restoredLibraries.length > 0 ? restoredLibraries : defaultLibraries);
      setSourceCount(restoredSourceCount);
      handleTitleScopeChange(filters?.titleScope || null);
      setPendingConflictRetry(false);
    },
    [defaultCollection, defaultLibraries, defaultMediaTypes, defaultSourceCount, handleTitleScopeChange, siteConfig]
  );

  // Helper function to load conversation content without URL updates
  const loadConversationDirectly = useCallback(
    async (convId: string) => {
      try {
        setLoading(true);
        setError(null);

        const loadedConversation = await loadConversationByConvId(convId);

        // Update the message state with the loaded conversation
        setMessageState({
          messages: [
            {
              message: getGreeting(siteConfig),
              type: "apiMessage",
            },
            ...loadedConversation.messages,
          ],
          history: loadedConversation.history,
        });

        // Set the current conversation ID for follow-up messages
        setCurrentConvId(convId);

        // Set conversation title for page title
        if (loadedConversation.title) {
          setConversationTitle(loadedConversation.title);
        } else {
          // Generate fallback title from first user message if no title exists
          const firstUserMessage = loadedConversation.messages.find((msg) => msg.type === "userMessage");
          if (firstUserMessage) {
            const questionWords = firstUserMessage.message.trim().split(/\s+/);
            const fallbackTitle =
              questionWords.length <= 9 ? firstUserMessage.message : questionWords.slice(0, 9).join(" ") + "...";
            setConversationTitle(fallbackTitle);
          } else {
            // Clear any previous title so the page <title> resets correctly when switching to a
            // conversation that does not yet have an AI-generated title.
            setConversationTitle(null);
          }
        }

        // Set star state from loaded conversation
        setIsCurrentConversationStarred(loadedConversation.isStarred || false);

        // Restore the retrieval context that was active for the latest message in this conversation.
        restoreConversationFilters(loadedConversation.filters);

        // Restore task state from loaded conversation (if it was a task conversation)
        // Helper setters update both state and ref automatically
        if (loadedConversation.taskMode) {
          setIsTaskConversation(true);
          setCurrentTaskMode(loadedConversation.taskMode);
          setCurrentTaskFollowups(loadedConversation.taskFollowups || []);
          setUsedTaskFollowups(loadedConversation.usedTaskFollowups || []);
          // Clear dynamic follow-ups initially, then regenerate from last Q&A
          setDynamicFollowups([]);

          // Regenerate dynamic follow-ups from the last Q&A pair
          // Extract last question and answer from loaded messages
          const messages = loadedConversation.messages;
          let lastQuestion = "";
          let lastAnswer = "";
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.type === "apiMessage" && !lastAnswer) {
              lastAnswer = msg.message || "";
            } else if (msg.type === "userMessage" && lastAnswer && !lastQuestion) {
              lastQuestion = msg.message || "";
              break;
            }
          }

          // Generate follow-ups if we have a Q&A pair
          if (lastQuestion && lastAnswer) {
            // Use setTimeout to ensure refs are fully set and component is stable
            setTimeout(() => {
              generateDynamicFollowups(lastQuestion, lastAnswer);
            }, 100);
          }
        } else {
          // Clear task state for non-task conversations
          setIsTaskConversation(false);
          setCurrentTaskFollowups([]);
          setUsedTaskFollowups([]);
          setCurrentTaskMode(null);
          setDynamicFollowups([]);
        }

        // Log analytics event
        logEvent("chat_history_conversation_loaded", "Chat History", convId, loadedConversation.messages.length);

        // Don't show first-answer feedback prompt for already-started conversations
        setAnswerFeedbackPromptDocId(null);
        answerFeedbackPromptConsumedRef.current = true;

        /**
         * Deep linking: Hash fragment handling is done in the separate useEffect below
         * to avoid conflicts with browser's native scrolling and ensure proper timing
         */
      } catch (error) {
        if (!(error instanceof ConversationNotFoundError)) {
          console.error("Error loading conversation:", error);
        }

        // Set the conversation ID even on error to prevent infinite retry loops
        setCurrentConvId(convId);

        // Check if this is a Firestore index error and provide appropriate message
        const errorMessage = error instanceof Error ? error.message : "Failed to load conversation";

        if (errorMessage.includes("query requires an index") || errorMessage.includes("index is currently building")) {
          setError(
            "Database index required for conversation loading. The system administrator has been notified. Please try again later or contact support if this persists."
          );
        } else {
          setError(errorMessage);
        }
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [restoreConversationFilters, setCurrentConvId, setError, setLoading, setMessageState, siteConfig]
    // Note: generateDynamicFollowups is defined later but is stable (no deps, uses refs)
  );

  // Function to load a conversation from chat history
  const handleLoadConversation = async (convId: string) => {
    // Load the conversation content
    await loadConversationDirectly(convId);

    // Only update URL for sites that support conversation history
    if (siteConfig?.requireLogin) {
      // Update URL without triggering a full Next.js navigation to prevent flash.
      window.history.pushState(null, "", `/chat/${convId}`);
      pathRef.current = `/chat/${convId}`;
    }

    // Close sidebar after loading
    setSidebarOpen(false);
  };

  // Function to handle URL-based conversation loading
  const handleUrlBasedLoading = useCallback(async () => {
    const path = pathRef.current;

    // Don't interfere with ongoing streaming/loading operations
    if (loading) {
      return;
    }

    // Handle root path (/) – reset only when navigating FROM another path
    if (path === "/") {
      if (previousPathRef.current !== "/" && !loading && messageState.messages.length <= 1) {
        currentConvIdRef.current = null;
        setCurrentConvId(null);
        setCurrentQuestion("");
        setConversationTitle(null); // Clear conversation title
        setIsCurrentConversationStarred(false); // Clear star state
        setAnswerFeedbackPromptDocId(null);
        answerFeedbackPromptConsumedRef.current = false;
        savedDocIdRef.current = null;
        resetRetrievalFiltersToDefaults();
        setMessageState({
          messages: [
            {
              message: getGreeting(siteConfig),
              type: "apiMessage",
            },
          ],
          history: [],
        });
        setError(null);
        setViewOnlyMode(false);
        // Reload sidebar to clear any stale state
        sidebarRefetchRef.current();
      }
      return;
    }

    // Handle /chat/[convId] URLs
    if (path.startsWith("/chat/")) {
      // Extract convId, removing hash fragment if present
      const pathWithoutHash = path.split("#")[0];
      const convId = pathWithoutHash.split("/chat/")[1];
      // Prevent infinite loop by checking if we've already loaded this conversation OR if there's an existing error
      // If there's already an error for this conversation, don't retry to prevent infinite reload loops
      if (convId && convId !== currentConvIdRef.current && !chatError) {
        // Load conversation without updating URL (since URL is already correct)
        await loadConversationDirectly(convId);
      }
      return;
    }
  }, [
    loading,
    chatError,
    siteConfig,
    loadConversationDirectly,
    resetRetrievalFiltersToDefaults,
    setCurrentConvId,
    setMessageState,
    setError,
    setViewOnlyMode,
    messageState.messages.length,
  ]);

  /**
   * Sync pathRef with router.asPath to handle URL masking scenarios
   *
   * This effect ensures pathRef stays in sync with the displayed URL (router.asPath) rather than
   * the actual route pathname. This is critical for handling redirects from dynamic routes like
   * /chat/[convId] that use Next.js router.replace() with the 'as' parameter to mask the URL.
   *
   * Example scenario:
   * - User visits /share/docId#source-xyz (share page)
   * - Share page detects owner and redirects using router.replace("/", "/chat/convId#source-xyz")
   * - This renders the home page (/) but displays /chat/convId#source-xyz in the browser URL
   * - router.asPath will be "/chat/convId#source-xyz" while router.pathname is "/"
   * - We need pathRef to reflect "/chat/convId#source-xyz" so handleUrlBasedLoading() can detect
   *   and load the conversation correctly
   *
   * The effect also handles edge cases where asPath might contain a full URL (extracts pathname)
   * and validates that we only update pathRef with valid paths (starting with /).
   */
  useEffect(() => {
    if (router.isReady && router.asPath) {
      // Update pathRef to match the displayed URL (asPath) rather than actual pathname
      // This handles cases where /chat/[convId] route redirects to / but shows /chat/[convId] in URL
      // Extract only the pathname portion (in case asPath contains full URL)
      let displayedPath = router.asPath.split("?")[0]; // Remove query string, keep hash

      // If asPath somehow contains a full URL, extract just the pathname
      try {
        if (displayedPath.startsWith("http://") || displayedPath.startsWith("https://")) {
          const url = new URL(displayedPath);
          displayedPath = url.pathname + url.hash;
        }
      } catch {
        // If URL parsing fails, asPath is already a path, use it as-is
      }

      // Only update if it's a valid path (starts with /)
      if (displayedPath.startsWith("/") && displayedPath !== pathRef.current) {
        pathRef.current = displayedPath;
      }
    }
  }, [router.isReady, router.asPath]);

  // URL detection effect
  useEffect(() => {
    if (router.isReady) {
      handleUrlBasedLoading();
    }
  }, [router.isReady, handleUrlBasedLoading]);

  // Update previous path after each path change
  useEffect(() => {
    previousPathRef.current = pathRef.current;
  }, []);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const currentPath = window.location.pathname;
      pathRef.current = currentPath; // keep ref in sync

      if (currentPath === "/") {
        // Stop any ongoing streaming before resetting
        if (loading) {
          handleStop();
        }

        // Clear task state
        setIsTaskConversation(false);
        setCurrentTaskFollowups([]);
        setUsedTaskFollowups([]);
        setCurrentTaskMode(null);
        setDynamicFollowups([]);

        // Back to home: reset chat
        setMessageState({
          messages: [
            {
              message: getGreeting(siteConfig),
              type: "apiMessage",
            },
          ],
          history: [],
        });
        setCurrentConvId(null);
        setConversationTitle(null);
        setViewOnlyMode(false);
        setQuery("");
        setError(null);
        setLoading(false);
        logEvent("navigation_back_to_home", "Navigation", "fresh_chat_reset");
      } else if (currentPath.startsWith("/chat/")) {
        // Navigate to a specific conversation via browser history
        handleUrlBasedLoading();
      }
    };

    // Listen for browser back/forward button
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteConfig, setMessageState, setError, setLoading, handleUrlBasedLoading, loading]);
  // Note: handleStop is used inside handlePopState but is defined later. It's a stable function reference.

  // Custom hook for displaying popup messages
  const { showPopup, closePopup, popupMessage } = usePopup("1.03", "");

  // Function to handle collection change
  const handleCollectionChange = (newCollection: string) => {
    if (getEnableAuthorSelection(siteConfig) && newCollection !== collection) {
      setCollectionChanged(true);
      setCollection(newCollection);
      logEvent("change_collection", "UI", newCollection);
    }
  };

  // Function to start a new chat conversation
  const handleNewChat = () => {
    // Stop any ongoing streaming before resetting
    if (loading) {
      handleStop();
    }

    // End temporary session if one is active
    if (temporarySession) {
      setTemporarySession(false);
      logEvent("end_temporary_session", "UI", "new_chat_button");
    }

    // Clear task state (helper setters update both state and ref)
    setIsTaskConversation(false);
    setCurrentTaskFollowups([]);
    setUsedTaskFollowups([]);
    setCurrentTaskMode(null);
    setDynamicFollowups([]);

    // Push a new history entry for '/' without triggering a Next.js navigation.
    window.history.pushState(null, "", "/");
    pathRef.current = "/";
    // Immediately reset local chat state so UI clears without waiting for
    // handleUrlBasedLoading. This guarantees the New-Chat button and the
    // "Ask" nav item always start from a blank conversation.
    setCurrentConvId(null);
    setConversationTitle(null);
    setCurrentQuestion("");
    setAnswerFeedbackPromptDocId(null);
    answerFeedbackPromptConsumedRef.current = false;
    savedDocIdRef.current = null;
    resetRetrievalFiltersToDefaults();
    setMessageState({
      messages: [
        {
          message: getGreeting(siteConfig),
          type: "apiMessage",
        },
      ],
      history: [],
    });
    setError(null);
    setViewOnlyMode(false);

    // Focus on the input field if not on mobile
    if (window.innerWidth >= 768 && textAreaRef.current) {
      textAreaRef.current.focus();
    }

    // Log analytics event
    logEvent("new_chat_started", "Chat", "header_button");
  };

  // Function to handle when a conversation is deleted from sidebar
  const handleConversationDeleted = (deletedConvId: string) => {
    // Stop any ongoing streaming before resetting
    if (loading) {
      handleStop();
    }

    // End temporary session if one is active
    if (temporarySession) {
      setTemporarySession(false);
      logEvent("end_temporary_session", "UI", "conversation_deleted");
    }

    // Immediately reset local chat state BEFORE navigation to prevent race condition
    setCurrentConvId(null);
    setCurrentQuestion("");
    setConversationTitle(null);
    setIsCurrentConversationStarred(false);
    setAnswerFeedbackPromptDocId(null);
    answerFeedbackPromptConsumedRef.current = false;
    savedDocIdRef.current = null;
    resetRetrievalFiltersToDefaults();
    setMessageState({
      messages: [
        {
          message: getGreeting(siteConfig),
          type: "apiMessage",
        },
      ],
      history: [],
    });
    setError(null);
    setViewOnlyMode(false);

    // Update path refs before navigation to prevent handleUrlBasedLoading race
    pathRef.current = "/";
    previousPathRef.current = "/";

    // Navigate to home page AFTER clearing state
    router.push("/");

    // Focus on the input field if not on mobile
    if (window.innerWidth >= 768 && textAreaRef.current) {
      textAreaRef.current.focus();
    }

    // Reload sidebar to clear any stale state
    sidebarRefetchRef.current();

    // Log analytics event
    logEvent("conversation_deleted_reset_chat", "Chat History", deletedConvId);
  };

  // State for managing collection queries
  const [collectionQueries, setCollectionQueries] = useState({});
  const [isLoadingQueries, setIsLoadingQueries] = useState(true);

  // State for managing API request cancellation
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  // Function to stop ongoing API request
  const handleStop = useCallback(() => {
    if (abortController) {
      abortController.abort();
      setLoading(false);
      setAbortController(null);
    }
  }, [abortController, setLoading, setAbortController]);

  const [, setSourceDocs] = useState<Document[] | null>(null);

  const [, setMessageContainerBottom] = useState(0);
  const [, setViewportHeight] = useState(0);

  // Active-stream docId lives in savedDocIdRef (declared above) so clears are synchronous.
  const accumulatedResponseRef = useRef("");
  // Pin SSE model events to the in-flight answer (not the greeting) when model arrives before React flushes state
  const streamingAnswerIndexRef = useRef<number | null>(null);
  const pendingStreamModelRef = useRef<string | null>(null);

  // State for editing questions
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  // Task state
  const [currentTaskFollowups, _setCurrentTaskFollowups] = useState<string[]>([]);
  const currentTaskFollowupsRef = useRef<string[]>([]); // Ref mirror for immediate access in async contexts
  const [usedTaskFollowups, _setUsedTaskFollowups] = useState<string[]>([]); // Track used follow-ups to hide them
  const usedTaskFollowupsRef = useRef<string[]>([]); // Ref mirror for immediate access in async contexts
  const [isTaskConversation, _setIsTaskConversation] = useState<boolean>(false);
  const isTaskConversationRef = useRef<boolean>(false); // Ref mirror for immediate access in async contexts
  const [_currentTaskMode, _setCurrentTaskMode] = useState<string | null>(null);
  const currentTaskModeRef = useRef<string | null>(null); // Ref mirror for immediate access in async contexts
  const [dynamicFollowups, setDynamicFollowups] = useState<string[]>([]); // AI-generated context-specific follow-ups
  const [isLoadingDynamicFollowups, setIsLoadingDynamicFollowups] = useState<boolean>(false);

  // Helper setters that update both state and ref for task-related values
  const setCurrentTaskFollowups = (followups: string[]) => {
    currentTaskFollowupsRef.current = followups;
    _setCurrentTaskFollowups(followups);
  };
  const setUsedTaskFollowups = (used: string[]) => {
    usedTaskFollowupsRef.current = used;
    _setUsedTaskFollowups(used);
  };
  const setIsTaskConversation = (isTask: boolean) => {
    isTaskConversationRef.current = isTask;
    _setIsTaskConversation(isTask);
  };
  const setCurrentTaskMode = (mode: string | null) => {
    currentTaskModeRef.current = mode;
    _setCurrentTaskMode(mode);
  };
  // Remove legacy browser-level search persistence so retrieval filters stay
  // scoped to the active conversation rather than silently carrying across chats.
  useEffect(() => {
    clearLegacyFilterStorage();
  }, [clearLegacyFilterStorage]);

  // Add state for timing information
  const [timingMetrics, setTimingMetrics] = useState<{
    ttfb?: number;
    total?: number;
    tokensPerSecond?: number;
    totalTokens?: number;
  } | null>(null);

  // Check if user is sudo (only relevant on no-login sites)
  const { isSudoUser } = useSudo();

  // Check if user is admin or superuser (for login-required sites)
  const [isAdminOrSuperuser, setIsAdminOrSuperuser] = useState(false);

  // Check admin/superuser status for login-required sites
  useEffect(() => {
    const checkAdminStatus = async () => {
      // Only check for login-required sites
      if (!siteConfig?.requireLogin) {
        setIsAdminOrSuperuser(false);
        return;
      }

      // Wait for token manager to initialize
      try {
        await initializeTokenManager();
      } catch {
        setIsAdminOrSuperuser(false);
        return;
      }

      // Check if user is authenticated
      if (!isAuthenticated()) {
        setIsAdminOrSuperuser(false);
        return;
      }

      // Check sessionStorage cache first (1-hour TTL)
      try {
        const cached = sessionStorage.getItem("userRole");
        if (cached) {
          const parsed = JSON.parse(cached);
          const isExpired = Date.now() - parsed.timestamp > 60 * 60 * 1000;
          if (!isExpired && parsed.role) {
            const isAdmin = parsed.role === "admin" || parsed.role === "superuser";
            setIsAdminOrSuperuser(isAdmin);
            return;
          }
        }
      } catch {
        // Invalid cache, continue to API call
      }

      // Make API call to check role
      try {
        const res = await fetch("/api/profile", { credentials: "include" });
        if (!res.ok) {
          setIsAdminOrSuperuser(false);
          return;
        }

        const data = await res.json();
        const role = (data?.role as string) || "user";
        const isAdmin = role === "admin" || role === "superuser";

        // Cache the result
        try {
          sessionStorage.setItem(
            "userRole",
            JSON.stringify({
              role,
              timestamp: Date.now(),
            })
          );
        } catch {
          // sessionStorage failed, continue without caching
        }

        setIsAdminOrSuperuser(isAdmin);
      } catch {
        setIsAdminOrSuperuser(false);
      }
    };

    checkAdminStatus();
  }, [siteConfig?.requireLogin]);

  const applyStreamModel = useCallback((model: string) => {
    pendingStreamModelRef.current = model;
    setMessageState((prevState) => {
      const updatedMessages = [...prevState.messages];
      const targetIndex = streamingAnswerIndexRef.current ?? updatedMessages.length - 1;
      if (targetIndex < 0 || targetIndex >= updatedMessages.length) {
        return prevState;
      }
      const targetMessage = updatedMessages[targetIndex];
      if (targetMessage?.type !== "apiMessage") {
        return prevState;
      }
      updatedMessages[targetIndex] = {
        ...targetMessage,
        model,
      };
      return {
        ...prevState,
        messages: updatedMessages,
      };
    });
  }, [setMessageState]);

  const updateMessageState = useCallback(
    (newResponse: string, newSourceDocs: Document[] | null) => {
      setMessageState((prevState) => {
        const updatedMessages = [...prevState.messages];
        const targetIndex = streamingAnswerIndexRef.current ?? updatedMessages.length - 1;
        const lastMessage = updatedMessages[targetIndex];

        if (lastMessage?.type === "apiMessage") {
          // Preserve the docId if it exists when updating the message
          const existingDocId = lastMessage.docId;
          updatedMessages[targetIndex] = {
            ...lastMessage,
            message: newResponse,
            sourceDocs: newSourceDocs ? [...newSourceDocs] : lastMessage.sourceDocs || [],
            // Keep the docId if it was already set
            ...(existingDocId && { docId: existingDocId }),
            ...(pendingStreamModelRef.current && { model: pendingStreamModelRef.current }),
          };
        } else {
          console.warn("Expected last message to be apiMessage but found:", lastMessage?.type);
        }

        // Update the last assistant message in the history
        const updatedHistory = [...prevState.history];
        if (updatedHistory.length > 0) {
          // Last item should be an assistant message (role === 'assistant')
          const lastIndex = updatedHistory.length - 1;
          if (updatedHistory[lastIndex].role === "assistant") {
            updatedHistory[lastIndex] = {
              role: "assistant",
              content: newResponse,
            };
          }
        }

        return {
          ...prevState,
          messages: updatedMessages,
          history: updatedHistory,
        };
      });

      // Force a check for viewport overflow
      setTimeout(() => {
        const messageList = messageListRef.current;
        if (!messageList) return;

        // Get container position relative to viewport
        const containerRect = messageList.getBoundingClientRect();

        // Get current viewport height
        const vh = window.innerHeight;
        setViewportHeight(vh);

        // Store the bottom position of the message container
        setMessageContainerBottom(containerRect.bottom);

        // Determine if the message container overflows the viewport
        const overflowsViewport = containerRect.bottom > vh;

        // Show button when the bottom of the container extends beyond viewport
        if (overflowsViewport) {
          // Check if we are already effectively at the bottom of the scrollable content
          // Only show if NOT near the bottom unless the user clicked once already (state 1)
          const { scrollTop, scrollHeight, clientHeight } = messageList;
          const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
          const isNearContentBottom = scrollHeight > clientHeight && distanceFromBottom <= 20;

          if (!isNearContentBottom) {
            setShowScrollDownButton(true);
          } else {
            // Content overflows, but we are scrolled to the bottom of it,
            // and haven't clicked the button yet (state 0). Hide it for now.
            // Clicking will make it reappear via handleScrollDownClick.
            // Scrolling up will make it reappear via handleScroll.
            // Don't hide during streaming - use ref to get current value (not stale closure)
            if (!loadingRef.current) {
              setShowScrollDownButton(false);
            }
          }
        } else {
          // Hide button if content doesn't overflow viewport
          // Don't hide during streaming - use ref to get current value (not stale closure)
          if (!loadingRef.current) {
            setShowScrollDownButton(false);
          }
          setScrollClickState(0); // Reset click state if content fits
        }
      }, 50);
    },
    [setMessageState]
  );

  const handleStreamingResponse = useCallback(
    (data: StreamingResponseData) => {
      if (data.siteId && siteConfig?.siteId && data.siteId !== siteConfig.siteId) {
        console.error(`ERROR: Backend is using incorrect site ID: ${data.siteId}. Expected: ${siteConfig.siteId}`);
      }

      if (data.log) {
        console.log("[BACKEND]", data.log);
      }

      if (data.titleScopeSuggestions) {
        setTitleScopeSuggestions(data.titleScopeSuggestions);
        setTitleScopeError(data.error || null);
      }

      if (data.filterConflict) {
        if (autoApplySourceFocusConflict(data.filterConflict)) {
          return;
        }
        setFilterConflict(data.filterConflict);
        setError(null);
        setMessageState((prevState) => {
          const newMessages = [...prevState.messages];
          const lastMessage = newMessages[newMessages.length - 1];
          if (lastMessage?.type === "apiMessage") {
            newMessages[newMessages.length - 1] = {
              ...lastMessage,
              message: data.filterConflict!.summaryMessage,
            };
          }
          const newHistory = [...prevState.history];
          if (newHistory.length > 0 && newHistory[newHistory.length - 1].role === "assistant") {
            newHistory[newHistory.length - 1] = {
              ...newHistory[newHistory.length - 1],
              content: data.filterConflict!.summaryMessage,
            };
          }
          return {
            ...prevState,
            messages: newMessages,
            history: newHistory,
          };
        });
      }

      // Capture timing information
      if (data.timing) {
        setTimingMetrics(data.timing);
      }

      if (data.model) {
        applyStreamModel(data.model);
      }

      if (data.status === "searching_locations") {
        // Status-only UX; must not append to accumulated stream or affect timing
        updateMessageState("Searching locations...", null);
      }

      if (data.token) {
        accumulatedResponseRef.current += data.token;
        updateMessageState(accumulatedResponseRef.current, null);

        // Any new content should reset the scroll state
        // This ensures clicking the button after new content arrives
        // will always scroll to content bottom first
        setScrollClickState(0);

        // Force scroll button to show when streaming content - always visible during streaming
        setShowScrollDownButton(true);
      }

      if (data.sourceDocs) {
        setTimeout(() => {
          const immutableSourceDocs = Array.isArray(data.sourceDocs) ? [...data.sourceDocs] : [];
          setSourceDocs(immutableSourceDocs);
          updateMessageState(accumulatedResponseRef.current, immutableSourceDocs);
        }, 0);
      }

      if (data.docId) {
        // Save the docId with the message immediately (buttons won't show until loading=false)
        setMessageState((prevState) => {
          const updatedMessages = [...prevState.messages];
          const targetIndex = streamingAnswerIndexRef.current ?? updatedMessages.length - 1;
          const targetMessage = updatedMessages[targetIndex];

          if (targetMessage?.type === "apiMessage") {
            updatedMessages[targetIndex] = {
              ...targetMessage,
              docId: data.docId,
              ...(pendingStreamModelRef.current && { model: pendingStreamModelRef.current }),
            };
          } else {
            console.warn(`No API message found to attach docId to`);
          }

          return {
            ...prevState,
            messages: updatedMessages,
          };
        });

        // Save the docId in a separate state variable for later reference
        // This ensures we have it even if the message object wasn't ready when it arrived
        rememberSavedDocId(data.docId);

        // docId often arrives after stream `done`; attempt prompt here so we don't miss it
        maybeShowAnswerFeedbackPromptRef.current(data.docId);
      }

      // Handle convId separately from docId (convId comes earlier in the stream)
      if (data.convId) {
        const isNewConversation = !currentConvIdRef.current;
        currentConvIdRef.current = data.convId;
        setCurrentConvId(data.convId);

        // For new conversations, update URL and sidebar
        if (isNewConversation) {
          // Only update URL for sites that support conversation history
          if (siteConfig?.requireLogin) {
            // Use pushState so the browser back button will return to '/'.
            window.history.pushState(null, "", `/chat/${data.convId}`);
            pathRef.current = `/chat/${data.convId}`;
          }

          // Add new conversation to sidebar (only for first question in conversation)
          // Only attempt if sidebar is enabled (requireLogin sites) and functions are available

          let questionForSidebar = currentQuestionRef.current;
          // Fallback: if for some reason currentQuestionRef is empty (e.g. Fast Refresh in dev)
          if (!questionForSidebar) {
            const lastUserMsg = [...messages].reverse().find((m) => m.type === "userMessage") as
              | ExtendedAIMessage
              | undefined;
            if (lastUserMsg?.message) {
              questionForSidebar = lastUserMsg.message;
            }
          }

          if (siteConfig?.requireLogin && sidebarFunctionsRef.current && questionForSidebar) {
            // Create a temporary title from the question (target ~12 words)
            const questionWords = questionForSidebar.trim().split(/\s+/);
            const tempTitle =
              questionWords.length <= 9 ? questionForSidebar : questionWords.slice(0, 9).join(" ") + "...";
            sidebarFunctionsRef.current.addNewConversation(data.convId, tempTitle, questionForSidebar);

            // Clear the current question now that we've used it
            setCurrentQuestion("");
          }
        }
        // Note: For follow-up questions, URL stays the same since convId is consistent
      }

      // Handle AI-generated title updates
      if (data.title && data.convId && sidebarFunctionsRef.current) {
        sidebarFunctionsRef.current.updateConversationTitle(data.convId, data.title);
        // Update page title if this is the current conversation
        if (data.convId === currentConvIdRef.current) {
          setConversationTitle(data.title);
        }
      }

      // Handle follow-up question suggestions
      if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        setMessageState((prevState) => {
          const newMessages = [...prevState.messages];
          const lastMessage = newMessages[newMessages.length - 1];

          if (lastMessage && lastMessage.type === "apiMessage") {
            // Add suggestions to the last AI message
            newMessages[newMessages.length - 1] = {
              ...lastMessage,
              suggestions: data.suggestions,
            };
          }

          return {
            ...prevState,
            messages: newMessages,
          };
        });
      }

      if (data.done) {
        // Check for docId one more time right when done is received.
        // Immediately set loading to false so the buttons appear right away
        setLoading(false);

        // Reset accumulated response when done
        accumulatedResponseRef.current = "";
        streamingAnswerIndexRef.current = null;
        pendingStreamModelRef.current = null;

        // Soft feedback nudge after the first completed answer of this conversation.
        // Only use the just-finished API message's docId — never an older answer's.
        setTimeout(() => {
          setMessageState((prevState) => {
            let apiMessage = prevState.messages[prevState.messages.length - 1];
            if (apiMessage?.type !== "apiMessage") {
              for (let i = prevState.messages.length - 1; i >= 0; i--) {
                if (prevState.messages[i].type === "apiMessage") {
                  apiMessage = prevState.messages[i];
                  break;
                }
              }
            }
            maybeShowAnswerFeedbackPromptRef.current(apiMessage?.docId);
            return prevState;
          });
        }, 0);

        // After streaming ends, check scroll position and keep button visible if user is not at bottom
        setTimeout(() => {
          const messageList = messageListRef.current;
          if (messageList) {
            const { scrollTop, scrollHeight, clientHeight } = messageList;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
            const threshold = 50;
            // Keep button visible if user has scrolled away from bottom
            if (scrollHeight > clientHeight && distanceFromBottom > threshold) {
              setShowScrollDownButton(true);
            }
          }
        }, 100);

        // Generate dynamic follow-ups for task conversations
        // Use a small delay to ensure message state is fully updated
        if (isTaskConversationRef.current) {
          setTimeout(() => {
            setMessageState((prevState) => {
              // Find the last Q&A pair
              const messages = prevState.messages;
              let lastQuestion = "";
              let lastAnswer = "";

              for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.type === "apiMessage" && !lastAnswer) {
                  lastAnswer = msg.message || "";
                } else if (msg.type === "userMessage" && lastAnswer && !lastQuestion) {
                  lastQuestion = msg.message || "";
                  break;
                }
              }

              if (lastQuestion && lastAnswer) {
                // Fire-and-forget the API call (don't block state update)
                generateDynamicFollowups(lastQuestion, lastAnswer);
              }

              return prevState; // No state change
            });
          }, 100);
        }

        // Force a state update to ensure UI re-renders immediately with buttons and correct docId
        // Also update history with the actual assistant response content (critical for reformulation)
        setMessageState((prevState) => {
          // Check all messages to find the API message we need to update
          let apiMessageIndex = prevState.messages.length - 1;
          let apiMessage = prevState.messages[apiMessageIndex];

          // If the last message isn't an API message, look for the most recent one
          if (apiMessage.type !== "apiMessage" && prevState.messages.length >= 2) {
            for (let i = prevState.messages.length - 1; i >= 0; i--) {
              if (prevState.messages[i].type === "apiMessage") {
                apiMessageIndex = i;
                apiMessage = prevState.messages[i];
                break;
              }
            }
          }

          // Update the history's last assistant content with the actual response
          // This is critical for question reformulation to have proper context
          const updatedHistory = [...prevState.history];
          if (updatedHistory.length > 0 && apiMessage.type === "apiMessage" && apiMessage.message) {
            // Find the last assistant entry in history and update it
            for (let i = updatedHistory.length - 1; i >= 0; i--) {
              if (updatedHistory[i].role === "assistant" && updatedHistory[i].content === "") {
                updatedHistory[i] = { ...updatedHistory[i], content: apiMessage.message };
                break;
              }
            }
          }

          // If we have a saved docId but the API message doesn't have one, update it.
          // Use the ref so a prior turn's id cannot leak after clearSavedDocId().
          const docIdToStamp = savedDocIdRef.current;
          if (apiMessage.type === "apiMessage" && !apiMessage.docId && docIdToStamp) {
            // Create a new messages array with the updated API message
            const updatedMessages = [...prevState.messages];
            updatedMessages[apiMessageIndex] = {
              ...apiMessage,
              docId: docIdToStamp,
            };

            return {
              ...prevState,
              messages: updatedMessages,
              history: updatedHistory,
            };
          }

          return { ...prevState, history: updatedHistory };
        });
      }

      if (data.error) {
        console.error(`Stream ERROR:`, data.error);
        setError(data.error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      updateMessageState,
      applyStreamModel,
      sourceCount,
      setLoading,
      setError,
      rememberSavedDocId,
      setMessageState,
      setSourceDocs,
      setScrollClickState,
      setShowScrollDownButton,
      setTimingMetrics,
      siteConfig?.siteId,
      siteConfig?.requireLogin,
      messages,
      showScrollDownButton,
      autoApplySourceFocusConflict,
      setFilterConflict,
    ]
  );

  // Main function to handle chat submission
  const handleSubmit = async (e: React.FormEvent, submittedQuery: string) => {
    e.preventDefault();
    if (submittedQuery.trim() === "") return;

    await ensureVisitorUuidReady(siteConfig?.requireLogin === true);

    // Capture if this is a task submission before resetting (needed to reset sourceCount after API call)
    const wasTaskSubmission = isTaskSubmissionRef.current;

    // Keep task mode active for any submission while in a task conversation
    // (whether from follow-up chip or custom text input)
    if (isTaskConversationRef.current) {
      // Clear dynamic follow-ups when submitting a new question in task mode
      // They'll be regenerated after the response completes
      setDynamicFollowups([]);
    }
    // Reset task submission flag
    isTaskSubmissionRef.current = false;

    // Store the current question for sidebar updates
    setCurrentQuestion(submittedQuery);

    // Reset timing metrics when starting a new query
    setTimingMetrics(null);

    if (submittedQuery.length > 4000) {
      setError("Input must be 4000 characters or less");
      return;
    }

    if (loading) {
      handleStop();
      return;
    }

    setIsNearBottom(true);
    setLoading(true);
    setError(null);
    setFilterConflict(null);

    // Reset accumulated response at the start of each new query
    accumulatedResponseRef.current = "";
    streamingAnswerIndexRef.current = messageState.messages.length + 1;
    pendingStreamModelRef.current = null;
    // Prevent a prior answer's docId from being stamped onto this stream on `done`
    clearSavedDocId();

    // Check if this is the second question or later (more than 2 messages = greeting + first Q&A)
    const isSecondQuestionOrLater = messageState.messages.length > 2;
    const newUserMessageIndex = messageState.messages.length;

    // Fresh chat (greeting only): allow the first-answer feedback prompt even if a prior
    // /chat/... load left the consumed flag set without going through New Chat.
    if (messageState.messages.length <= 1) {
      answerFeedbackPromptConsumedRef.current = false;
      setAnswerFeedbackPromptDocId(null);
    }

    // Add user message to the state
    setMessageState((prevState) => {
      return {
        ...prevState,
        messages: [
          ...prevState.messages,
          { type: "userMessage", message: submittedQuery } as ExtendedAIMessage,
          // Add an empty API message immediately so it's ready for the docId
          {
            type: "apiMessage",
            message: "",
            sourceDocs: [],
            model: pendingStreamModelRef.current ?? undefined,
          } as ExtendedAIMessage,
        ],
        history: [...prevState.history, { role: "user", content: submittedQuery }, { role: "assistant", content: "" }],
      };
    });

    // Scroll to the new user message if it's the second question or later
    if (isSecondQuestionOrLater) {
      // Use requestAnimationFrame + setTimeout to ensure the DOM has updated with the new message
      requestAnimationFrame(() => {
        setTimeout(() => {
          const userMessageElement = userMessageRefs.current.get(newUserMessageIndex);
          if (userMessageElement) {
            userMessageElement.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 100);
      });
    }

    // Clear the input
    setQuery("");

    // Focus on the input field if not on mobile
    if (window.innerWidth >= 768 && textAreaRef.current) {
      textAreaRef.current.focus();
    }

    try {
      const newAbortController = new AbortController();
      setAbortController(newAbortController);
      const requestTitleScope =
        siteConfig?.enableTitleScopeSelection && selectedTitleScopeRef.current
          ? selectedTitleScopeRef.current
          : undefined;
      if (requestTitleScope) {
        logEvent(
          "source_focus_query_submitted",
          "Source Focus",
          requestTitleScope.canonicalPrefix ||
            requestTitleScope.displayTitle ||
            requestTitleScope.userInput ||
            "unknown"
        );
      }

      const response = await fetchWithAuth("/api/chat/v1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: submittedQuery,
          history: historyRef.current,
          collection,
          temporarySession,
          mediaTypes,
          selectedLibraries: selectedLibrariesRef.current,
          titleScope: requestTitleScope,
          filterExplicitness: buildFilterExplicitnessPayloadFn(),
          sourceCount: sourceCountRef.current,
          uuid: getOrCreateUUID(),
          convId: currentConvIdRef.current, // Pass current conversation ID for follow-ups
          // Use refs for task state since this function may be called from stale closures
          taskMode: currentTaskModeRef.current || undefined, // Pass task mode for persistence
          taskFollowups: isTaskConversationRef.current ? currentTaskFollowupsRef.current : undefined, // Pass task follow-ups for persistence
          usedTaskFollowups: isTaskConversationRef.current ? usedTaskFollowupsRef.current : undefined, // Use ref for immediate access
        }),
        signal: newAbortController.signal,
      });

      // Reset sourceCount to default after task submission (task sourceCount only applies to first query)
      if (wasTaskSubmission) {
        const defaultSources = siteConfig?.defaultNumSources || 4;
        setSourceCount(defaultSources);
      }

      if (!response.ok) {
        setLoading(false);
        const errorData = await response.json();
        setError(errorData.error || response.statusText);
        return;
      }

      const data = response.body;
      if (!data) {
        setLoading(false);
        setError("No data returned from the server");
        return;
      }

      const reader = data.getReader();
      await readSseStream(reader, (line) => {
        if (!line.startsWith("data: ")) {
          return;
        }
        try {
          const jsonData = parseSseDataLine(line) as StreamingResponseData;
          handleStreamingResponse(jsonData);
        } catch (parseError) {
          console.error("Error parsing JSON:", parseError);
        }
      });

      setLoading(false);
    } catch (error) {
      // Don't show error if user intentionally stopped the request
      const isAbortError = error instanceof DOMException && error.name === "AbortError";
      if (!isAbortError) {
        console.error("Error in handleSubmit:", error);
        setError(error instanceof Error ? error.message : "An error occurred while streaming the response.");
      }
      setLoading(false);
    }
  };

  // Function to handle 'Enter' key press in the input field
  const handleEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>, submittedQuery: string) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (!loading) {
        e.preventDefault();
        setIsNearBottom(true);
        handleSubmit(new Event("submit") as unknown as React.FormEvent, submittedQuery);

        // Focus on the input field if not on mobile
        if (window.innerWidth >= 768 && textAreaRef.current) {
          textAreaRef.current.focus();
        }
      }
    }
  };

  // Function to handle input change in the chat input field
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQuery(e.target.value);
  };

  // Function to handle suggestion pill clicks
  const handleSuggestionClick = (suggestion: TypedSuggestion, position: number) => {
    void recordSuggestionPillClick(suggestion, position, currentConvIdRef.current, fetchWithAuth);
    handleSubmit(new Event("submit") as unknown as React.FormEvent, suggestion.text);
  };

  // Handle task wizard submission
  const handleTaskSubmit = useCallback(
    (prompt: string, taskSourceCount: number, taskMode: string, followups: string[], authorFilter?: string) => {
      // Set task conversation state
      setIsTaskConversation(true);
      setCurrentTaskFollowups(followups);
      setCurrentTaskMode(taskMode);

      // Override sourceCount for this task
      setSourceCount(taskSourceCount);

      // Override collection/author filter if specified by the task
      if (authorFilter) {
        const collectionValue = authorFilter === "master-swami" ? "master_swami" : "whole_library";
        setCollection(collectionValue);
      }

      // Mark as task submission
      isTaskSubmissionRef.current = true;

      // Inject prompt and submit
      setQuery(prompt);
      handleSubmit(new Event("submit") as unknown as React.FormEvent, prompt);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // handleSubmit has too many deps to memoize; callback only used on wizard submit
  );

  // Generate dynamic (AI-generated) follow-ups after streaming completes
  const generateDynamicFollowups = useCallback(
    async (question: string, answer: string) => {
      // Only generate for task conversations
      if (!isTaskConversationRef.current) {
        return;
      }

      setIsLoadingDynamicFollowups(true);
      try {
        const response = await fetchWithAuth("/api/generateFollowups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            answer,
            taskMode: currentTaskModeRef.current || undefined,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.followups && Array.isArray(data.followups) && data.followups.length > 0) {
            setDynamicFollowups(data.followups);
          }
        } else {
          console.warn("Failed to generate dynamic follow-ups:", response.status);
        }
      } catch (error) {
        console.error("Error generating dynamic follow-ups:", error);
      } finally {
        setIsLoadingDynamicFollowups(false);
      }
    },
    [] // No deps needed - uses refs for task state
  );

  // Handle follow-up chip click
  const handleFollowupSelect = useCallback(
    (suggestion: string) => {
      // Keep task conversation state - follow-ups are part of the task workflow
      // Mark as task submission so we don't clear task state
      isTaskSubmissionRef.current = true;

      // Track this follow-up as used so we don't show it again
      // Update ref immediately (sync) so handleSubmit can access it
      usedTaskFollowupsRef.current = [...usedTaskFollowupsRef.current, suggestion];
      setUsedTaskFollowups(usedTaskFollowupsRef.current);

      // Submit the follow-up as a regular question (but keep task context)
      handleSubmit(new Event("submit") as unknown as React.FormEvent, suggestion);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // handleSubmit has too many deps to memoize; callback only used on chip click
  );

  // Handle URL query params for pre-filled query with auto-submit (e.g., from Search page "Explain This")
  const hasAutoSubmittedRef = useRef(false);
  useEffect(() => {
    // Only run once per page load
    if (hasAutoSubmittedRef.current) return;

    const urlParams = new URLSearchParams(window.location.search);
    const queryParam = urlParams.get("q");
    const submitParam = urlParams.get("submit");

    if (queryParam && submitParam === "true") {
      hasAutoSubmittedRef.current = true;

      // Set the query in the input field
      setQuery(queryParam);

      // Auto-submit after a brief delay to ensure state is set
      setTimeout(() => {
        handleSubmit(new Event("submit") as unknown as React.FormEvent, queryParam);

        // Clean up URL params
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete("q");
        newUrl.searchParams.delete("submit");
        window.history.replaceState({}, document.title, newUrl.pathname + newUrl.search);
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // State for categorized queries
  const [categorizedQueries, setCategorizedQueries] = useState<{
    general: string[];
    location: string[];
    resources: string[];
  } | null>(null);

  // Effect to fetch collection queries on component mount
  useEffect(() => {
    let isMounted = true;
    async function fetchQueries() {
      if (siteConfig) {
        setIsLoadingQueries(true);
        const queries = await getCollectionQueries(siteConfig.siteId, siteConfig.collectionConfig);
        if (isMounted) {
          setCollectionQueries(queries);

          // Try to load categorized queries for current collection
          const { getCategorizedQueries } = await import("@/utils/client/collectionQueries");
          const categorized = await getCategorizedQueries(
            siteConfig.siteId,
            collection,
            siteConfig.collectionConfig
          );
          if (categorized && isMounted) {
            setCategorizedQueries(categorized);
          } else {
            setCategorizedQueries(null);
          }

          setIsLoadingQueries(false);
        }
      }
    }
    fetchQueries();
    return () => {
      isMounted = false;
    };
  }, [siteConfig, collection]);

  // Memoized queries for the current collection (flat list for backward compatibility)
  const queriesForCollection = useMemo(() => {
    return getQueriesForCollection(collection, collectionQueries, siteConfig?.collectionConfig);
  }, [collection, collectionQueries, siteConfig?.collectionConfig]);

  // Custom hook for managing suggested queries (fallback for non-categorized)
  const { suggestedQueries, shuffleQueries } = useSuggestedQueries(queriesForCollection, 3);

  // Helper function to determine if user has completed any Q&A (show suggestions until first Q&A)
  const shouldShowSuggestions = useMemo(() => computeShouldShowSuggestions(messages), [messages]);

  const shouldUsePinnedChatShell = computeShouldUsePinnedChatShell(Boolean(siteConfig?.requireLogin), messages.length);

  // Function to handle temporary session changes
  const handleTemporarySessionChange = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (temporarySession) {
      // If already in a temporary session, end it and clear the interface like new chat
      logEvent("end_temporary_session", "UI", "");

      // Stop any ongoing streaming before resetting
      if (loading) {
        handleStop();
      }

      // Reset temporary session state
      setTemporarySession(false);

      // Push a new history entry for '/' without triggering a Next.js navigation
      window.history.pushState(null, "", "/");
      pathRef.current = "/";

      // Immediately reset local chat state so UI clears without waiting for
      // handleUrlBasedLoading. This guarantees ending temporary session clears the conversation.
      setCurrentConvId(null);
      setCurrentQuestion("");
      resetRetrievalFiltersToDefaults();
      setMessageState({
        messages: [
          {
            message: getGreeting(siteConfig),
            type: "apiMessage",
          },
        ],
        history: [],
      });
      setError(null);
      setViewOnlyMode(false);

      // Focus on the input field if not on mobile
      if (window.innerWidth >= 768 && textAreaRef.current) {
        textAreaRef.current.focus();
      }

      // Reload sidebar to clear any stale state
      sidebarRefetchRef.current();
    } else {
      // Start a temporary session
      setTemporarySession(true);
      logEvent("start_temporary_session", "UI", "");

      // Focus on the input field if not on mobile
      if (window.innerWidth >= 768 && textAreaRef.current) {
        textAreaRef.current.focus();
      }
    }
  };

  // State for managing voting functionality
  const [votes, setVotes] = useState<Record<string, number>>({});
  const [voteError, setVoteError] = useState<string | null>(null);

  // State for the feedback modal
  const [isFeedbackModalOpen, setIsFeedbackModalOpen] = useState<boolean>(false);
  const [currentFeedbackDocId, setCurrentFeedbackDocId] = useState<string | null>(null);
  const [feedbackSubmitError, setFeedbackSubmitError] = useState<string | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState<boolean>(false);

  // Soft "How did we do?" prompt helpers
  const dismissAnswerFeedbackPrompt = useCallback(() => {
    setAnswerFeedbackPromptDocId(null);
    answerFeedbackPromptConsumedRef.current = true;
  }, []);

  const maybeShowAnswerFeedbackPrompt = useCallback(
    (docId: string | undefined | null) => {
      if (
        !docId ||
        siteConfig?.enableAnswerFeedbackPrompt !== true ||
        temporarySession ||
        viewOnlyMode ||
        answerFeedbackPromptConsumedRef.current
      ) {
        return;
      }
      answerFeedbackPromptConsumedRef.current = true;
      setAnswerFeedbackPromptDocId(docId);
      logEvent("answer_feedback_prompt_shown", "Engagement", docId);
    },
    [siteConfig?.enableAnswerFeedbackPrompt, temporarySession, viewOnlyMode]
  );
  maybeShowAnswerFeedbackPromptRef.current = maybeShowAnswerFeedbackPrompt;

  // Function to handle voting on answers - MODIFIED
  const handleVote = (docId: string, isUpvote: boolean) => {
    setVoteError(null); // Clear previous errors
    setFeedbackSubmitError(null); // Clear feedback error

    if (answerFeedbackPromptDocId === docId) {
      dismissAnswerFeedbackPrompt();
    }

    const currentVote = votes[docId] || 0; // Get current vote status

    if (isUpvote) {
      // Upvote logic: uses handleVoteUtil which handles toggling 1 <-> 0
      if (currentVote === 1) {
        // If already upvoted, clicking again should clear the vote (set to 0)
        logEvent("clear_upvote", "Engagement", docId, 0);
      }
      handleVoteUtil(docId, isUpvote, votes, setVotes, setVoteError);
    } else {
      // Downvote logic:
      if (currentVote === -1) {
        // If already downvoted, clicking again should clear the vote (set to 0)
        // Use handleVoteUtil, passing isUpvote=false correctly triggers the toggle logic 0 <-> -1
        handleVoteUtil(docId, isUpvote, votes, setVotes, setVoteError);
        logEvent("clear_downvote", "Engagement", docId);
      } else {
        // If not currently downvoted (-1), open the feedback modal
        setCurrentFeedbackDocId(docId);
        setIsFeedbackModalOpen(true);
        logEvent("open_feedback_modal", "Engagement", docId);
      }
    }
  };

  // Function to submit feedback - NEW
  const submitFeedback = async (docId: string, reason: string, comment: string, shareIdentity: boolean) => {
    setFeedbackSubmitError(null); // Clear previous errors before trying
    setFeedbackSubmitting(true);
    try {
      const response = await fetchWithAuth("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, vote: -1, reason, comment, shareIdentity }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to submit feedback (${response.status})`);
      }

      // If successful:
      setVotes((prev) => ({ ...prev, [docId]: -1 })); // Update UI to show downvote
      setIsFeedbackModalOpen(false); // Close modal
      setCurrentFeedbackDocId(null);
      logEvent("submit_feedback", "Engagement", `${reason}:${shareIdentity ? "identified" : "anonymous"}`); // Log feedback event

      // Show a success toast
      toast.success("Feedback submitted. Thank you!");
    } catch (error) {
      console.error("Error submitting feedback:", error);
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
      setFeedbackSubmitError(errorMessage); // Show error in the modal
      // Keep the modal open for the user to see the error
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  // Function to cancel feedback - NEW
  const cancelFeedback = () => {
    if (feedbackSubmitting) {
      return;
    }
    setIsFeedbackModalOpen(false);
    setCurrentFeedbackDocId(null);
    setFeedbackSubmitError(null); // Clear any errors shown in modal
    logEvent("cancel_feedback", "Engagement", "");
  };

  // Function to handle answer regeneration
  const handleRegenerateAnswer = useCallback(
    async (messageIndex: number) => {
      if (loading) return; // Prevent regeneration during active loading

      const apiMessage = messages[messageIndex];
      if (apiMessage.type !== "apiMessage") return;

      const userMessage = messages[messageIndex - 1];
      if (!userMessage || userMessage.type !== "userMessage") return;

      logEvent("regenerate_answer_clicked", "Engagement", `Message Index: ${messageIndex}`);

      setLoading(true);
      setError(null);
      setTitleScopeSuggestions([]);
      setTitleScopeError(null);
      accumulatedResponseRef.current = "";
      streamingAnswerIndexRef.current = messageIndex;
      pendingStreamModelRef.current = null;

      try {
        const newAbortController = new AbortController();
        setAbortController(newAbortController);
        const response = await fetchWithAuth("/api/chat/v1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: userMessage.message,
            history: historyRef.current.slice(0, messageIndex - 1), // Include conversation history before this Q&A pair
            collection: apiMessage.collection || collection,
            mediaTypes: mediaTypes,
            selectedLibraries: selectedLibrariesRef.current,
            titleScope:
              isTitleScopeSelectionEnabled && selectedTitleScopeRef.current ? selectedTitleScopeRef.current : undefined,
            filterExplicitness: buildFilterExplicitnessPayloadFn(),
            sourceCount: apiMessage.sourceDocs?.length || sourceCountRef.current,
            temporarySession: temporarySession,
            uuid: getOrCreateUUID(),
            convId: currentConvIdRef.current,
          }),
          signal: newAbortController.signal,
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        setFilterConflict(null);

        // Replace the existing message with an empty one to prepare for streaming
        setMessageState((prevState) => {
          const newMessages = [...prevState.messages];
          newMessages[messageIndex] = {
            type: "apiMessage",
            message: "",
            sourceDocs: [],
          };
          return {
            ...prevState,
            messages: newMessages,
          };
        });

        const reader = response.body.getReader();

        await readSseStream(reader, (line) => {
          if (!line.startsWith("data: ")) {
            return;
          }
          try {
            const data = parseSseDataLine(line) as StreamingResponseData;

            if (data.filterConflict) {
              const filterConflict = data.filterConflict;
              if (autoApplySourceFocusConflict(filterConflict)) {
                return;
              }
              setFilterConflict(filterConflict);
              setMessageState((prevState) => {
                const newMessages = [...prevState.messages];
                newMessages[messageIndex] = {
                  ...newMessages[messageIndex],
                  message: filterConflict.summaryMessage,
                };
                const newHistory = [...prevState.history];
                const historyIndex = messageIndex - 1;
                if (
                  historyIndex >= 0 &&
                  historyIndex < newHistory.length &&
                  newHistory[historyIndex]?.role === "assistant"
                ) {
                  newHistory[historyIndex] = {
                    ...newHistory[historyIndex],
                    content: filterConflict.summaryMessage,
                  };
                }
                return {
                  ...prevState,
                  messages: newMessages,
                  history: newHistory,
                };
              });
            }

            if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
              setMessageState((prevState) => {
                const newMessages = [...prevState.messages];
                const targetMessage = newMessages[messageIndex];
                if (targetMessage?.type === "apiMessage") {
                  newMessages[messageIndex] = {
                    ...targetMessage,
                    suggestions: data.suggestions,
                  };
                }
                return {
                  ...prevState,
                  messages: newMessages,
                };
              });
            }

            if (data.model) {
              pendingStreamModelRef.current = data.model;
              setMessageState((prevState) => {
                const newMessages = [...prevState.messages];
                newMessages[messageIndex] = {
                  ...newMessages[messageIndex],
                  model: data.model,
                };
                return {
                  ...prevState,
                  messages: newMessages,
                };
              });
            }

            if (data.status === "searching_locations") {
              setMessageState((prevState) => {
                const newMessages = [...prevState.messages];
                newMessages[messageIndex] = {
                  ...newMessages[messageIndex],
                  message: "Searching locations...",
                };
                return {
                  ...prevState,
                  messages: newMessages,
                };
              });
            }

            if (data.token) {
              accumulatedResponseRef.current += data.token;
              setMessageState((prevState) => {
                const newMessages = [...prevState.messages];
                newMessages[messageIndex] = {
                  ...newMessages[messageIndex],
                  message: accumulatedResponseRef.current,
                };
                return {
                  ...prevState,
                  messages: newMessages,
                };
              });
            }

            if (data.sourceDocs) {
              const immutableSourceDocs = Array.isArray(data.sourceDocs) ? [...data.sourceDocs] : [];
              setMessageState((prevState) => {
                const newMessages = [...prevState.messages];
                newMessages[messageIndex] = {
                  ...newMessages[messageIndex],
                  sourceDocs: immutableSourceDocs,
                };
                return {
                  ...prevState,
                  messages: newMessages,
                };
              });
            }

            if (data.docId) {
              setMessageState((prevState) => {
                const newMessages = [...prevState.messages];
                newMessages[messageIndex] = {
                  ...newMessages[messageIndex],
                  docId: data.docId,
                };
                return {
                  ...prevState,
                  messages: newMessages,
                };
              });
            }

            if (data.convId) {
              const isNewConversation = !currentConvIdRef.current;
              currentConvIdRef.current = data.convId;
              setCurrentConvId(data.convId);

              if (isNewConversation) {
                if (siteConfig?.requireLogin) {
                  window.history.pushState(null, "", `/chat/${data.convId}`);
                  pathRef.current = `/chat/${data.convId}`;
                }

                const questionForSidebar = userMessage.message;
                if (siteConfig?.requireLogin && sidebarFunctionsRef.current && questionForSidebar) {
                  const questionWords = questionForSidebar.trim().split(/\s+/);
                  const tempTitle =
                    questionWords.length <= 9 ? questionForSidebar : questionWords.slice(0, 9).join(" ") + "...";
                  sidebarFunctionsRef.current.addNewConversation(data.convId, tempTitle, questionForSidebar);
                  setCurrentQuestion("");
                }
              }
            }

            if (data.title && data.convId) {
              if (sidebarFunctionsRef.current) {
                sidebarFunctionsRef.current.updateConversationTitle(data.convId, data.title);
              }
              if (data.convId === currentConvIdRef.current) {
                setConversationTitle(data.title);
              }
            }

            if (data.done) {
              // Update history with the regenerated response at the correct index
              // messageIndex is the API message index, history index is messageIndex - 1
              // (because history doesn't include the greeting message at index 0)
              setMessageState((prevState) => {
                const regeneratedMessage = prevState.messages[messageIndex];
                const historyIndex = messageIndex - 1;
                if (
                  historyIndex >= 0 &&
                  historyIndex < prevState.history.length &&
                  prevState.history[historyIndex]?.role === "assistant" &&
                  regeneratedMessage?.message
                ) {
                  const updatedHistory = [...prevState.history];
                  updatedHistory[historyIndex] = {
                    ...updatedHistory[historyIndex],
                    content: regeneratedMessage.message,
                  };
                  return { ...prevState, history: updatedHistory };
                }
                return prevState;
              });
              setLoading(false);
              accumulatedResponseRef.current = "";
              streamingAnswerIndexRef.current = null;
              pendingStreamModelRef.current = null;
            }
          } catch (e) {
            console.error("Error parsing SSE data:", e);
          }
        });

        setLoading(false);
      } catch (error) {
        // Don't show error if user intentionally stopped the request
        const isAbortError = error instanceof DOMException && error.name === "AbortError";
        if (!isAbortError) {
          console.error("Error regenerating answer:", error);
          toast.error("Failed to regenerate answer. Please try again.");
          setError(error instanceof Error ? error.message : "An error occurred while regenerating the answer.");
        }
        setLoading(false);
      }
    },
    [
      loading,
      messages,
      collection,
      mediaTypes,
      temporarySession,
      isTitleScopeSelectionEnabled,
      buildFilterExplicitnessPayloadFn,
      siteConfig?.requireLogin,
      setLoading,
      setError,
      setMessageState,
      autoApplySourceFocusConflict,
    ]
  );

  useEffect(() => {
    if (!pendingConflictRetry || loading) {
      return;
    }

    const retryIndex = (() => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.type === "apiMessage") {
          return index;
        }
      }
      return null;
    })();
    setPendingConflictRetry(false);
    if (retryIndex === null) {
      return;
    }
    handleRegenerateAnswer(retryIndex);
  }, [handleRegenerateAnswer, loading, messages, pendingConflictRetry]);

  // Function to handle starting question edit
  const handleEditQuestion = useCallback((messageIndex: number, originalText: string) => {
    setEditingMessageIndex(messageIndex);
    setEditingText(originalText);
    logEvent("edit_question_started", "Engagement", `Message Index: ${messageIndex}`);
  }, []);

  // Function to handle canceling question edit
  const handleCancelEdit = useCallback((messageIndex: number) => {
    setEditingMessageIndex(null);
    setEditingText("");
    logEvent("edit_question_cancelled", "Engagement", `Message Index: ${messageIndex}`);
  }, []);

  // Function to handle saving edited question
  const handleSaveEdit = useCallback(
    async (messageIndex: number, editedText: string) => {
      if (!editedText.trim()) {
        toast.error("Question cannot be empty");
        return;
      }

      logEvent("edit_question_saved", "Engagement", `Message Index: ${messageIndex}`);

      // Kill any ongoing stream
      if (abortController) {
        abortController.abort();
        setAbortController(null);
      }

      setLoading(true);
      setError(null);
      setEditingMessageIndex(null);
      setEditingText("");

      try {
        // Find the API message after this user message
        const apiMessageIndex = messageIndex + 1;
        const apiMessage = messages[apiMessageIndex];

        // Get the docId if it exists (for deleting from Firestore)
        const docIdToDelete = apiMessage?.docId;

        // Delete follow-up messages from UI (everything after the answer to this question)
        // This includes the answer itself and any follow-up Q&A pairs
        const newMessages = messages.slice(0, messageIndex + 1); // Keep user message and everything before it
        const newHistory = messageState.history.slice(0, messageIndex - 1); // FIXED: Exclude the edited user message from prior history

        // Update the user message with edited text
        newMessages[messageIndex] = {
          ...newMessages[messageIndex],
          message: editedText,
        };

        setMessageState({
          messages: newMessages,
          history: newHistory,
        });

        // Delete from Firestore if docId exists
        if (docIdToDelete && currentConvIdRef.current) {
          try {
            await fetchWithAuth("/api/deleteFollowUpMessages", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                convId: currentConvIdRef.current,
                startAfterDocId: docIdToDelete,
              }),
            });
          } catch (error) {
            console.error("Error deleting follow-up messages from Firestore:", error);
            // Continue even if deletion fails
          }
        }

        // Resubmit the edited question
        const newAbortController = new AbortController();
        setAbortController(newAbortController);

        const response = await fetchWithAuth("/api/chat/v1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collection,
            question: editedText,
            history: newHistory,
            temporarySession,
            mediaTypes,
            selectedLibraries: selectedLibrariesRef.current,
            titleScope:
              isTitleScopeSelectionEnabled && selectedTitleScopeRef.current ? selectedTitleScopeRef.current : undefined,
            filterExplicitness: buildFilterExplicitnessPayloadFn(),
            sourceCount: sourceCountRef.current,
            uuid: getOrCreateUUID(),
            convId: currentConvIdRef.current,
          }),
          signal: newAbortController.signal,
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        setFilterConflict(null);

        // Add empty API message for streaming
        streamingAnswerIndexRef.current = messageIndex + 1;
        pendingStreamModelRef.current = null;
        setMessageState((prevState) => ({
          ...prevState,
          messages: [
            ...prevState.messages,
            {
              type: "apiMessage",
              message: "",
              sourceDocs: [],
              model: pendingStreamModelRef.current ?? undefined,
            },
          ],
          history: [...prevState.history, { role: "user", content: editedText }, { role: "assistant", content: "" }],
        }));

        // Handle streaming response
        const reader = response.body.getReader();
        accumulatedResponseRef.current = "";

        await readSseStream(reader, (line) => {
          if (!line.startsWith("data: ")) {
            return;
          }
          try {
            const data = parseSseDataLine(line) as StreamingResponseData;

            if (data.filterConflict) {
              const filterConflict = data.filterConflict;
              if (autoApplySourceFocusConflict(filterConflict)) {
                return;
              }
              setFilterConflict(filterConflict);
              setError(null);
              updateMessageState(filterConflict.summaryMessage, null);
              setMessageState((prevState) => {
                const updatedHistory = [...prevState.history];
                if (updatedHistory.length > 0 && updatedHistory[updatedHistory.length - 1].role === "assistant") {
                  updatedHistory[updatedHistory.length - 1] = {
                    ...updatedHistory[updatedHistory.length - 1],
                    content: filterConflict.summaryMessage,
                  };
                }
                return { ...prevState, history: updatedHistory };
              });
            }

            if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
              setMessageState((prevState) => {
                const updatedMessages = [...prevState.messages];
                const lastMessage = updatedMessages[updatedMessages.length - 1];
                if (lastMessage?.type === "apiMessage") {
                  updatedMessages[updatedMessages.length - 1] = {
                    ...lastMessage,
                    suggestions: data.suggestions,
                  };
                }
                return {
                  ...prevState,
                  messages: updatedMessages,
                };
              });
            }

            if (data.model) {
              applyStreamModel(data.model);
            }

            if (data.status === "searching_locations") {
              updateMessageState("Searching locations...", null);
            }

            if (data.token) {
              accumulatedResponseRef.current += data.token;
              updateMessageState(accumulatedResponseRef.current, null);
            }

            if (data.sourceDocs) {
              const immutableSourceDocs = Array.isArray(data.sourceDocs) ? [...data.sourceDocs] : [];
              setSourceDocs(immutableSourceDocs);
              updateMessageState(accumulatedResponseRef.current, immutableSourceDocs);
            }

            if (data.docId) {
              setMessageState((prevState) => {
                const updatedMessages = [...prevState.messages];
                const targetIndex = streamingAnswerIndexRef.current ?? updatedMessages.length - 1;
                const targetMessage = updatedMessages[targetIndex];
                if (targetMessage?.type === "apiMessage") {
                  updatedMessages[targetIndex] = {
                    ...targetMessage,
                    docId: data.docId,
                    ...(pendingStreamModelRef.current && { model: pendingStreamModelRef.current }),
                  };
                }
                return {
                  ...prevState,
                  messages: updatedMessages,
                };
              });
              rememberSavedDocId(data.docId);
            }

            if (data.convId) {
              setCurrentConvId(data.convId);
            }

            if (data.done) {
              // Update history with actual assistant response content (critical for reformulation)
              setMessageState((prevState) => {
                const targetIndex = streamingAnswerIndexRef.current ?? prevState.messages.length - 1;
                const lastMessage = prevState.messages[targetIndex];
                const updatedHistory = [...prevState.history];
                if (updatedHistory.length > 0 && lastMessage?.type === "apiMessage" && lastMessage.message) {
                  // Find the last assistant entry in history and update it
                  for (let i = updatedHistory.length - 1; i >= 0; i--) {
                    if (updatedHistory[i].role === "assistant" && updatedHistory[i].content === "") {
                      updatedHistory[i] = { ...updatedHistory[i], content: lastMessage.message };
                      break;
                    }
                  }
                }
                return { ...prevState, history: updatedHistory };
              });
              setLoading(false);
              accumulatedResponseRef.current = "";
              streamingAnswerIndexRef.current = null;
              pendingStreamModelRef.current = null;
            }
          } catch (e) {
            console.error("Error parsing SSE data:", e);
          }
        });

        setLoading(false);
      } catch (error) {
        // Don't show error if user intentionally stopped the request
        const isAbortError = error instanceof DOMException && error.name === "AbortError";
        if (!isAbortError) {
          console.error("Error saving edited question:", error);
          toast.error("Failed to save edited question. Please try again.");
          setError(error instanceof Error ? error.message : "An error occurred while saving the edited question.");
        }
        setLoading(false);
      }
    },
    [
      messages,
      messageState.history,
      collection,
      temporarySession,
      mediaTypes,
      abortController,
      setMessageState,
      setLoading,
      setError,
      setAbortController,
      updateMessageState,
      applyStreamModel,
      setSourceDocs,
      rememberSavedDocId,
      setCurrentConvId,
      isTitleScopeSelectionEnabled,
      buildFilterExplicitnessPayloadFn,
      autoApplySourceFocusConflict,
    ]
  );

  // Function to handle copying answer links
  const handleCopyLink = (answerId: string) => {
    const url = `${window.location.origin}/share/${answerId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(answerId);
      setTimeout(() => setLinkCopied(null), 2000);
      logEvent("copy_link", "Engagement", `Answer ID: ${answerId}`);
    });
  };

  /**
   * SOURCE DEEP LINKING FEATURE
   *
   * This feature allows users to create shareable links that point directly to specific audio/video sources
   * within a conversation. When someone clicks a deep link (e.g., /chat/abc123#source-audio-xyz), the page
   * will automatically:
   * 1. Scroll to the target source
   * 2. Expand the collapsed source element
   * 3. Highlight the source with a yellow fade animation
   *
   * How it works:
   * - Users can click a "link" icon button next to audio players or YouTube videos to copy a deep link
   * - The link includes a hash fragment like #source-audio-{file_hash} or #source-youtube-{videoId}
   * - Source IDs are generated from stable metadata (file_hash for audio, video ID for YouTube)
   * - When the page loads with a hash fragment, we find the matching source and expand/highlight it
   * - Browser back/forward navigation is supported via hashchange event listener
   *
   * This feature works on both:
   * - Share pages (/share/[docId]#source-xxx) - for non-owners viewing shared conversations
   * - Chat pages (/chat/[convId]#source-xxx) - for owners viewing their own conversations
   *
   * Related components:
   * - AudioPlayer: Has link button that copies deep link URL
   * - SourcesList: Renders sources with stable IDs and handles expansion state
   * - sourceUtils.ts: Contains generateSourceId() and generateSourceDeepLink() utilities
   */

  // Handle source expansion callback - tracks which sources should be expanded for deep linking
  const handleSourceExpanded = useCallback((index: number) => {
    sourceExpandedRef.current.add(index);
  }, []);

  // Handle source link copy callback - provides visual feedback when user copies a source deep link
  const handleSourceLinkCopied = useCallback((sourceId: string) => {
    setSourceLinkCopied(sourceId);
    setTimeout(() => {
      setSourceLinkCopied(null);
    }, 2000);
  }, []);

  /**
   * Deep linking: Handle hash fragment changes for source deep links
   * This effect listens for hash changes (e.g., browser back/forward, direct navigation)
   * and automatically expands, scrolls to, and highlights the target source.
   * Handles both initial page load with hash and subsequent hash changes.
   */
  useEffect(() => {
    // Wait for loading to complete and messages to be available
    if (loading || !messages.length) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    // Additional check: ensure we have sourceDocs in at least one message
    const hasSources = messages.some((msg) => msg.sourceDocs && msg.sourceDocs.length > 0);
    if (!hasSources) {
      return;
    }

    const performScroll = (sourceElement: HTMLElement, sourceId: string, isInitialLoad: boolean) => {
      // Prevent browser's automatic scroll by temporarily removing hash
      const hash = window.location.hash;
      if (isInitialLoad && hash) {
        // Temporarily remove hash to prevent browser's automatic scroll
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }

      // Scroll to element (block: "start" respects scroll-margin-top on the element)
      sourceElement.scrollIntoView({ behavior: "smooth", block: "start" });

      // Restore hash after a brief delay
      if (isInitialLoad && hash) {
        setTimeout(() => {
          window.history.replaceState(null, "", hash);
        }, 100);
      }

      logEvent(isInitialLoad ? "source_deep_link_activated" : "source_deep_link_navigated", "Chat", sourceId);
    };

    const scrollToSource = (sourceId: string, isInitialLoad: boolean) => {
      // Find source in messages and expand it
      for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const message = messages[msgIndex];
        if (message.sourceDocs) {
          const sourceIndex = message.sourceDocs.findIndex((doc) => generateSourceId(doc) === sourceId);
          if (sourceIndex !== -1) {
            handleSourceExpanded(sourceIndex);
            break;
          }
        }
      }

      // Use multiple requestAnimationFrame calls to ensure DOM is fully ready
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const sourceElement = document.getElementById(sourceId);
            if (sourceElement) {
              // Expand the details element if it's collapsed
              const detailsElement = sourceElement.closest("details");
              if (detailsElement && !detailsElement.hasAttribute("open")) {
                detailsElement.setAttribute("open", "true");
                // Wait for details to expand and React to re-render before scrolling
                setTimeout(() => {
                  // Double-check element still exists after React re-render
                  const updatedElement = document.getElementById(sourceId);
                  if (updatedElement) {
                    performScroll(updatedElement, sourceId, isInitialLoad);
                  }
                }, 150);
              } else {
                performScroll(sourceElement, sourceId, isInitialLoad);
              }
            }
          }, 150);
        });
      });
    };

    const handleHashChange = (isInitialLoad = false) => {
      const hash = window.location.hash;

      if (!hash || !hash.startsWith("#source-")) {
        if (!hash) {
          handledHashRef.current = null;
        }
        return;
      }

      if (isInitialLoad && handledHashRef.current === hash) {
        return;
      }

      handledHashRef.current = hash;
      const sourceId = hash.substring(1);
      scrollToSource(sourceId, isInitialLoad);
    };

    // Handle initial hash on mount (guard prevents duplicate handling)
    handleHashChange(true);

    // Listen for hash changes (browser back/forward)
    const onHashChange = () => handleHashChange(false);
    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [loading, messages, handleSourceExpanded]);

  // Reset handledHashRef when conversation changes to allow hash processing after redirect
  useEffect(() => {
    if (currentConvId) {
      // Clear the handled hash ref when switching conversations
      // This ensures deep links work after redirect from share page
      handledHashRef.current = null;
    }
  }, [currentConvId]);

  // Sync star state when conversation or conversations list changes
  useEffect(() => {
    if (currentConvId) {
      const currentConv = conversations.find((c) => c.convId === currentConvId);
      const newStarState = currentConv?.isStarred || false;
      setIsCurrentConversationStarred(newStarState);
    } else {
      setIsCurrentConversationStarred(false);
    }
  }, [currentConvId, conversations]);

  // Keep fresh-chat state aligned with site defaults and clear any legacy filter persistence.
  useEffect(() => {
    const isActuallyFreshChat = messageState.messages.length <= 1 && messageState.history.length === 0;
    if (pathRef.current === "/" && !currentConvIdRef.current && !isActuallyFreshChat) {
      return;
    }
    if (pathRef.current === "/" && !currentConvIdRef.current) {
      setCollection(defaultCollection);
      setCollectionChanged(false);
      setMediaTypes(defaultMediaTypes);
      setSelectedLibraries(defaultLibraries);
      setSourceCount(defaultSourceCount);
      handleTitleScopeChange(null);
      setPendingConflictRetry(false);
    }

    if (!isLoadingQueries && window.innerWidth > 768) {
      textAreaRef.current?.focus();
    }
  }, [
    defaultCollection,
    defaultLibraries,
    defaultMediaTypes,
    defaultSourceCount,
    isLoadingQueries,
    loading,
    messageState.history.length,
    messageState.messages.length,
    handleTitleScopeChange,
  ]);

  // Custom hook to check if multiple collections are available
  const hasMultipleCollections = useMultipleCollections(siteConfig || undefined);

  // Function to handle clicking on suggested queries
  const handleClick = (clickedQuery: string) => {
    setQuery(clickedQuery);
    setIsNearBottom(true);

    // Calculate the index of the new user message that will be added
    // It will be at messages.length (current messages + new user message)
    const newUserMessageIndex = messages.length;
    setHighlightMessageIndex(newUserMessageIndex);

    handleSubmit(new Event("submit") as unknown as React.FormEvent, clickedQuery);

    // Focus on the input field if not on mobile
    if (window.innerWidth >= 768 && textAreaRef.current) {
      textAreaRef.current.focus();
    }
  };

  // Effect to scroll to and highlight newly added user message from suggested queries
  useEffect(() => {
    if (highlightMessageIndex !== null) {
      // Wait for DOM to update with the new message
      const timer = setTimeout(() => {
        const messageElement = userMessageRefs.current.get(highlightMessageIndex);
        if (messageElement) {
          // Scroll to the message with smooth behavior
          messageElement.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });

          // Add highlight animation class
          messageElement.classList.add("animate-pulse");
          messageElement.style.backgroundColor = "rgba(59, 130, 246, 0.1)"; // Light blue highlight
          messageElement.style.transition = "background-color 0.3s ease";

          // Remove highlight after animation
          setTimeout(() => {
            messageElement.classList.remove("animate-pulse");
            messageElement.style.backgroundColor = "";
            setHighlightMessageIndex(null);
          }, 2000);
        } else {
          // If element not found yet, try again after a short delay
          setTimeout(() => {
            const retryElement = userMessageRefs.current.get(highlightMessageIndex);
            if (retryElement) {
              retryElement.scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
              retryElement.classList.add("animate-pulse");
              retryElement.style.backgroundColor = "rgba(59, 130, 246, 0.1)";
              retryElement.style.transition = "background-color 0.3s ease";
              setTimeout(() => {
                retryElement.classList.remove("animate-pulse");
                retryElement.style.backgroundColor = "";
                setHighlightMessageIndex(null);
              }, 2000);
            } else {
              // Fallback: scroll to bottom if element not found
              bottomOfListRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "end",
              });
              setHighlightMessageIndex(null);
            }
          }, 100);
        }
      }, 50);

      return () => clearTimeout(timer);
    }
  }, [highlightMessageIndex, messages.length]);

  // Function to format timing metrics for display
  const formatTimingMetrics = useCallback(() => formatTimingMetricsDisplay(timingMetrics), [timingMetrics]);

  // Function to handle scroll behavior and button visibility
  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) return;

    // Note: We don't force-show the button when loading starts.
    // The updateMessageState callback will show it when content actually overflows.
    // The key fix is preventing HIDING during streaming (via loadingRef.current check).

    // Function to check scroll position and update button visibility
    const handleScroll = () => {
      // Don't update button visibility during streaming - it's always shown
      if (loading) {
        return;
      }

      const { scrollTop, scrollHeight, clientHeight } = messageList;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const hasScrollbar = scrollHeight > clientHeight;
      const threshold = 50; // Increased threshold to prevent flickering

      // Show button if user has scrolled away from bottom
      if (hasScrollbar && distanceFromBottom > threshold) {
        setShowScrollDownButton(true);
      } else if (hasScrollbar && distanceFromBottom <= threshold) {
        // Hide if we're at the bottom
        setShowScrollDownButton(false);
      } else {
        // No scrollbar - hide button
        setShowScrollDownButton(false);
      }
    };

    // Window scroll handler - only used for page-level scrolling, not content scrolling
    const handleWindowScroll = () => {
      // Don't update during streaming
      if (loading) {
        return;
      }

      const messageList = messageListRef.current;
      if (!messageList) return;

      const { scrollTop, scrollHeight, clientHeight } = messageList;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const threshold = 50;

      // Only update if content area has scrolled away from bottom
      if (scrollHeight > clientHeight && distanceFromBottom > threshold) {
        setShowScrollDownButton(true);
      }
    };

    // Add scroll listeners
    messageList.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("scroll", handleWindowScroll, { passive: true });

    // Check initial scroll position
    handleScroll();
    handleWindowScroll();

    return () => {
      messageList.removeEventListener("scroll", handleScroll);
      window.removeEventListener("scroll", handleWindowScroll);
    };
  }, [loading]);

  // Re-check scroll position when follow-up suggestions are added after streaming ends
  // This fixes the bug where user scrolls to bottom before suggestions arrive, then suggestions render
  // but the scroll button doesn't appear even though there's new content below
  // Handles both:
  // 1. Regular suggestions (Go deeper/Go broader chips) - from lastMessageSuggestions
  // 2. Task dynamic follow-ups (AI-generated task-specific chips) - from dynamicFollowups
  const lastMessageSuggestions = messages[messages.length - 1]?.suggestions;
  useEffect(() => {
    // Only run when not loading (suggestions arrive after streaming ends)
    if (loading) return;

    // Skip if no suggestions (initial render or cleared state)
    const hasSuggestions =
      (lastMessageSuggestions && lastMessageSuggestions.length > 0) ||
      (dynamicFollowups && dynamicFollowups.length > 0);
    if (!hasSuggestions) return;

    // Check scroll position after DOM updates with new suggestions
    const timeoutId = setTimeout(() => {
      const messageList = messageListRef.current;
      if (!messageList) return;

      const { scrollTop, scrollHeight, clientHeight } = messageList;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const threshold = 50;

      // Show button if there's content below current scroll position
      if (scrollHeight > clientHeight && distanceFromBottom > threshold) {
        setShowScrollDownButton(true);
        // Trigger shimmer animation to draw attention to the button
        setShimmerScrollButton(true);
      }
    }, 50); // Small delay to allow DOM to update

    return () => clearTimeout(timeoutId);
  }, [lastMessageSuggestions, dynamicFollowups, loading]);

  // Function to scroll to bottom when button clicked
  const handleScrollDownClick = () => {
    // Scroll to bottom of content and hide button
    bottomOfListRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
    setShowScrollDownButton(false);
    setScrollClickState(0);

    // Focus on the input field if not on mobile
    if (window.innerWidth >= 768 && textAreaRef.current) {
      textAreaRef.current.focus();
    }
  };

  // Render maintenance mode message if active
  if (isMaintenanceMode) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <h1 className="text-2xl font-bold mb-4">Site is currently under maintenance</h1>
        <p>Please check back later.</p>
      </div>
    );
  }

  // Main component render
  return (
    <SudoProvider disableChecks={!!siteConfig && !!siteConfig.requireLogin}>
      <Head>
        <title>{generatePageTitle()}</title>
      </Head>
      <Layout
        siteConfig={siteConfig}
        useWideLayout={siteConfig?.requireLogin}
        onNewChat={handleNewChat}
        temporarySession={temporarySession}
        onTemporarySessionChange={handleTemporarySessionChange}
        isChatEmpty={shouldShowSuggestions}
        hasConversation={shouldUsePinnedChatShell}
      >
        {showPopup && popupMessage && <Popup message={popupMessage} onClose={closePopup} siteConfig={siteConfig} />}

        <div className="flex h-full min-h-0">
          {/* Chat History Sidebar - Only show on sites that require login */}
          {siteConfig?.requireLogin && (
            <ChatHistorySidebar
              isOpen={sidebarOpen}
              onClose={() => {
                logEvent("chat_history_sidebar_close", "Chat History", "close_button");
                setSidebarOpen(false);
              }}
              onLoadConversation={handleLoadConversation}
              currentConvId={currentConvId}
              onGetSidebarFunctions={(functions, sidebarRefetch) => {
                handleSidebarFunctions(functions, () => {
                  sidebarRefetch();
                  logEvent("chat_history_sidebar_refetch", "Chat History", "sidebar_refetch");
                });
              }}
              onConversationDeleted={handleConversationDeleted}
              onStarChange={async (convId: string, isStarred: boolean) => {
                isStarChangeFromSidebarRef.current = true;
                await handleStarChange(convId, isStarred);
              }}
            />
          )}

          {/* Main Content Area */}
          <div className="flex flex-col flex-1 min-w-0 min-h-0 lg:ml-0 overflow-hidden">
            <div className="mx-auto w-full max-w-4xl px-4 flex flex-col h-full min-h-0">
              {/* Hamburger Menu Button - Only show on sites that require login */}
              {siteConfig?.requireLogin && (
                <div className="flex-shrink-0 lg:hidden flex items-center justify-between p-4 border-b border-gray-200">
                  <button
                    onClick={() => {
                      logEvent("chat_history_sidebar_open", "Chat History", "hamburger_menu");
                      setSidebarOpen(true);
                    }}
                    className="p-2 rounded-md hover:bg-gray-100"
                    aria-label="Open chat history"
                  >
                    <span className="material-icons text-gray-600">history</span>
                  </button>
                  <h1 className="text-lg font-semibold text-gray-900">Chat</h1>
                  <div className="w-10"></div> {/* Spacer for centering */}
                </div>
              )}
              {/* Conversation Title Bar - Only show on sites that require login */}
              {siteConfig?.requireLogin && (
                <div className="flex-shrink-0">
                  <ConversationTitleBar
                    convId={currentConvId}
                    title={conversationTitle}
                    isStarred={isCurrentConversationStarred}
                    onStarChange={handleStarChange}
                  />
                </div>
              )}
              {/* Temporary session banner */}
              {temporarySession && (
                <div className="flex-shrink-0 flex items-center justify-center mb-3 px-3 py-2 bg-purple-100 border border-purple-300 rounded-lg">
                  <span className="material-icons text-purple-600 text-lg mr-2">lock</span>
                  <span className="text-purple-800 text-sm font-medium">
                    Temporary Session Active. It will not be logged, saved, or shareable.
                    <button
                      onClick={handleTemporarySessionChange}
                      className="ml-2 px-2 py-1 text-xs bg-purple-200 hover:bg-purple-300 text-purple-800 rounded border border-purple-300 transition-colors"
                    >
                      End
                    </button>
                  </span>
                </div>
              )}
              {/* Conditional layout: centered for initial state, scrollable for conversation */}
              {shouldShowSuggestions ? (
                /* Initial centered layout - greeting and input centered on page */
                <div className="flex-1 flex items-center justify-center px-4 py-6 md:py-8 md:pb-20 lg:pb-24">
                  <div data-testid="landing-chat-layout" className="w-full max-w-3xl">
                    {/* Greeting message */}
                    <div className="text-center mb-8">
                      <h1 className="text-xl md:text-2xl font-semibold text-gray-800">{messages[0]?.message}</h1>
                    </div>
                    {/* ChatInput with suggestions - centered */}
                    <div className="w-full max-w-2xl mx-auto">
                      {isLoadingQueries ? null : (
                        <ChatInput
                          loading={loading}
                          disabled={viewOnlyMode}
                          handleSubmit={handleSubmit}
                          handleEnter={handleEnter}
                          handleClick={handleClick}
                          handleCollectionChange={handleCollectionChange}
                          collection={collection}
                          temporarySession={temporarySession}
                          error={chatError}
                          setError={setError}
                          suggestedQueries={suggestedQueries}
                          shuffleQueries={shuffleQueries}
                          textAreaRef={textAreaRef}
                          mediaTypes={mediaTypes}
                          handleMediaTypeChange={handleMediaTypeChange}
                          selectedLibraries={selectedLibraries}
                          handleLibraryChange={handleLibraryChange}
                          siteConfig={siteConfig}
                          input={query}
                          handleInputChange={handleInputChange}
                          setQuery={setQuery}
                          setShouldAutoScroll={setIsNearBottom}
                          handleStop={handleStop}
                          isNearBottom={isNearBottom}
                          setIsNearBottom={setIsNearBottom}
                          isLoadingQueries={isLoadingQueries}
                          sourceCount={sourceCount}
                          setSourceCount={setSourceCount}
                          selectedTitleScope={selectedTitleScope}
                          setSelectedTitleScope={handleTitleScopeChange}
                          titleScopeSuggestions={titleScopeSuggestions}
                          titleScopeError={titleScopeError}
                          filterConflict={filterConflict}
                          onApplyFilterConflictAction={applyFilterConflictAction}
                          onDismissFilterConflict={() => setFilterConflict(null)}
                          onTemporarySessionChange={handleTemporarySessionChange}
                          categorizedQueries={categorizedQueries}
                          shouldShowSuggestions={shouldShowSuggestions}
                          onTaskSubmit={handleTaskSubmit}
                        />
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                /* Conversation layout - messages scrollable, input at bottom */
                <>
                  {/* Wrapper for scrollable area and scroll button */}
                  <div className="flex-1 min-h-0 relative">
                    {/* Messages container - scrollable area */}
                    <div className="h-full overflow-hidden answers-container">
                      <div ref={messageListRef} className="h-full overflow-y-auto">
                        {/* Render chat messages */}
                        {messages.map((message, index) => (
                          <React.Fragment key={`chatMessage-${index}`}>
                            <div
                              ref={(el) => {
                                // Store ref for user messages to enable scrolling/highlighting
                                if (el && message.type === "userMessage") {
                                  userMessageRefs.current.set(index, el);
                                } else if (message.type !== "userMessage") {
                                  userMessageRefs.current.delete(index);
                                }
                              }}
                            >
                              <MessageItem
                                messageKey={`chatMessage-${index}`}
                                message={message}
                                previousMessage={index > 0 ? messages[index - 1] : undefined}
                                index={index}
                                isLastMessage={index === messages.length - 1}
                                loading={loading}
                                temporarySession={temporarySession}
                                collectionChanged={collectionChanged}
                                hasMultipleCollections={hasMultipleCollections}
                                linkCopied={linkCopied}
                                votes={votes}
                                siteConfig={siteConfig}
                                handleCopyLink={handleCopyLink}
                                handleVote={handleVote}
                                hideVoteButtons={
                                  Boolean(message.docId) && answerFeedbackPromptDocId === message.docId
                                }
                                lastMessageRef={lastMessageRef}
                                voteError={voteError}
                                allowAllAnswersPage={siteConfig?.allowAllAnswersPage ?? false}
                                onSuggestionClick={handleSuggestionClick}
                                onRegenerateAnswer={handleRegenerateAnswer}
                                onEditQuestion={handleEditQuestion}
                                isEditing={editingMessageIndex === index}
                                editingText={editingText}
                                onSaveEdit={handleSaveEdit}
                                onCancelEdit={handleCancelEdit}
                                sourceLinkCopied={sourceLinkCopied}
                                onSourceExpanded={handleSourceExpanded}
                                onSourceLinkCopied={handleSourceLinkCopied}
                                activeTitleScope={selectedTitleScope}
                                onFocusSourceScope={handleFocusSourceScope}
                                isTaskConversation={isTaskConversation && index === messages.length - 1}
                                taskFollowups={
                                  isTaskConversation && index === messages.length - 1
                                    ? currentTaskFollowups.filter((f) => !usedTaskFollowups.includes(f))
                                    : []
                                }
                                dynamicFollowups={
                                  isTaskConversation && index === messages.length - 1 ? dynamicFollowups : []
                                }
                                isLoadingDynamicFollowups={
                                  isTaskConversation && index === messages.length - 1 && isLoadingDynamicFollowups
                                }
                                onTaskFollowupClick={handleFollowupSelect}
                                isAdminOrSuperuser={isAdminOrSuperuser}
                                timingMetricsDisplay={
                                  (isSudoUser || isAdminOrSuperuser) &&
                                  timingMetrics &&
                                  !loading &&
                                  index === messages.length - 1 ? (
                                    <div className="text-xs text-gray-500 p-2 bg-gray-50 rounded m-2">
                                      {formatTimingMetrics()}
                                    </div>
                                  ) : undefined
                                }
                                answerFeedbackPrompt={
                                  message.type === "apiMessage" &&
                                  message.docId &&
                                  answerFeedbackPromptDocId === message.docId &&
                                  !loading ? (
                                    <AnswerFeedbackPrompt
                                      docId={message.docId}
                                      onUpvote={(docId) => handleVote(docId, true)}
                                      onDownvote={(docId) => handleVote(docId, false)}
                                      onDismiss={() => {
                                        dismissAnswerFeedbackPrompt();
                                        logEvent(
                                          "answer_feedback_prompt_dismissed",
                                          "Engagement",
                                          message.docId || ""
                                        );
                                      }}
                                    />
                                  ) : undefined
                                }
                              />
                            </div>

                          </React.Fragment>
                        ))}
                        {/* Bottom spacer to allow scrolling past last content item */}
                        <div ref={bottomOfListRef} className="h-4 md:h-1" />
                      </div>
                    </div>

                    {/* Animated Scroll Down Button - centered at bottom of scroll area */}
                    <div
                      ref={scrollButtonContainerRef}
                      className={`absolute z-50 bottom-4 left-1/2 -translate-x-1/2 transition-all duration-300 ease-out transform 
                      ${showScrollDownButton ? "translate-y-0 opacity-100 pointer-events-auto" : "translate-y-8 opacity-0 pointer-events-none"}`}
                      style={{ willChange: "transform, opacity" }}
                    >
                      <button
                        onClick={handleScrollDownClick}
                        onAnimationEnd={() => setShimmerScrollButton(false)}
                        aria-label="Scroll to bottom"
                        className={`bg-white text-gray-600 rounded-full shadow-lg hover:shadow-xl p-2 border border-gray-200 focus:outline-none ${shimmerScrollButton ? "scroll-button-shimmer" : ""}`}
                      >
                        <span className="material-icons text-xl">arrow_downward</span>
                      </button>
                    </div>
                  </div>
                  {/* Input area - pinned to bottom when conversation is active */}
                  <div className="flex-shrink-0 px-2 md:px-0 pb-2 bg-white relative z-10">
                    {/* Render chat input component */}
                    {isLoadingQueries ? null : (
                      <ChatInput
                        loading={loading}
                        disabled={viewOnlyMode}
                        handleSubmit={handleSubmit}
                        handleEnter={handleEnter}
                        handleClick={handleClick}
                        handleCollectionChange={handleCollectionChange}
                        collection={collection}
                        temporarySession={temporarySession}
                        error={chatError}
                        setError={setError}
                        suggestedQueries={suggestedQueries}
                        shuffleQueries={shuffleQueries}
                        textAreaRef={textAreaRef}
                        mediaTypes={mediaTypes}
                        handleMediaTypeChange={handleMediaTypeChange}
                        selectedLibraries={selectedLibraries}
                        handleLibraryChange={handleLibraryChange}
                        siteConfig={siteConfig}
                        input={query}
                        handleInputChange={handleInputChange}
                        setQuery={setQuery}
                        setShouldAutoScroll={setIsNearBottom}
                        handleStop={handleStop}
                        isNearBottom={isNearBottom}
                        setIsNearBottom={setIsNearBottom}
                        isLoadingQueries={isLoadingQueries}
                        sourceCount={sourceCount}
                        setSourceCount={setSourceCount}
                        selectedTitleScope={selectedTitleScope}
                        setSelectedTitleScope={handleTitleScopeChange}
                        titleScopeSuggestions={titleScopeSuggestions}
                        titleScopeError={titleScopeError}
                        filterConflict={filterConflict}
                        onApplyFilterConflictAction={applyFilterConflictAction}
                        onDismissFilterConflict={() => setFilterConflict(null)}
                        onTemporarySessionChange={handleTemporarySessionChange}
                        categorizedQueries={categorizedQueries}
                        shouldShowSuggestions={shouldShowSuggestions}
                        onTaskSubmit={handleTaskSubmit}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Render the Feedback Modal */}
        <DownvoteFeedbackModal
          isOpen={isFeedbackModalOpen}
          docId={currentFeedbackDocId}
          onConfirm={submitFeedback}
          onCancel={cancelFeedback}
          error={feedbackSubmitError} // Pass feedback-specific error
          isSubmitting={feedbackSubmitting}
        />

      </Layout>
    </SudoProvider>
  );
}
