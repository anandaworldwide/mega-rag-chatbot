import { useState } from "react";
import { Message } from "@/types/chat";
import { Document } from "@langchain/core/documents";
import { logEvent } from "@/utils/client/analytics";
import { getGreeting } from "@/utils/client/siteConfig";
import { SiteConfig } from "@/types/siteConfig";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import { ChatMessage, createChatMessages } from "@/utils/shared/chatHistory";
import { getOrCreateUUID } from "@/utils/client/uuid";

export function useChat(
  collection: string,
  temporarySession: boolean,
  mediaTypes: { text: boolean; audio: boolean },
  siteConfig?: SiteConfig | null,
  selectedLibraries?: string[]
) {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [messageState, setMessageState] = useState<{
    messages: Message[];
    pending?: string;
    history: ChatMessage[];
    pendingSourceDocs?: Document[];
  }>({
    messages: [
      {
        message: getGreeting(siteConfig ?? null),
        type: "apiMessage",
      },
    ],
    history: [],
  });

  // Function to update the chat history with new messages
  const updateHistory = (query: string, response: string) => {
    return [...messageState.history, ...createChatMessages(query, response)];
  };

  const handleSubmit = async (e: React.FormEvent, query: string) => {
    e.preventDefault();

    setError(null);

    if (!query) {
      alert("Please input a question");
      return;
    }

    setMessageState((state) => ({
      ...state,
      messages: [
        ...state.messages,
        {
          type: "userMessage",
          message: query,
        },
      ],
    }));

    // Log event for all questions
    logEvent("ask_question", "Engagement", query);

    // New: Log event specifically for temporary questions
    if (temporarySession) {
      logEvent("submit_temporary_question", "Engagement", "");
    }

    setLoading(true);
    try {
      // Use fetchWithAuth instead of fetch to automatically include the JWT token
      const response = await fetchWithAuth("/api/chat/v1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collection,
          question: query,
          history: messageState.history,
          temporarySession,
          mediaTypes,
          selectedLibraries,
          siteConfig,
          uuid: getOrCreateUUID(),
        }),
      });
      const data = await response.json();

      if (data.error) {
        setError(data.error);
        console.log("ERROR: data error: " + data.error);
      } else {
        const transformedSourceDocs = data.sourceDocuments.map((doc: Document) => ({
          ...doc,
          metadata: {
            ...doc.metadata,
            title: doc.metadata.title || "Unknown source",
          },
        }));

        setMessageState((state) => ({
          ...state,
          messages: [
            ...state.messages,
            {
              type: "apiMessage",
              message: data.text,
              sourceDocs: transformedSourceDocs,
              docId: data.docId,
              collection: collection,
            },
          ],
          history: updateHistory(query, data.text),
        }));
      }

      setLoading(false);
    } catch (error) {
      setLoading(false);
      setError(
        "An error occurred while fetching the data. " +
          'Please click "Contact" in the site footer to email Michael and let him know!'
      );
      console.log("error", error);
    }
  };

  return {
    loading,
    setLoading,
    error,
    setError,
    messageState,
    setMessageState,
    handleSubmit,
  };
}
