/**
 * Conversation Loading Utility
 *
 * Loads full conversations by convId and transforms them for the chat interface
 */

import { fetchWithAuth } from "@/utils/client/tokenManager";
import { getOrCreateUUID } from "@/utils/client/uuid";
import { Message } from "@/types/chat";
import { ChatMessage, createChatMessages } from "@/utils/shared/chatHistory";
import { ChatHistoryItem } from "@/hooks/useChatHistory";
import { Document } from "langchain/document";
import { TypedSuggestion } from "@/types/Suggestion";

export interface LoadedConversation {
  messages: Message[];
  history: ChatMessage[];
  title?: string;
  convId?: string;
}

/**
 * Loads a full conversation by convId and transforms it for the chat interface
 */
export async function loadConversationByConvId(
  convId: string,
  upToTimestamp?: any,
  uuidOverride?: string | null
): Promise<LoadedConversation> {
  try {
    // For legacy documents, uuidOverride can be null to indicate no UUID filtering
    const uuid = uuidOverride === null ? null : uuidOverride || getOrCreateUUID();

    // Build API URL - for legacy documents, we may not have a UUID
    let apiUrl = `/api/chats?convId=${convId}&limit=200`;
    if (uuid) {
      apiUrl += `&uuid=${encodeURIComponent(uuid)}`;
    }

    // Fetch all messages in the conversation
    const response = await fetchWithAuth(apiUrl, {
      method: "GET",
    });

    if (!response.ok) {
      // Try to get more detailed error information from the response
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch {
        // If we can't parse the error response, use the default message
      }
      throw new Error(errorMessage);
    }

    const responseData = await response.json();

    // Check if the response contains an error (even with 200 status)
    if (responseData.error) {
      throw new Error(responseData.error);
    }

    const chats: ChatHistoryItem[] = Array.isArray(responseData) ? responseData : [];

    if (chats.length === 0) {
      throw new Error("Conversation not found");
    }

    // Sort chats by timestamp (oldest first for proper conversation flow)
    let sortedChats = chats.sort((a, b) => {
      const timeA = a.timestamp?.seconds || a.timestamp?._seconds || 0;
      const timeB = b.timestamp?.seconds || b.timestamp?._seconds || 0;
      return timeA - timeB;
    });

    // Filter chats up to the specified timestamp if provided
    if (upToTimestamp) {
      const upToTime = upToTimestamp.seconds || upToTimestamp._seconds || upToTimestamp;
      sortedChats = sortedChats.filter((chat) => {
        const chatTime = chat.timestamp?.seconds || chat.timestamp?._seconds || 0;
        return chatTime <= upToTime;
      });
    }

    // Transform chats into Message[] format for the chat interface
    const messages: Message[] = [];
    const history: ChatMessage[] = [];

    // Add greeting message first (this is typically the first message in the chat interface)
    // We'll let the calling component handle the greeting since it's site-specific

    // Process each chat item
    sortedChats.forEach((chat) => {
      // Add user message
      messages.push({
        type: "userMessage",
        message: chat.question,
      });

      // Add assistant message
      const sourceDocs: Document[] = [];
      try {
        if (chat.sources) {
          const parsedSources = typeof chat.sources === "string" ? JSON.parse(chat.sources) : chat.sources;

          if (Array.isArray(parsedSources)) {
            sourceDocs.push(
              ...parsedSources.map((doc: any) => ({
                ...doc,
                metadata: {
                  ...doc.metadata,
                  title: doc.metadata?.title || "Unknown source",
                },
              }))
            );
          }
        }
      } catch (error) {
        console.warn("Failed to parse sources for chat:", chat.id, error);
      }

      // Parse suggestions if available (handle both legacy string[] and new TypedSuggestion[])
      let suggestions: TypedSuggestion[] = [];
      try {
        if (chat.suggestions) {
          if (Array.isArray(chat.suggestions)) {
            // Check if it's typed suggestions (has objects with 'text' property) or legacy strings
            if (
              chat.suggestions.length > 0 &&
              typeof chat.suggestions[0] === "object" &&
              "text" in chat.suggestions[0]
            ) {
              // Typed suggestions - use as-is
              suggestions = chat.suggestions as TypedSuggestion[];
            } else {
              // Legacy string array - convert to typed format for compatibility
              suggestions = (chat.suggestions as string[]).map((text, idx) => ({
                id: `legacy-${idx}`,
                text,
                type: "deeper" as const, // Default to deeper for legacy suggestions
              }));
            }
          } else if (typeof chat.suggestions === "string") {
            const parsed = JSON.parse(chat.suggestions);
            if (Array.isArray(parsed)) {
              if (parsed.length > 0 && typeof parsed[0] === "object" && "text" in parsed[0]) {
                suggestions = parsed as TypedSuggestion[];
              } else {
                suggestions = (parsed as string[]).map((text: string, idx: number) => ({
                  id: `legacy-${idx}`,
                  text,
                  type: "deeper" as const,
                }));
              }
            }
          }
        }
      } catch (error) {
        console.warn("Failed to parse suggestions for chat:", chat.id, error);
      }

      messages.push({
        type: "apiMessage",
        message: chat.answer,
        sourceDocs: sourceDocs.length > 0 ? sourceDocs : undefined,
        docId: chat.id,
        collection: chat.collection,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      });

      // Add to history for continuation
      history.push(...createChatMessages(chat.question, chat.answer));
    });

    // Prefer the earliest chat *with* a title (it may be on the assistant answer rather than the
    // user question). Fall back to the very first chat document if none contain a title.
    const titleChat = sortedChats.find((c) => !!c.title) ?? sortedChats[0];

    const title = titleChat?.title;

    return {
      messages,
      history,
      title,
      convId,
    };
  } catch (error) {
    console.error("Error loading conversation:", error);
    throw error;
  }
}

/**
 * Loads conversation by document ID with ownership and timestamp logic
 */
export async function loadConversationByDocId(
  docId: string
): Promise<LoadedConversation & { isOwner: boolean; viewOnly: boolean }> {
  try {
    // First fetch the document to get convId and ownership info
    const docResponse = await fetch(`/api/document/${docId}`);

    if (!docResponse.ok) {
      if (docResponse.status === 404) {
        throw new Error("Document not found");
      }
      throw new Error(`Failed to fetch document: ${docResponse.statusText}`);
    }

    const docData = await docResponse.json();
    const { convId, uuid: docUuid, timestamp } = docData;

    const currentUuid = getOrCreateUUID();

    // For legacy documents without UUID, treat as publicly viewable (not owned)
    // For documents with UUID, check ownership
    const isOwner = docUuid ? currentUuid === docUuid : false;

    // Load conversation - full if owner, up to timestamp if not
    // For legacy documents without UUID, pass null to indicate no UUID filtering
    const conversation = await loadConversationByConvId(
      convId,
      isOwner ? undefined : timestamp,
      docUuid ? (isOwner ? undefined : docUuid) : null
    );

    return {
      ...conversation,
      convId, // Include the convId from the document data
      isOwner,
      viewOnly: !isOwner,
    };
  } catch (error) {
    console.error("Error loading conversation by doc ID:", error);
    throw error;
  }
}
