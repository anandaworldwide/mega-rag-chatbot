// This component renders an individual message item in a chat interface,
// supporting both user messages and AI responses with various interactive elements.

import React, { Fragment } from "react";
import ReactMarkdown from "react-markdown";
import gfm from "remark-gfm";
import styles from "@/styles/Home.module.css";
import markdownStyles from "@/styles/MarkdownStyles.module.css";
import SourcesList from "@/components/SourcesList";
import CopyButton from "@/components/CopyButton";
import { SiteConfig } from "@/types/siteConfig";
import { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import SuggestionPills from "@/components/SuggestionPills";

import { useSudo } from "@/contexts/SudoContext";
import { Components } from "react-markdown";

interface MessageItemProps {
  message: ExtendedAIMessage;
  previousMessage?: ExtendedAIMessage;
  index: number;
  isLastMessage: boolean;
  loading: boolean;
  temporarySession: boolean;
  collectionChanged: boolean;
  hasMultipleCollections: boolean;
  linkCopied: string | null;
  votes?: Record<string, number>;
  siteConfig: SiteConfig | null;
  handleCopyLink: (answerId: string) => void;
  handleVote?: (docId: string, isUpvote: boolean) => void;
  lastMessageRef: React.RefObject<HTMLDivElement> | null;
  messageKey: string;
  voteError?: string | null;
  allowAllAnswersPage: boolean;
  showSourcesBelow?: boolean;
  onSuggestionClick?: (suggestion: string) => void;
  readOnly?: boolean; // New prop to disable interactive elements
  onTryGPT41?: (messageIndex: number) => void; // New prop for regenerating with GPT-4.1
  isRegenerating?: boolean; // Track if this message is being regenerated
  onRegenerateAnswer?: (messageIndex: number) => void; // New prop for regenerating answer
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  previousMessage,
  index,
  isLastMessage,
  loading,
  temporarySession,
  collectionChanged,
  hasMultipleCollections,
  linkCopied,
  votes = {},
  siteConfig,
  handleCopyLink,
  handleVote,
  lastMessageRef,
  messageKey,
  showSourcesBelow = false,
  onSuggestionClick,
  readOnly = false,
  onTryGPT41,
  isRegenerating = false,
  onRegenerateAnswer,
}) => {
  const { isSudoUser } = useSudo();

  const renderSources = () => {
    if (message.sourceDocs && message.sourceDocs.length > 0) {
      return (
        <div className={showSourcesBelow ? "mt-2" : "mb-2"}>
          <SourcesList
            sources={message.sourceDocs}
            collectionName={collectionChanged && hasMultipleCollections ? message.collection : null}
            siteConfig={siteConfig}
            isSudoAdmin={isSudoUser}
            docId={message.docId}
          />
        </div>
      );
    }
    return null;
  };

  const renderVoteButtons = (docId: string) => {
    if (!docId) return null;

    const vote = votes[docId] || 0;

    if (!handleVote) {
      console.warn("MessageItem: handleVote prop is missing for vote buttons.");
      return null;
    }

    return (
      <div className="flex items-center space-x-1">
        {/* Upvote Button */}
        <button
          onClick={() => handleVote(docId, true)}
          className={`${styles.voteButton} ${
            vote === 1 ? styles.voteButtonActive : ""
          } hover:bg-gray-200 flex items-center`}
          title={vote === 1 ? "Clear upvote" : "Upvote this answer"}
        >
          <span className={`material-icons ${vote === 1 ? "text-green-600" : "text-gray-500"}`}>
            {vote === 1 ? "thumb_up" : "thumb_up_off_alt"}
          </span>
        </button>

        {/* Downvote Button */}
        <button
          onClick={() => handleVote(docId, false)}
          className={`${styles.voteButton} ${
            vote === -1 ? styles.voteButtonDownActive : ""
          } hover:bg-gray-200 flex items-center`}
          title={vote === -1 ? "Clear downvote" : "Downvote (provide feedback)"}
        >
          <span className={`material-icons ${vote === -1 ? "text-red-600" : "text-gray-500"}`}>
            {vote === -1 ? "thumb_down" : "thumb_down_off_alt"}
          </span>
        </button>
      </div>
    );
  };

  const components: Components = {
    a: ({ href, children, ...props }) => {
      if (siteConfig?.siteId === "ananda-public" && href === "GETHUMAN") {
        return (
          <a href="https://www.ananda.org/contact-us/" {...props}>
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
  };

  return (
    <Fragment key={messageKey}>
      <div className="py-4" ref={isLastMessage ? lastMessageRef : null}>
        {message.type === "userMessage" ? (
          // User messages: right-aligned with limited width
          <div className="flex justify-end">
            <div className="max-w-md bg-blue-100 rounded-xl px-4 py-2">
              <ReactMarkdown
                remarkPlugins={[gfm]}
                components={components}
                className={`${markdownStyles.markdownanswer} text-[16px] text-black font-normal leading-normal font-sans`}
              >
                {message.message.replace(/\n/g, "  \n").replace(/\n\n/g, "\n\n")}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          // AI messages: left-aligned with 85% width for detailed responses
          <div className="max-w-[85%]">
            {!showSourcesBelow && renderSources()}
            <ReactMarkdown
              remarkPlugins={[gfm]}
              components={components}
              className={`mt-1 ${markdownStyles.markdownanswer} text-[16px] text-black font-normal leading-normal font-sans`}
            >
              {message.message.replace(/\n/g, "  \n").replace(/\n\n/g, "\n\n")}
            </ReactMarkdown>
            {showSourcesBelow && renderSources()}

            {/* Follow-up question suggestions - only for AI messages */}
            {!readOnly && message.type === "apiMessage" && message.suggestions && message.suggestions.length > 0 && (
              <SuggestionPills
                suggestions={message.suggestions}
                onSuggestionClick={onSuggestionClick || (() => {})}
                loading={loading}
              />
            )}

            {/* Action buttons for AI messages */}
            {message.type === "apiMessage" && index !== 0 && (!loading || !isLastMessage) && (
              <div className="mt-2 flex items-center space-x-2">
                {/* Copy content button always shown when message is complete */}
                <CopyButton
                  markdown={message.message}
                  answerId={message.docId || "unknown"}
                  sources={message.sourceDocs}
                  question={previousMessage?.message ?? ""}
                  siteConfig={siteConfig}
                />

                {/* Regenerate answer button - works in all modes including temporary */}
                {!readOnly && onRegenerateAnswer && (
                  <button
                    onClick={() => onRegenerateAnswer(index)}
                    className="flex items-center hover:bg-gray-200 p-1 rounded"
                    title="Regenerate this answer"
                  >
                    <span className="material-icons text-gray-500">refresh</span>
                  </button>
                )}

                {/* Link and vote buttons - always visible after loading, but disabled until docId available */}
                {!temporarySession && (
                  <>
                    <button
                      onClick={() => message.docId && handleCopyLink(message.docId)}
                      className={`flex items-center hover:bg-gray-200 p-1 rounded ${!message.docId ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={message.docId ? "Copy link to clipboard" : "Waiting for link..."}
                      disabled={!message.docId}
                    >
                      <span
                        className={`material-icons ${linkCopied === message.docId ? "text-black" : "text-gray-500"}`}
                      >
                        {linkCopied === message.docId ? "check" : "link"}
                      </span>
                    </button>

                    {!readOnly &&
                      (message.docId ? (
                        renderVoteButtons(message.docId)
                      ) : (
                        <div className="flex items-center space-x-1">
                          <button
                            disabled
                            className="opacity-50 cursor-not-allowed hover:bg-gray-200 flex items-center"
                            title="Waiting for document ID..."
                          >
                            <span className="material-icons text-gray-500">thumb_up_off_alt</span>
                          </button>
                          <button
                            disabled
                            className="opacity-50 cursor-not-allowed hover:bg-gray-200 flex items-center"
                            title="Waiting for document ID..."
                          >
                            <span className="material-icons text-gray-500">thumb_down_off_alt</span>
                          </button>
                        </div>
                      ))}

                    {/* Try GPT-4.1 button - only show if handler provided and not already regenerating */}
                    {!readOnly && onTryGPT41 && !isRegenerating && (
                      <button
                        onClick={() => onTryGPT41(index)}
                        className="flex items-center space-x-1 px-2 py-1 rounded bg-gradient-to-r from-purple-500 to-blue-500 text-white text-sm hover:from-purple-600 hover:to-blue-600 transition-all"
                        title="Regenerate this answer using GPT-4.1 for comparison"
                      >
                        <span className="material-icons text-sm">auto_awesome</span>
                        <span>Try GPT-4.1</span>
                      </button>
                    )}

                    {/* Show loading state when regenerating */}
                    {isRegenerating && (
                      <div className="flex items-center space-x-1 px-2 py-1 text-sm text-gray-600">
                        <span className="material-icons text-sm animate-spin">refresh</span>
                        <span>Generating...</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Fragment>
  );
};

export default MessageItem;
