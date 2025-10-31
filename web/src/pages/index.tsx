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
import { PasswordPromoBanner } from "@/components/PasswordPromoBanner";
import AnswerComparison from "@/components/AnswerComparison";
import ModelComparisonFeedbackModal from "@/components/ModelComparisonFeedbackModal";

// Hook imports
import usePopup from "@/hooks/usePopup";
import { useSuggestedQueries } from "@/hooks/useSuggestedQueries";
import { useChat } from "@/hooks/useChat";
import { useMultipleCollections } from "@/hooks/useMultipleCollections";

// Utility imports
import { logEvent } from "@/utils/client/analytics";
import { getCollectionQueries } from "@/utils/client/collectionQueries";
import { handleVote as handleVoteUtil } from "@/utils/client/voteHandler";
import { SiteConfig } from "@/types/siteConfig";
import {
  getSiteName,
  getCollectionsConfig,
  getEnableMediaTypeSelection,
  getEnableAuthorSelection,
  getEnabledMediaTypes,
} from "@/utils/client/siteConfig";
import { Document } from "langchain/document";

// Third-party library imports
import Cookies from "js-cookie";
import { toast } from "react-toastify";

import { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import { StreamingResponseData } from "@/types/StreamingResponseData";
import { SudoProvider, useSudo } from "@/contexts/SudoContext";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import { getOrCreateUUID } from "@/utils/client/uuid";
import { loadConversationByConvId } from "@/utils/client/conversationLoader";
import { getGreeting } from "@/utils/client/siteConfig";
import { SidebarFunctions, SidebarRefetch } from "@/components/ChatHistorySidebar";

// Custom hook for scroll depth tracking
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
  const [collection, setCollection] = useState(() => {
    const collections = getCollectionsConfig(siteConfig);
    return Object.keys(collections)[0] || "";
  });
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

  // Track current conversation ID for follow-up messages
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const currentConvIdRef = useRef<string | null>(null);

  // Track conversation title for HTML page title
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);

  // Generate page title based on conversation state
  const generatePageTitle = useCallback(() => {
    const siteName = getSiteName(siteConfig);

    if (conversationTitle) {
      return `${conversationTitle} - ${siteName}`;
    }

    // Default title for home page
    return siteName;
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

  // (Removed pushedConvIdRef – no longer needed now that we update URL via
  // window.history.replaceState without triggering navigation.)

  // UI state variables

  const [linkCopied, setLinkCopied] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);

  // Refs for DOM elements and scroll management
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const bottomOfListRef = useRef<HTMLDivElement>(null);
  const scrollButtonContainerRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollDownButton, setShowScrollDownButton] = useState(false);
  const [scrollClickState, setScrollClickState] = useState(0); // 0: initial, 1: scrolled to content
  // Track which user message to highlight when clicked from suggested queries
  const [highlightMessageIndex, setHighlightMessageIndex] = useState<number | null>(null);
  const userMessageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

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

        // Log analytics event
        logEvent("chat_history_conversation_loaded", "Chat History", convId, loadedConversation.messages.length);
      } catch (error) {
        console.error("Error loading conversation:", error);

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
    [siteConfig, setLoading, setError, setMessageState, setCurrentConvId]
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
      const convId = path.split("/chat/")[1];
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
    setCurrentConvId,
    setMessageState,
    setError,
    setViewOnlyMode,
    messageState.messages.length,
  ]);

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
      Cookies.set("selectedCollection", newCollection, { expires: 365 });
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

    // Push a new history entry for '/' without triggering a Next.js navigation.
    window.history.pushState(null, "", "/");
    pathRef.current = "/";
    // Immediately reset local chat state so UI clears without waiting for
    // handleUrlBasedLoading. This guarantees the New-Chat button and the
    // "Ask" nav item always start from a blank conversation.
    setCurrentConvId(null);
    setCurrentQuestion("");
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

  // Add a state variable to track the docId separately
  const [savedDocId, setSavedDocId] = useState<string | null>(null);
  const accumulatedResponseRef = useRef("");

  // State for editing questions
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  const [sourceCount, setSourceCount] = useState<number>(siteConfig?.defaultNumSources || 4);

  // Load saved search preferences from localStorage
  useEffect(() => {
    try {
      let preferencesLoaded = false;

      // Load media type preferences
      const savedMediaTypes = localStorage.getItem("searchMediaTypes");
      if (savedMediaTypes) {
        const parsedMediaTypes = JSON.parse(savedMediaTypes);
        setMediaTypes(parsedMediaTypes);
        preferencesLoaded = true;

        // Analytics for loaded media type preferences
        const enabledCount = Object.values(parsedMediaTypes).filter(Boolean).length;
        logEvent(
          "search_preferences_loaded",
          "Settings",
          `media_types_restored|text_${parsedMediaTypes.text}|audio_${parsedMediaTypes.audio}|youtube_${parsedMediaTypes.youtube}`,
          enabledCount
        );
      }

      // Load library selection preferences
      const savedLibraries = localStorage.getItem("selectedLibraries");
      if (savedLibraries) {
        const parsedLibraries = JSON.parse(savedLibraries);
        // Validate that saved libraries are still available in siteConfig
        const availableLibraries = (siteConfig?.includedLibraries || []).map((lib) =>
          typeof lib === "string" ? lib : lib.name
        );
        const validLibraries = parsedLibraries.filter((lib: string) => availableLibraries.includes(lib));
        // Only restore if there's at least one valid library
        if (validLibraries.length > 0) {
          setSelectedLibraries(validLibraries);
          preferencesLoaded = true;
          logEvent("search_preferences_loaded", "Settings", "libraries_restored", validLibraries.length);
        }
      }

      // Load extra sources preference
      const savedUseExtraSources = localStorage.getItem("useExtraSources");
      if (savedUseExtraSources !== null) {
        const useExtra = savedUseExtraSources === "true";
        const defaultSources = siteConfig?.defaultNumSources || 4;
        setSourceCount(useExtra ? 10 : defaultSources);
        preferencesLoaded = true;

        // Analytics for loaded source count preference
        logEvent("search_preferences_loaded", "Settings", "extra_sources_restored", useExtra ? 10 : defaultSources);
      }

      // Track if any preferences were loaded
      if (preferencesLoaded) {
        logEvent("search_preferences_loaded", "Settings", "preferences_restored_on_load");
      }
    } catch (error) {
      console.error("Error loading search preferences from localStorage:", error);

      // Analytics for localStorage errors
      logEvent("search_preferences_error", "Settings", "localStorage_parse_error");
    }
  }, [siteConfig?.defaultNumSources, siteConfig?.includedLibraries]);

  // Add state for timing information
  const [timingMetrics, setTimingMetrics] = useState<{
    ttfb?: number;
    total?: number;
    tokensPerSecond?: number;
    totalTokens?: number;
  } | null>(null);

  // Check if user is sudo (only relevant on no-login sites)
  const { isSudoUser } = useSudo();

  const updateMessageState = useCallback(
    (newResponse: string, newSourceDocs: Document[] | null) => {
      setMessageState((prevState) => {
        const updatedMessages = [...prevState.messages];
        const lastMessage = updatedMessages[updatedMessages.length - 1];

        if (lastMessage.type === "apiMessage") {
          // Preserve the docId if it exists when updating the message
          const existingDocId = lastMessage.docId;
          updatedMessages[updatedMessages.length - 1] = {
            ...lastMessage,
            message: newResponse,
            sourceDocs: newSourceDocs ? [...newSourceDocs] : lastMessage.sourceDocs || [],
            // Keep the docId if it was already set
            ...(existingDocId && { docId: existingDocId }),
          };
        } else {
          console.warn("Expected last message to be apiMessage but found:", lastMessage.type);
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

          if (!isNearContentBottom || scrollClickState === 1) {
            setShowScrollDownButton(true);
          } else {
            // Content overflows, but we are scrolled to the bottom of it,
            // and haven't clicked the button yet (state 0). Hide it for now.
            // Clicking will make it reappear via handleScrollDownClick.
            // Scrolling up will make it reappear via handleScroll.
            setShowScrollDownButton(false);
          }
        } else {
          // Hide button if content doesn't overflow viewport
          setShowScrollDownButton(false);
          setScrollClickState(0); // Reset click state if content fits
        }
      }, 50);
    },
    [setMessageState, scrollClickState]
  );

  const handleStreamingResponse = useCallback(
    (data: StreamingResponseData) => {
      if (data.siteId && siteConfig?.siteId && data.siteId !== siteConfig.siteId) {
        console.error(`ERROR: Backend is using incorrect site ID: ${data.siteId}. Expected: ${siteConfig.siteId}`);
      }

      if (data.log) {
        // eslint-disable-next-line no-console
        console.log("[BACKEND]", data.log);
      }

      // Capture timing information
      if (data.timing) {
        setTimingMetrics(data.timing);
      }

      if (data.token) {
        accumulatedResponseRef.current += data.token;
        updateMessageState(accumulatedResponseRef.current, null);

        // Any new content should reset the scroll state
        // This ensures clicking the button after new content arrives
        // will always scroll to content bottom first
        setScrollClickState(0);

        // Force scroll button to show when streaming content
        if (!showScrollDownButton) {
          setShowScrollDownButton(true);
        }
      }

      if (data.sourceDocs) {
        try {
          // DEBUG: Add extensive logging for sources debugging
          const receiveTimestamp = Date.now();
          console.log(
            `🔍 FRONTEND SOURCES DEBUG: Received sourceDocs at ${receiveTimestamp}, type:`,
            typeof data.sourceDocs,
            "isArray:",
            Array.isArray(data.sourceDocs)
          );

          setTimeout(() => {
            const processTimestamp = Date.now();
            const timeDiff = processTimestamp - receiveTimestamp;
            console.log(`🔍 FRONTEND SOURCES DEBUG: Processing sourceDocs after ${timeDiff}ms delay`);

            const immutableSourceDocs = Array.isArray(data.sourceDocs) ? [...data.sourceDocs] : [];

            console.log(`🔍 FRONTEND SOURCES DEBUG: Processed ${immutableSourceDocs.length} sources`);

            if (immutableSourceDocs.length < sourceCount) {
              console.error(
                `❌ FRONTEND SOURCES ERROR: Received ${immutableSourceDocs.length} sources, but ${sourceCount} were requested.`
              );
            }

            // DEBUG: Check if sources are properly structured
            if (immutableSourceDocs.length > 0) {
              const firstSource = immutableSourceDocs[0];
              console.log(`🔍 FRONTEND SOURCES DEBUG: First source structure:`, {
                hasPageContent: !!firstSource.pageContent,
                hasMetadata: !!firstSource.metadata,
                metadataKeys: firstSource.metadata ? Object.keys(firstSource.metadata) : "none",
              });
            }

            setSourceDocs(immutableSourceDocs);
            updateMessageState(accumulatedResponseRef.current, immutableSourceDocs);

            console.log(
              `✅ FRONTEND SOURCES DEBUG: Successfully updated state with ${immutableSourceDocs.length} sources`
            );
          }, 0);
        } catch (error) {
          console.error("❌ FRONTEND SOURCES ERROR: Error handling sourceDocs:", error);
          console.error("❌ FRONTEND SOURCES ERROR: Raw data.sourceDocs:", data.sourceDocs);
          // Fallback to empty array if parsing fails
          setSourceDocs([]);
          updateMessageState(accumulatedResponseRef.current, []);
        }
      }

      if (data.docId) {
        // Save the docId with the message immediately (buttons won't show until loading=false)
        setMessageState((prevState) => {
          const updatedMessages = [...prevState.messages];
          // Make sure we're getting the API message (it should be the last one)
          const lastMessage = updatedMessages[updatedMessages.length - 1];

          if (lastMessage.type === "apiMessage") {
            // Update the API message with the docId
            updatedMessages[updatedMessages.length - 1] = {
              ...lastMessage,
              docId: data.docId,
            };
          } else if (prevState.messages.length >= 2) {
            // If the last message isn't an API message, find the most recent API message
            for (let i = updatedMessages.length - 1; i >= 0; i--) {
              if (updatedMessages[i].type === "apiMessage") {
                updatedMessages[i] = {
                  ...updatedMessages[i],
                  docId: data.docId,
                };
                break;
              }
            }
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
        setSavedDocId(data.docId);
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

        // SOURCES DEBUGGING: Check if sources are missing after streaming completes
        setTimeout(() => {
          // Check the current state of sources for the last message
          setMessageState((prevState) => {
            const lastMessage = prevState.messages[prevState.messages.length - 1];

            if (lastMessage && lastMessage.type === "apiMessage") {
              const hasSourceDocs = lastMessage.sourceDocs && lastMessage.sourceDocs.length > 0;
              const expectedSourceCount = sourceCount;

              if (!hasSourceDocs) {
                console.error(`🚨 FRONTEND SOURCES BUG DETECTED: No sources found after streaming completed!`);
                console.error(`🚨 Expected ${expectedSourceCount} sources but found 0`);
                console.error(`🚨 Message docId: ${lastMessage.docId || "none"}`);

                // Send signal to backend about missing sources
                if (lastMessage.docId) {
                  reportMissingSourcesToBacked(lastMessage.docId, expectedSourceCount);
                }
              } else if (lastMessage.sourceDocs && lastMessage.sourceDocs.length < expectedSourceCount) {
                console.warn(`⚠️ FRONTEND SOURCES WARNING: Fewer sources than expected after streaming completed`);
                console.warn(`⚠️ Expected ${expectedSourceCount} sources but found ${lastMessage.sourceDocs.length}`);
                console.warn(`⚠️ Message docId: ${lastMessage.docId || "none"}`);

                // Send signal to backend about partial sources
                if (lastMessage.docId) {
                  reportPartialSourcesToBacked(lastMessage.docId, expectedSourceCount, lastMessage.sourceDocs.length);
                }
              } else if (lastMessage.sourceDocs) {
                console.log(
                  `✅ FRONTEND SOURCES VALIDATION: Found ${lastMessage.sourceDocs.length} sources as expected`
                );
              }
            }

            return prevState; // No state change, just validation
          });
        }, 200); // Small delay to ensure all SSE messages have been processed

        // Force a state update to ensure UI re-renders immediately with buttons and correct docId
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

          // If we have a saved docId but the API message doesn't have one, update it
          if (apiMessage.type === "apiMessage" && !apiMessage.docId && savedDocId) {
            // Create a new messages array with the updated API message
            const updatedMessages = [...prevState.messages];
            updatedMessages[apiMessageIndex] = {
              ...apiMessage,
              docId: savedDocId,
            };

            return {
              ...prevState,
              messages: updatedMessages,
            };
          }

          return { ...prevState };
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
      sourceCount,
      setLoading,
      setError,
      setSavedDocId,
      setMessageState,
      setSourceDocs,
      setScrollClickState,
      setShowScrollDownButton,
      setTimingMetrics,
      siteConfig?.siteId,
      siteConfig?.requireLogin,
      messages,
      savedDocId,
      showScrollDownButton,
    ]
    // Note: reportMissingSourcesToBacked and reportPartialSourcesToBacked are defined after this callback
    // but are stable functions that don't need to be in the dependency array
  );

  // Helper function to report missing sources to backend
  const reportMissingSourcesToBacked = useCallback(async (docId: string, expectedCount: number) => {
    try {
      console.log(`📡 FRONTEND SOURCES DEBUG: Reporting missing sources to backend for docId: ${docId}`);

      const response = await fetchWithAuth("/api/debug/missing-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          expectedCount,
          actualCount: 0,
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent,
          type: "missing_sources",
        }),
      });

      if (!response.ok) {
        console.warn(`Failed to report missing sources: ${response.status}`);
      } else {
        console.log(`✅ FRONTEND SOURCES DEBUG: Successfully reported missing sources to backend`);
      }
    } catch (error) {
      console.error("Error reporting missing sources to backend:", error);
    }
  }, []);

  // Helper function to report partial sources to backend
  const reportPartialSourcesToBacked = useCallback(
    async (docId: string, expectedCount: number, actualCount: number) => {
      try {
        console.log(`📡 FRONTEND SOURCES DEBUG: Reporting partial sources to backend for docId: ${docId}`);

        const response = await fetchWithAuth("/api/debug/missing-sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docId,
            expectedCount,
            actualCount,
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            type: "partial_sources",
          }),
        });

        if (!response.ok) {
          console.warn(`Failed to report partial sources: ${response.status}`);
        } else {
          console.log(`✅ FRONTEND SOURCES DEBUG: Successfully reported partial sources to backend`);
        }
      } catch (error) {
        console.error("Error reporting partial sources to backend:", error);
      }
    },
    []
  );

  // Main function to handle chat submission
  const handleSubmit = async (e: React.FormEvent, submittedQuery: string) => {
    e.preventDefault();
    if (submittedQuery.trim() === "") return;

    // Store the current question for sidebar updates
    setCurrentQuestion(submittedQuery);

    // Reset timing metrics when starting a new query
    setTimingMetrics(null);

    // Clear any active comparison UI when submitting a new question
    if (regeneratingMessageIndex !== null || regeneratedAnswer) {
      setRegeneratingMessageIndex(null);
      setRegeneratedAnswer(null);
      setIsRegenerating(false);
      setShowComparisonFeedbackModal(false);
    }

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

    // Reset accumulated response at the start of each new query
    accumulatedResponseRef.current = "";

    // Add user message to the state
    setMessageState((prevState) => ({
      ...prevState,
      messages: [
        ...prevState.messages,
        { type: "userMessage", message: submittedQuery } as ExtendedAIMessage,
        // Add an empty API message immediately so it's ready for the docId
        {
          type: "apiMessage",
          message: "",
          sourceDocs: [],
        } as ExtendedAIMessage,
      ],
      history: [...prevState.history, { role: "user", content: submittedQuery }, { role: "assistant", content: "" }],
    }));

    // Clear the input
    setQuery("");

    // Focus on the input field if not on mobile
    if (window.innerWidth >= 768 && textAreaRef.current) {
      textAreaRef.current.focus();
    }

    try {
      const newAbortController = new AbortController();
      setAbortController(newAbortController);

      const response = await fetchWithAuth("/api/chat/v1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: submittedQuery,
          history: messageState.history,
          collection,
          temporarySession,
          mediaTypes,
          selectedLibraries: selectedLibrariesRef.current,
          sourceCount: sourceCount,
          uuid: getOrCreateUUID(),
          convId: currentConvIdRef.current, // Pass current conversation ID for follow-ups
        }),
        signal: newAbortController.signal,
      });

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
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const jsonData = JSON.parse(line.slice(5)) as StreamingResponseData;
              handleStreamingResponse(jsonData);
            } catch (parseError) {
              console.error("Error parsing JSON:", parseError);
            }
          }
        }
      }

      setLoading(false);
    } catch (error) {
      console.error("Error in handleSubmit:", error);
      setError(error instanceof Error ? error.message : "An error occurred while streaming the response.");
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
  const handleSuggestionClick = (suggestion: string) => {
    // Track suggestion pill click in Google Analytics
    logEvent("suggestion_pill_click", "Engagement", suggestion);

    // Submit the suggestion as a new question
    handleSubmit(new Event("submit") as unknown as React.FormEvent, suggestion);
  };

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
          const categorized = await getCategorizedQueries(siteConfig.siteId, collection);
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
    if (!collectionQueries[collection as keyof typeof collectionQueries]) {
      // If the current collection is not found, use the first available collection
      const firstAvailableCollection = Object.keys(collectionQueries)[0];
      if (firstAvailableCollection) {
        return collectionQueries[firstAvailableCollection as keyof typeof collectionQueries];
      }
      return [];
    }

    const queries = collectionQueries[collection as keyof typeof collectionQueries];
    return queries;
  }, [collection, collectionQueries]);

  // Custom hook for managing suggested queries (fallback for non-categorized)
  const { suggestedQueries, shuffleQueries } = useSuggestedQueries(queriesForCollection, 3);

  // Helper function to determine if user has completed any Q&A (show suggestions until first Q&A)
  const shouldShowSuggestions = useMemo(() => {
    if (!messages || messages.length === 0) return true;

    // Count user messages (questions)
    const userMessages = messages.filter((msg) => msg.type === "userMessage");

    // Show suggestions until user has asked at least one question
    return userMessages.length === 0;
  }, [messages]);

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

  // State for GPT-4.1 regeneration and comparison
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  const [regeneratedAnswer, setRegeneratedAnswer] = useState<ExtendedAIMessage | null>(null);
  const [isRegenerating, setIsRegenerating] = useState<boolean>(false);
  const [showComparisonFeedbackModal, setShowComparisonFeedbackModal] = useState<boolean>(false);
  const regeneratedAnswerRef = useRef<string>("");

  // Function to handle voting on answers - MODIFIED
  const handleVote = (docId: string, isUpvote: boolean) => {
    setVoteError(null); // Clear previous errors
    setFeedbackSubmitError(null); // Clear feedback error

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
  const submitFeedback = async (docId: string, reason: string, comment: string) => {
    setFeedbackSubmitError(null); // Clear previous errors before trying
    try {
      const response = await fetchWithAuth("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, vote: -1, reason, comment }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to submit feedback (${response.status})`);
      }

      // If successful:
      setVotes((prev) => ({ ...prev, [docId]: -1 })); // Update UI to show downvote
      setIsFeedbackModalOpen(false); // Close modal
      setCurrentFeedbackDocId(null);
      logEvent("submit_feedback", "Engagement", reason); // Log feedback event

      // Show a success toast
      toast.success("Feedback submitted. Thank you!");
    } catch (error) {
      console.error("Error submitting feedback:", error);
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
      setFeedbackSubmitError(errorMessage); // Show error in the modal
      // Keep the modal open for the user to see the error
    }
  };

  // Function to cancel feedback - NEW
  const cancelFeedback = () => {
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
      accumulatedResponseRef.current = "";

      try {
        const newAbortController = new AbortController();
        setAbortController(newAbortController);

        const response = await fetchWithAuth("/api/chat/v1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: userMessage.message,
            history: messageState.history.slice(0, messageIndex - 1), // Include conversation history before this Q&A pair
            collection: apiMessage.collection || collection,
            mediaTypes: mediaTypes,
            selectedLibraries: selectedLibrariesRef.current,
            sourceCount: apiMessage.sourceDocs?.length || sourceCount,
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
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(5));

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

                if (data.done) {
                  setLoading(false);
                  accumulatedResponseRef.current = "";
                }
              } catch (e) {
                console.error("Error parsing SSE data:", e);
              }
            }
          }
        }

        setLoading(false);
      } catch (error) {
        console.error("Error regenerating answer:", error);
        toast.error("Failed to regenerate answer. Please try again.");
        setLoading(false);
        setError(error instanceof Error ? error.message : "An error occurred while regenerating the answer.");
      }
    },
    [
      loading,
      messages,
      collection,
      mediaTypes,
      sourceCount,
      temporarySession,
      messageState.history,
      setLoading,
      setError,
      setMessageState,
    ]
  );

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
        const newHistory = messageState.history.slice(0, messageIndex); // Keep history up to the user message

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

        // Add empty API message for streaming
        setMessageState((prevState) => ({
          ...prevState,
          messages: [
            ...prevState.messages,
            {
              type: "apiMessage",
              message: "",
              sourceDocs: [],
            },
          ],
          history: [...prevState.history, { role: "user", content: editedText }, { role: "assistant", content: "" }],
        }));

        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        accumulatedResponseRef.current = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(5));

                if (data.token) {
                  accumulatedResponseRef.current += data.token;
                  updateMessageState(accumulatedResponseRef.current, []);
                }

                if (data.sourceDocs) {
                  const immutableSourceDocs = Array.isArray(data.sourceDocs) ? [...data.sourceDocs] : [];
                  setSourceDocs(immutableSourceDocs);
                  updateMessageState(accumulatedResponseRef.current, immutableSourceDocs);
                }

                if (data.docId) {
                  setMessageState((prevState) => {
                    const updatedMessages = [...prevState.messages];
                    const lastMessage = updatedMessages[updatedMessages.length - 1];
                    if (lastMessage.type === "apiMessage") {
                      updatedMessages[updatedMessages.length - 1] = {
                        ...lastMessage,
                        docId: data.docId,
                      };
                    }
                    return {
                      ...prevState,
                      messages: updatedMessages,
                    };
                  });
                  setSavedDocId(data.docId);
                }

                if (data.convId) {
                  setCurrentConvId(data.convId);
                }

                if (data.done) {
                  setLoading(false);
                  accumulatedResponseRef.current = "";
                }
              } catch (e) {
                console.error("Error parsing SSE data:", e);
              }
            }
          }
        }

        setLoading(false);
      } catch (error) {
        console.error("Error saving edited question:", error);
        toast.error("Failed to save edited question. Please try again.");
        setLoading(false);
        setError(error instanceof Error ? error.message : "An error occurred while saving the edited question.");
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
      setSourceDocs,
      setSavedDocId,
      setCurrentConvId,
    ]
  );

  // Function to handle GPT-4.1 regeneration
  const handleTryGPT41 = useCallback(
    async (messageIndex: number) => {
      if (isRegenerating) return; // Prevent multiple regenerations

      const apiMessage = messages[messageIndex];
      if (apiMessage.type !== "apiMessage") return;

      const userMessage = messages[messageIndex - 1];
      if (!userMessage || userMessage.type !== "userMessage") return;

      logEvent("try_gpt41_clicked", "Model Comparison", `Message Index: ${messageIndex}`);

      setRegeneratingMessageIndex(messageIndex);
      setIsRegenerating(true);
      regeneratedAnswerRef.current = "";

      // Create placeholder for regenerated answer
      setRegeneratedAnswer({
        message: "",
        type: "apiMessage",
        sourceDocs: apiMessage.sourceDocs || [], // Reuse same sources
      });

      try {
        const response = await fetchWithAuth("/api/chat/v1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: userMessage.message,
            history: messageState.history.slice(0, messageIndex), // Include conversation history up to this point
            collection: apiMessage.collection || collection,
            mediaTypes: mediaTypes,
            selectedLibraries: selectedLibrariesRef.current,
            sourceCount: apiMessage.sourceDocs?.length || sourceCount,
            temporarySession: temporarySession,
            uuid: getOrCreateUUID(),
            convId: currentConvIdRef.current,
            // Override model to gpt-4.1 for comparison
            modelOverride: "gpt-4.1",
          }),
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(5));

                if (data.token) {
                  regeneratedAnswerRef.current += data.token;
                  setRegeneratedAnswer((prev) => ({
                    ...prev!,
                    message: regeneratedAnswerRef.current,
                  }));
                }

                if (data.done) {
                  setIsRegenerating(false);
                }
              } catch (e) {
                console.error("Error parsing SSE data:", e);
              }
            }
          }
        }
      } catch (error) {
        console.error("Error regenerating with GPT-4.1:", error);
        toast.error("Failed to regenerate answer. Please try again.");
        setIsRegenerating(false);
        setRegeneratingMessageIndex(null);
        setRegeneratedAnswer(null);
      }
    },
    [isRegenerating, messages, collection, mediaTypes, sourceCount, temporarySession, messageState.history]
  );

  // Function to submit comparison feedback
  const handleComparisonFeedbackSubmit = async (preference: string, comment: string, shareConsent: boolean) => {
    if (regeneratingMessageIndex === null || !regeneratedAnswer) return;

    const originalAnswer = messages[regeneratingMessageIndex];
    const userMessage = messages[regeneratingMessageIndex - 1];

    // Map preference to winner format
    let winner: "A" | "B" | "skip";
    if (preference === "original") {
      winner = "A";
    } else if (preference === "new") {
      winner = "B";
    } else {
      winner = "skip"; // "same"
    }

    try {
      const response = await fetchWithAuth("/api/model-comparison-vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: getOrCreateUUID(),
          timestamp: new Date(),
          winner,
          modelAConfig: {
            model: siteConfig?.modelName || "gpt-4",
            temperature: 0.3,
            response:
              shareConsent && originalAnswer.message ? originalAnswer.message : "[User did not consent to share]",
          },
          modelBConfig: {
            model: "gpt-4.1",
            temperature: 0.3,
            response:
              shareConsent && regeneratedAnswer.message ? regeneratedAnswer.message : "[User did not consent to share]",
          },
          question: shareConsent && userMessage?.message ? userMessage.message : "[User did not consent to share]",
          collection: originalAnswer.collection || collection,
          mediaTypes: mediaTypes,
          userComments: comment || "",
          shareConsent,
          siteId: siteConfig?.siteId || "unknown",
          source: "inline_comparison",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to submit feedback");
      }

      // If user preferred the new answer, replace the original with it
      if (preference === "new" && originalAnswer.docId) {
        // Update the message in the UI
        setMessageState((prevState) => {
          const newMessages = [...prevState.messages];
          newMessages[regeneratingMessageIndex] = {
            ...originalAnswer,
            message: regeneratedAnswer.message,
            // Keep the original docId, sourceDocs, etc.
          };
          return {
            ...prevState,
            messages: newMessages,
          };
        });

        // Update the database record with the new answer
        try {
          await fetchWithAuth(`/api/answers/${originalAnswer.docId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response: regeneratedAnswer.message,
              modelUsed: "gpt-4.1",
            }),
          });
        } catch (updateError) {
          console.error("Error updating answer in database:", updateError);
          // Don't show error to user since the vote was recorded successfully
        }
      }

      toast.success("Thank you for your feedback!");
      logEvent("comparison_feedback_submitted", "Model Comparison", preference);
    } catch (error) {
      console.error("Error submitting comparison feedback:", error);
      toast.error("Failed to submit feedback. Please try again.");
    } finally {
      setShowComparisonFeedbackModal(false);
      setRegeneratingMessageIndex(null);
      setRegeneratedAnswer(null);
      regeneratedAnswerRef.current = "";
    }
  };

  // Function to close comparison feedback modal
  const handleComparisonFeedbackClose = () => {
    setShowComparisonFeedbackModal(false);
    setRegeneratingMessageIndex(null);
    setRegeneratedAnswer(null);
    regeneratedAnswerRef.current = "";
    logEvent("comparison_feedback_skipped", "Model Comparison", "");
  };

  // Function to handle copying answer links
  const handleCopyLink = (answerId: string) => {
    const url = `${window.location.origin}/share/${answerId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(answerId);
      setTimeout(() => setLinkCopied(null), 2000);
      logEvent("copy_link", "Engagement", `Answer ID: ${answerId}`);
    });
  };

  // Effect to set initial collection and focus input on component mount
  useEffect(() => {
    // Retrieve and set the collection from the cookie
    // TODO: This is a hack for jairam site test
    const savedCollection =
      Cookies.get("selectedCollection") || (process.env.SITE_ID === "jairam" ? "whole_library" : "master_swami");
    setCollection(savedCollection);

    if (!isLoadingQueries && window.innerWidth > 768) {
      textAreaRef.current?.focus();
    }
  }, [isLoadingQueries]);

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
  const formatTimingMetrics = useCallback(() => {
    if (!timingMetrics) return null;

    const { ttfb, tokensPerSecond, totalTokens } = timingMetrics;

    if (ttfb === undefined || tokensPerSecond === undefined) return null;

    const ttfbSecs = (ttfb / 1000).toFixed(2);
    return `${ttfbSecs} secs to first character, then ${tokensPerSecond} chars/sec streamed (${totalTokens} total)`;
  }, [timingMetrics]);

  // Function to handle scroll behavior and button visibility
  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) return;

    // Function to check scroll position and update button visibility
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = messageList;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const hasScrollbar = scrollHeight > clientHeight;

      // Check if we've scrolled up away from the bottom
      if (hasScrollbar && distanceFromBottom > 20) {
        // Only show if content is actually overflowing the viewport
        const containerRect = messageList.getBoundingClientRect();
        const vh = window.innerHeight;
        if (containerRect.bottom > vh) {
          setShowScrollDownButton(true);
        }
      }
      // REMOVED: Logic that unconditionally hid the button when near the bottom
    };

    // New: Window scroll handler to show button if user scrolls up from page bottom
    const handleWindowScroll = () => {
      const threshold = 20;
      const atPageBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - threshold;
      const messageList = messageListRef.current;
      if (!messageList) return;
      const containerRect = messageList.getBoundingClientRect();
      const vh = window.innerHeight;
      const overflowsViewport = containerRect.bottom > vh;
      if (overflowsViewport && !atPageBottom) {
        setShowScrollDownButton(true);
      } else if (atPageBottom && scrollClickState === 0) {
        setShowScrollDownButton(false);
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
  }, [loading, scrollClickState]);

  // Function to scroll to bottom when button clicked
  const handleScrollDownClick = () => {
    if (scrollClickState === 0) {
      // First click: Scroll to bottom of content but keep button visible
      bottomOfListRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
      setScrollClickState(1);
      // Explicitly ensure the button stays visible after the first click
      setShowScrollDownButton(true);

      // Focus on the input field if not on mobile
      if (window.innerWidth >= 768 && textAreaRef.current) {
        textAreaRef.current.focus();
      }
    } else {
      // Second click: Scroll to very bottom of page and hide button
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: "smooth",
      });
      setShowScrollDownButton(false);
      setScrollClickState(0);

      // Focus on the input field if not on mobile
      if (window.innerWidth >= 768 && textAreaRef.current) {
        textAreaRef.current.focus();
      }
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
      >
        {showPopup && popupMessage && <Popup message={popupMessage} onClose={closePopup} siteConfig={siteConfig} />}

        <div className="flex h-full">
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
              onGetSidebarFunctions={(functions) => {
                handleSidebarFunctions(functions, () => {
                  // This refetch function is called when the sidebar needs to be reloaded
                  // after a state change that might affect its data, e.g., clearing chat history
                  // or changing collections.
                  // For now, we'll just log the event, as the actual re-fetching logic
                  // would involve fetching chat history from the backend.
                  logEvent("chat_history_sidebar_refetch", "Chat History", "sidebar_refetch");
                });
              }}
              onConversationDeleted={handleConversationDeleted}
            />
          )}

          {/* Main Content Area */}
          <div className="flex flex-col flex-1 min-w-0 lg:ml-0">
            <div className="mx-auto w-full max-w-4xl px-4">
              {/* Hamburger Menu Button - Only show on sites that require login */}
              {siteConfig?.requireLogin && (
                <div className="lg:hidden flex items-center justify-between p-4 border-b border-gray-200">
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
              {/* Temporary session banner */}
              {temporarySession && (
                <div className="flex items-center justify-center mb-3 px-3 py-2 bg-purple-100 border border-purple-300 rounded-lg">
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
              {/* Password promotion banner - only on sites that require login */}
              {siteConfig?.requireLogin && <PasswordPromoBanner />}
              <div className="flex-grow overflow-hidden answers-container">
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
                          lastMessageRef={lastMessageRef}
                          voteError={voteError}
                          allowAllAnswersPage={siteConfig?.allowAllAnswersPage ?? false}
                          onSuggestionClick={handleSuggestionClick}
                          onTryGPT41={handleTryGPT41}
                          isRegenerating={isRegenerating && regeneratingMessageIndex === index}
                          onRegenerateAnswer={handleRegenerateAnswer}
                          onEditQuestion={handleEditQuestion}
                          isEditing={editingMessageIndex === index}
                          editingText={editingText}
                          onSaveEdit={handleSaveEdit}
                          onCancelEdit={handleCancelEdit}
                        />
                      </div>

                      {/* Show comparison UI if this message is being regenerated */}
                      {regeneratingMessageIndex === index && regeneratedAnswer && (
                        <div className="px-4 pb-4">
                          <AnswerComparison
                            originalAnswer={message}
                            newAnswer={regeneratedAnswer}
                            originalModel={siteConfig?.modelName || "GPT-4"}
                            newModel="GPT-4.1"
                            isStreaming={isRegenerating}
                          />
                          {/* Feedback button - only show after streaming completes */}
                          {!isRegenerating && (
                            <div className="mt-4 flex justify-center">
                              <button
                                onClick={() => setShowComparisonFeedbackModal(true)}
                                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-md transition-colors"
                              >
                                Which answer was better?
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                  {/* Display timing metrics for sudo users */}
                  {isSudoUser && timingMetrics && !loading && messages.length > 0 && (
                    <div className="text-xs text-gray-500 p-2 bg-gray-50 rounded m-2">{formatTimingMetrics()}</div>
                  )}
                  <div ref={bottomOfListRef} style={{ height: "1px" }} />
                </div>

                {/* Container to anchor the scroll button at the right edge of the content */}
                <div ref={scrollButtonContainerRef} className="relative w-full">
                  {/* Animated Scroll Down Button */}
                  <div
                    className={`fixed z-50 right-52 bottom-6 transition-all duration-300 ease-out transform 
                  ${showScrollDownButton ? "translate-y-0 opacity-100 pointer-events-auto" : "translate-y-8 opacity-0 pointer-events-none"}`}
                    style={{ willChange: "transform, opacity" }}
                  >
                    <button
                      onClick={handleScrollDownClick}
                      aria-label="Scroll to bottom"
                      className="bg-white text-gray-600 rounded-full shadow-sm hover:shadow-md p-2 border border-gray-200 focus:outline-none"
                    >
                      <span className="material-icons text-xl">expand_more</span>
                    </button>
                  </div>
                </div>
              </div>
              <div className="mt-4 px-2 md:px-0">
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
                    onTemporarySessionChange={handleTemporarySessionChange}
                    categorizedQueries={categorizedQueries}
                  />
                )}
              </div>
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
        />

        {/* Render the Model Comparison Feedback Modal */}
        <ModelComparisonFeedbackModal
          isOpen={showComparisonFeedbackModal}
          onClose={handleComparisonFeedbackClose}
          onSubmit={handleComparisonFeedbackSubmit}
          originalModel={siteConfig?.modelName || "GPT-4"}
          newModel="GPT-4.1"
        />

        {/* Display general vote errors (e.g., from upvoting) */}
        {voteError &&
          !isFeedbackModalOpen && ( // Don't show if feedback modal is open showing its own error
            <div className="fixed bottom-4 right-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded shadow-md z-50">
              <strong className="font-bold">Error: </strong>
              <span className="block sm:inline">{voteError}</span>
            </div>
          )}
      </Layout>
    </SudoProvider>
  );
}
