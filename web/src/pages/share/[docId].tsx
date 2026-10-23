/**
 * Share conversation route - loads shared conversations directly
 * This handles URLs like /share/[docId] and loads the conversation
 * with proper authentication handling for owners vs non-owners
 */

import { useRouter } from "next/router";
import { useEffect, useState, useRef, useCallback } from "react";
import Head from "next/head";
import Layout from "@/components/layout";
import MessageItem from "@/components/MessageItem";
import { SiteConfig } from "@/types/siteConfig";
import { getCommonSiteConfigProps } from "@/utils/server/getCommonSiteConfigProps";
import { ConversationNotFoundError, loadConversationByDocId } from "@/utils/client/conversationLoader";
import { logEvent } from "@/utils/client/analytics";
import { getGreeting, getSiteName } from "@/utils/client/siteConfig";
import { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import { DocMetadata } from "@/types/DocMetadata";
import { Document } from "@langchain/core/documents";
import {
  ensureAnonymousUuidSynced,
  fetchWithAuth,
  isAuthenticated,
  initializeTokenManager,
} from "@/utils/client/tokenManager";
import { getOrCreateUUID } from "@/utils/client/uuid";
import { generateSourceId } from "@/utils/client/sourceUtils";

type PublicShareTurn = {
  id: string;
  question: string;
  answer: string;
  sources?: unknown;
  timestamp?: unknown;
  title?: string | null;
  collection?: string | null;
  suggestions?: unknown;
  model?: string | null;
};

interface ShareConversationProps {
  siteConfig: SiteConfig | null;
}

export default function ShareConversation({ siteConfig }: ShareConversationProps) {
  const router = useRouter();
  const { docId } = router.query;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ExtendedAIMessage[]>([]);
  const [viewOnlyMode, setViewOnlyMode] = useState(false);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const [firstQuestion, setFirstQuestion] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState<string | null>(null);
  const [sourceLinkCopied, setSourceLinkCopied] = useState<string | null>(null);
  const [isCloning, setIsCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const sourceExpandedRef = useRef<Set<number>>(new Set());
  const handledHashRef = useRef<string | null>(null);

  // Function to copy the share link to clipboard
  const handleCopyLink = useCallback(
    async (answerId: string) => {
      try {
        const shareUrl = `${window.location.origin}/share/${docId}`;
        await navigator.clipboard.writeText(shareUrl);
        setLinkCopied(answerId);

        // Clear the copied state after 2 seconds
        setTimeout(() => {
          setLinkCopied(null);
        }, 2000);
      } catch (error) {
        console.error("Failed to copy link:", error);
      }
    },
    [docId]
  );

  // Function to clone the conversation and continue
  const handleCloneConversation = useCallback(async () => {
    if (!docId || typeof docId !== "string") {
      return;
    }

    setIsCloning(true);
    setCloneError(null);

    try {
      // Share pages skip token bootstrap. Ask web-token to set the signed uuid
      // cookie before the clone POST, which reads that cookie on no-login sites.
      await ensureAnonymousUuidSynced();
      getOrCreateUUID();

      const response = await fetchWithAuth("/api/clone-conversation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ docId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to clone conversation");
      }

      const data = await response.json();

      // Log analytics event
      logEvent("conversation_cloned", "Sharing", docId, data.messageCount);

      // Redirect to the new conversation
      router.push(`/chat/${data.convId}`);
    } catch (error) {
      console.error("Error cloning conversation:", error);
      setCloneError(error instanceof Error ? error.message : "Failed to clone conversation");
      setIsCloning(false);
    }
  }, [docId, router]);

  // Function to handle clone button click
  const handleCloneClick = useCallback(() => {
    if (!docId || typeof docId !== "string") {
      return;
    }

    // Check if site requires login
    const loginRequired = siteConfig?.requireLogin ?? true;

    // If login is required and user is not logged in, redirect to login
    if (loginRequired && !isLoggedIn) {
      const currentPath = `/share/${docId}`;
      router.push(`/login?redirect=${encodeURIComponent(currentPath)}&action=clone`);
      return;
    }

    // For all other cases (logged in on login-required site, or non-login site), perform the clone via API
    handleCloneConversation();
  }, [docId, isLoggedIn, router, handleCloneConversation, siteConfig]);

  // Check authentication status after token manager initializes
  useEffect(() => {
    const checkAuth = async () => {
      try {
        await initializeTokenManager();
      } catch (error) {
        // Initialization failed, user is not authenticated
        console.log("Token initialization failed:", error);
      }

      const authStatus = isAuthenticated();

      setIsLoggedIn(authStatus);
      setAuthChecked(true);
    };
    checkAuth();
  }, []);

  // Handle source expansion callback
  const handleSourceExpanded = useCallback((index: number) => {
    sourceExpandedRef.current.add(index);
  }, []);

  // Handle source link copy callback
  const handleSourceLinkCopied = useCallback((sourceId: string) => {
    setSourceLinkCopied(sourceId);
    setTimeout(() => {
      setSourceLinkCopied(null);
    }, 2000);
  }, []);

  // Auto-clone after login if action=clone is in URL
  useEffect(() => {
    if (!router.isReady) return;

    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get("action");

    if (action === "clone" && viewOnlyMode && isLoggedIn) {
      // Remove action from URL to prevent re-triggering
      urlParams.delete("action");
      const newUrl = window.location.pathname + (urlParams.toString() ? `?${urlParams.toString()}` : "");
      window.history.replaceState({}, document.title, newUrl);

      // Trigger clone automatically
      handleCloneConversation();
    }
  }, [router.isReady, viewOnlyMode, isLoggedIn, handleCloneConversation]);

  useEffect(() => {
    if (!router.isReady || !docId || typeof docId !== "string" || !authChecked) {
      return;
    }

    const scrollToLastUnlessSourceHash = () => {
      const hash = window.location.hash;
      if (!hash || !hash.startsWith("#source-")) {
        setTimeout(() => {
          if (lastMessageRef.current) {
            lastMessageRef.current.scrollIntoView({ behavior: "smooth" });
          }
        }, 100);
      }
    };

    const messagesFromShareTurns = (turns: PublicShareTurn[]): ExtendedAIMessage[] => {
      const messages: ExtendedAIMessage[] = [
        {
          type: "apiMessage",
          message: getGreeting(siteConfig),
        },
      ];

      for (const turn of turns) {
        if (turn.question) {
          messages.push({
            type: "userMessage",
            message: turn.question,
          });
        }

        let parsedSources: Document<DocMetadata>[] = [];
        if (turn.sources) {
          try {
            parsedSources = typeof turn.sources === "string" ? JSON.parse(turn.sources) : turn.sources;
          } catch (e) {
            console.error("Error parsing sources:", e);
          }
        }

        messages.push({
          type: "apiMessage",
          message: turn.answer,
          sourceDocs: parsedSources,
          docId: turn.id,
          collection: turn.collection || undefined,
          suggestions: Array.isArray(turn.suggestions) ? turn.suggestions : [],
          model: turn.model || undefined,
        });
      }

      return messages;
    };

    const loadSharedConversation = async () => {
      try {
        setLoading(true);
        setError(null);

        if (isLoggedIn) {
          try {
            const loadedConversation = await loadConversationByDocId(docId);

            if (loadedConversation.convId) {
              const hash = window.location.hash;
              const targetPath = hash
                ? `/chat/${loadedConversation.convId}${hash}`
                : `/chat/${loadedConversation.convId}`;
              router.replace("/", targetPath, { shallow: false });
              return;
            }
          } catch {
            // Caller does not own this document. Use the public share payload.
          }
        }

        // Logged-out viewers and non-owners use /api/share only.
        const shareResponse = await fetch(`/api/share/${docId}`);
        if (!shareResponse.ok) {
          if (shareResponse.status === 404) {
            throw new ConversationNotFoundError("Document not found");
          }
          throw new Error(`Failed to fetch shared conversation: ${shareResponse.statusText}`);
        }

        const shareData = await shareResponse.json();
        const turns: PublicShareTurn[] = Array.isArray(shareData.turns) ? shareData.turns : [];
        setConversationTitle(shareData.title || null);
        const firstQuestionTurn = turns.find((turn) => turn.question);
        if (firstQuestionTurn) {
          setFirstQuestion(firstQuestionTurn.question);
        }

        const messages = messagesFromShareTurns(turns);
        setMessages(messages);
        setViewOnlyMode(true);
        logEvent("shared_conversation_loaded", "Sharing", docId, messages.length);
        scrollToLastUnlessSourceHash();
      } catch (error) {
        if (!(error instanceof ConversationNotFoundError)) {
          console.error("Error loading shared conversation:", error);
        }
        setError(error instanceof Error ? error.message : "Failed to load shared conversation");
      } finally {
        setLoading(false);
      }
    };

    loadSharedConversation();
  }, [router.isReady, docId, router, siteConfig, isLoggedIn, authChecked]);

  // Handle hash changes (e.g., browser back/forward navigation)
  // This handles both initial page load with hash and subsequent hash changes
  useEffect(() => {
    if (!router.isReady || loading || !messages.length) {
      return;
    }

    if (typeof window === "undefined") {
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

      logEvent(isInitialLoad ? "source_deep_link_activated" : "source_deep_link_navigated", "Sharing", sourceId);
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

    // Handle initial hash on mount
    handleHashChange(true);

    // Listen for hash changes (browser back/forward)
    const onHashChange = () => handleHashChange(false);
    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [router.isReady, loading, messages, handleSourceExpanded]);

  // Generate HTML title
  const generateTitle = () => {
    const siteName = getSiteName(siteConfig);

    if (conversationTitle) {
      return `${conversationTitle} - ${siteName}`;
    }

    if (firstQuestion) {
      // Truncate question to ~50 characters for title
      const truncatedQuestion = firstQuestion.length > 50 ? firstQuestion.substring(0, 47) + "..." : firstQuestion;
      return `${truncatedQuestion} - ${siteName}`;
    }

    if (loading) {
      return `Loading... - ${siteName}`;
    }

    if (error) {
      return `Error - ${siteName}`;
    }

    return `Shared Conversation - ${siteName}`;
  };

  if (loading) {
    return (
      <>
        <Head>
          <title>{generateTitle()}</title>
        </Head>
        <Layout siteConfig={siteConfig}>
          <div className="flex justify-center items-center h-screen">
            <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-blue-600"></div>
            <p className="text-lg text-gray-600 ml-4">Loading shared conversation...</p>
          </div>
        </Layout>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Head>
          <title>{generateTitle()}</title>
        </Head>
        <Layout siteConfig={siteConfig}>
          <div className="flex justify-center items-center h-screen">
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-4 text-red-600">Error</h1>
              <p className="text-gray-600">{error}</p>
            </div>
          </div>
        </Layout>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{generateTitle()}</title>
      </Head>
      <Layout siteConfig={siteConfig}>
        <div className="mx-auto w-full max-w-4xl px-4">
          {viewOnlyMode && (
            <div className="bg-blue-100 text-blue-800 text-center py-2 mb-4 rounded-md">
              <span className="material-icons text-sm mr-2">visibility</span>
              You are viewing a shared conversation (read-only)
            </div>
          )}

          <div className="flex-grow overflow-hidden answers-container">
            <div className="h-full overflow-y-auto">
              {messages.map((message, index) => (
                <MessageItem
                  key={`sharedMessage-${index}`}
                  messageKey={`sharedMessage-${index}`}
                  message={message}
                  previousMessage={index > 0 ? messages[index - 1] : undefined}
                  index={index}
                  isLastMessage={index === messages.length - 1}
                  loading={false}
                  temporarySession={false}
                  collectionChanged={false}
                  hasMultipleCollections={false}
                  linkCopied={linkCopied}
                  votes={{}}
                  siteConfig={siteConfig}
                  handleVote={() => {}}
                  handleCopyLink={handleCopyLink}
                  lastMessageRef={index === messages.length - 1 ? lastMessageRef : null}
                  voteError={null}
                  allowAllAnswersPage={siteConfig?.allowAllAnswersPage ?? false}
                  readOnly={true}
                  sourceLinkCopied={sourceLinkCopied}
                  onSourceExpanded={handleSourceExpanded}
                  onSourceLinkCopied={handleSourceLinkCopied}
                />
              ))}
              <div ref={lastMessageRef} />
            </div>
          </div>

          {viewOnlyMode && (
            <>
              <div className="flex justify-center mt-6 mb-4">
                <button
                  onClick={handleCloneClick}
                  disabled={isCloning}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-md transition-colors flex items-center gap-2"
                >
                  {isCloning ? (
                    <>
                      <span className="material-icons animate-spin text-sm">refresh</span>
                      Cloning...
                    </>
                  ) : (
                    <>
                      <span className="material-icons text-sm">
                        {(siteConfig?.requireLogin ?? true) && !isLoggedIn ? "login" : "content_copy"}
                      </span>
                      {(siteConfig?.requireLogin ?? true) && !isLoggedIn
                        ? "Login to Clone This Chat"
                        : "Clone & Continue This Chat"}
                    </>
                  )}
                </button>
              </div>
              {cloneError && (
                <div className="bg-red-100 text-red-800 text-center py-2 mb-4 rounded-md">{cloneError}</div>
              )}
            </>
          )}
        </div>
      </Layout>
    </>
  );
}

// Fetch initial props for the page
ShareConversation.getInitialProps = async () => {
  const result = await getCommonSiteConfigProps();
  return result.props;
};
