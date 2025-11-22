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
import { loadConversationByDocId } from "@/utils/client/conversationLoader";
import { logEvent } from "@/utils/client/analytics";
import { getGreeting, getSiteName } from "@/utils/client/siteConfig";
import { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import { DocMetadata } from "@/types/DocMetadata";
import { Document } from "langchain/document";
import { fetchWithAuth, isAuthenticated, initializeTokenManager } from "@/utils/client/tokenManager";
import { getOrCreateUUID } from "@/utils/client/uuid";

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
  const [isCloning, setIsCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const lastMessageRef = useRef<HTMLDivElement>(null);

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
      // Ensure UUID exists in cookies for non-login-required sites
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
    };
    checkAuth();
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
    if (!router.isReady || !docId || typeof docId !== "string") {
      return;
    }

    const loadSharedConversation = async () => {
      try {
        setLoading(true);
        setError(null);

        // For sites without conversation history support, load document directly
        if (!siteConfig?.requireLogin) {
          // Get document data directly without using conversation loading
          const docResponse = await fetch(`/api/document/${docId}`);
          if (!docResponse.ok) {
            if (docResponse.status === 404) {
              throw new Error("Document not found");
            }
            throw new Error(`Failed to fetch document: ${docResponse.statusText}`);
          }

          const docData = await docResponse.json();

          // Set title and first question for HTML title
          setConversationTitle(docData.title || null);
          if (docData.question) {
            setFirstQuestion(docData.question);
          }

          // Create conversation from document history
          const history = docData.history || [];
          const messages = [];

          // Add greeting message
          messages.push({
            type: "apiMessage" as const,
            message: getGreeting(siteConfig),
          });

          // Convert history to messages format
          for (const historyItem of history) {
            if (historyItem.role === "user") {
              messages.push({
                type: "userMessage" as const,
                message: historyItem.content,
              });
            } else if (historyItem.role === "assistant") {
              messages.push({
                type: "apiMessage" as const,
                message: historyItem.content,
              });
            }
          }

          // Add the final question and answer
          messages.push({
            type: "userMessage" as const,
            message: docData.question,
          });

          // Parse sources if they exist
          let parsedSources: Document<DocMetadata>[] = [];
          if (docData.sources) {
            try {
              parsedSources = JSON.parse(docData.sources);
            } catch (e) {
              console.error("Error parsing sources:", e);
            }
          }

          messages.push({
            type: "apiMessage" as const,
            message: docData.answer,
            sourceDocs: parsedSources,
            docId: docData.id,
            collection: docData.collection,
            suggestions: docData.suggestions || [],
          });

          // Set the messages for display
          setMessages(messages);
          // Set view-only mode so clone button appears
          setViewOnlyMode(true);
          setLoading(false);

          // Log analytics event
          logEvent("shared_conversation_loaded", "Sharing", docId, messages.length);

          return;
        }

        const loadedConversation = await loadConversationByDocId(docId);

        // Set title and first question for HTML title
        setConversationTitle(loadedConversation.title || null);

        // Get first user message for fallback title
        const firstUserMessage = loadedConversation.messages.find((msg) => msg.type === "userMessage");
        if (firstUserMessage) {
          setFirstQuestion(firstUserMessage.message);
        }

        // If owner, redirect to the full conversation URL
        if (loadedConversation.isOwner && loadedConversation.convId) {
          // Redirect owner to the full conversation URL
          router.replace(`/chat/${loadedConversation.convId}`);
          return;
        }

        // For non-owners, show the shared conversation in read-only mode
        const convertedMessages: ExtendedAIMessage[] = [
          {
            message: getGreeting(siteConfig),
            type: "apiMessage",
          },
          ...loadedConversation.messages.map(
            (msg): ExtendedAIMessage => ({
              type: msg.type,
              message: msg.message,
              sourceDocs: msg.sourceDocs?.filter((doc): doc is Document<DocMetadata> => doc !== null) || undefined,
              docId: msg.docId,
              collection: msg.collection,
            })
          ),
        ];
        setMessages(convertedMessages);

        setViewOnlyMode(loadedConversation.viewOnly);

        // Log analytics event
        logEvent("shared_conversation_loaded", "Sharing", docId, loadedConversation.messages.length);

        // Scroll to last message
        setTimeout(() => {
          if (lastMessageRef.current) {
            lastMessageRef.current.scrollIntoView({ behavior: "smooth" });
          }
        }, 100);
      } catch (error) {
        console.error("Error loading shared conversation:", error);
        setError(error instanceof Error ? error.message : "Failed to load shared conversation");
      } finally {
        setLoading(false);
      }
    };

    loadSharedConversation();
  }, [router.isReady, docId, router, siteConfig]);

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
