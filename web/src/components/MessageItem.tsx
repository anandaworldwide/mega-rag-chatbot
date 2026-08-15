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
import { TypedSuggestion } from "@/types/Suggestion";

import { useSudo } from "@/contexts/SudoContext";
import { Components } from "react-markdown";
import { TitleScopeSelection } from "@/types/titleScope";

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
  hideVoteButtons?: boolean;
  lastMessageRef: React.RefObject<HTMLDivElement> | null;
  messageKey: string;
  voteError?: string | null;
  allowAllAnswersPage: boolean;
  showSourcesBelow?: boolean;
  onSuggestionClick?: (suggestion: TypedSuggestion, position: number) => void;
  readOnly?: boolean; // New prop to disable interactive elements
  onRegenerateAnswer?: (messageIndex: number) => void; // New prop for regenerating answer
  onEditQuestion?: (messageIndex: number, originalText: string) => void; // New prop for editing question
  isEditing?: boolean; // Track if this message is being edited
  editingText?: string; // Current editing text
  onSaveEdit?: (messageIndex: number, editedText: string) => void; // Handler for saving edit
  onCancelEdit?: (messageIndex: number) => void; // Handler for canceling edit
  sourceLinkCopied?: string | null; // Source ID that was copied (for visual feedback)
  onSourceExpanded?: (index: number) => void; // Callback when source should be expanded (for deep linking)
  onSourceLinkCopied?: (sourceId: string) => void; // Callback when source link is copied
  activeTitleScope?: TitleScopeSelection | null;
  onFocusSourceScope?: (scope: TitleScopeSelection) => void;
  timingMetricsDisplay?: React.ReactNode; // Timing metrics to display before suggestions
  answerFeedbackPrompt?: React.ReactNode; // Soft feedback nudge below action bar, above suggestion pills
  isAdminOrSuperuser?: boolean; // For login-required sites: whether user is admin/superuser
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
  hideVoteButtons = false,
  lastMessageRef,
  messageKey,
  showSourcesBelow = false,
  onSuggestionClick,
  readOnly = false,
  onRegenerateAnswer,
  onEditQuestion,
  isEditing = false,
  editingText = "",
  onSaveEdit,
  onCancelEdit,
  sourceLinkCopied,
  onSourceExpanded,
  onSourceLinkCopied,
  activeTitleScope = null,
  onFocusSourceScope,
  timingMetricsDisplay,
  answerFeedbackPrompt,
  isAdminOrSuperuser = false,
}) => {
  const { isSudoUser } = useSudo();
  // Combine sudo user status with admin/superuser status for privileged access
  const isPrivilegedUser = isSudoUser || isAdminOrSuperuser;
  const [localEditingText, setLocalEditingText] = React.useState(editingText);

  // Sync local editing text when editing state changes
  React.useEffect(() => {
    if (isEditing) {
      setLocalEditingText(editingText);
    }
  }, [isEditing, editingText]);

  const renderSources = () => {
    if (message.sourceDocs && message.sourceDocs.length > 0) {
      return (
        <div className={showSourcesBelow ? "mt-2" : "mb-2"}>
          <SourcesList
            sources={message.sourceDocs}
            collectionName={collectionChanged && hasMultipleCollections ? message.collection : null}
            siteConfig={siteConfig}
            isSudoAdmin={isPrivilegedUser}
            docId={message.docId}
            sourceLinkCopied={sourceLinkCopied}
            onSourceExpanded={onSourceExpanded}
            onSourceLinkCopied={onSourceLinkCopied}
            activeTitleScope={activeTitleScope}
            onFocusSourceScope={onFocusSourceScope}
          />
        </div>
      );
    }
    return null;
  };

  const renderVoteButtons = (docId: string) => {
    if (!docId || hideVoteButtons) return null;

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
          } hover:bg-gray-100 flex items-center p-2 rounded-xl h-8 w-8 justify-center transition-colors`}
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
          } hover:bg-gray-100 flex items-center p-2 rounded-xl h-8 w-8 justify-center transition-colors`}
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

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (onSaveEdit) {
        onSaveEdit(index, localEditingText);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (onCancelEdit) {
        onCancelEdit(index);
      }
    }
  };

  return (
    <Fragment key={messageKey}>
      <div className="py-4" ref={isLastMessage ? lastMessageRef : null}>
        {message.type === "userMessage" ? (
          // User messages: right-aligned with limited width
          <div className="flex justify-end">
            {isEditing ? (
              // Edit mode: editable textarea with save/cancel buttons
              <div className="max-w-4xl w-full bg-blue-100 rounded-xl px-4 py-2">
                <textarea
                  value={localEditingText}
                  onChange={(e) => setLocalEditingText(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  className="w-full bg-white border border-blue-300 rounded-lg px-3 py-2 text-[16px] text-black font-normal leading-normal font-sans resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={Math.max(3, localEditingText.split("\n").length)}
                  autoFocus
                />
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    onClick={() => onCancelEdit && onCancelEdit(index)}
                    className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-200 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => onSaveEdit && onSaveEdit(index, localEditingText)}
                    className="px-3 py-1 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              // Normal mode: display message with edit button
              <div className="relative group max-w-md bg-blue-100 rounded-xl px-4 py-2 message-bubble-with-edit">
                <ReactMarkdown
                  remarkPlugins={[gfm]}
                  components={components}
                  className={`${markdownStyles.markdownanswer} text-[16px] text-black font-normal leading-normal font-sans`}
                >
                  {message.message.replace(/\n/g, "  \n").replace(/\n\n/g, "\n\n")}
                </ReactMarkdown>
                {/* Edit button - only show for non-read-only mode */}
                {!readOnly && onEditQuestion && (
                  <button
                    onClick={() => {
                      setLocalEditingText(message.message);
                      onEditQuestion(index, message.message);
                    }}
                    className="edit-button-mobile absolute -left-8 top-2 opacity-0 group-hover:opacity-100 hover:bg-gray-200 p-1 rounded-lg transition-opacity"
                    title="Edit question"
                  >
                    <span className="material-icons text-gray-500 text-lg">edit</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          // AI messages: left-aligned with 85% width for detailed responses
          <div className="max-w-[85%]">
            {!showSourcesBelow && renderSources()}
            {(() => {
              const trimmedStatus = message.message.trim();
              const isStatusLoadingMessage =
                trimmedStatus === "Searching locations..." ||
                trimmedStatus === "Gathering additional sources...";
              const showStatusLoading =
                loading && isLastMessage && (message.message === "" || isStatusLoadingMessage);

              if (showStatusLoading) {
                // Loading dots while waiting for first token or during tool-status placeholders
                return (
                  <div className="mt-1 flex items-center gap-2">
                    {isStatusLoadingMessage && (
                      <ReactMarkdown
                        remarkPlugins={[gfm]}
                        components={components}
                        className={`${markdownStyles.markdownanswer} text-[16px] text-black leading-normal font-sans ${
                          index === 0 ? "font-bold" : "font-normal"
                        }`}
                      >
                        {message.message.replace(/\n/g, "  \n").replace(/\n\n/g, "\n\n")}
                      </ReactMarkdown>
                    )}
                    <div className="flex space-x-1">
                      <div
                        className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                        style={{ animationDelay: "0ms" }}
                      ></div>
                      <div
                        className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                        style={{ animationDelay: "150ms" }}
                      ></div>
                      <div
                        className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                        style={{ animationDelay: "300ms" }}
                      ></div>
                    </div>
                  </div>
                );
              }

              return (
                <ReactMarkdown
                  remarkPlugins={[gfm]}
                  components={components}
                  className={`mt-1 ${markdownStyles.markdownanswer} text-[16px] text-black leading-normal font-sans ${
                    index === 0 ? "font-bold" : "font-normal"
                  }`}
                >
                  {message.message.replace(/\n/g, "  \n").replace(/\n\n/g, "\n\n")}
                </ReactMarkdown>
              );
            })()}
            {isPrivilegedUser && message.model && (
              <div className="mt-1 text-xs text-gray-400 select-all" title="Answer model (admin only)">
                model: {message.model}
              </div>
            )}
            {showSourcesBelow && renderSources()}

            {/* Action buttons for AI messages */}
            {message.type === "apiMessage" && index !== 0 && (!loading || !isLastMessage) && (
              <div className="mt-2 flex items-center space-x-2">
                {/* Regenerate answer button - only show for the last answer */}
                {!readOnly && onRegenerateAnswer && isLastMessage && (
                  <button
                    onClick={() => onRegenerateAnswer(index)}
                    className="flex items-center hover:bg-gray-100 p-2 rounded-xl h-8 w-8 justify-center transition-colors"
                    title="Regenerate this answer"
                  >
                    <span className="material-icons text-gray-500">refresh</span>
                  </button>
                )}

                {/* Copy content button always shown when message is complete */}
                <CopyButton
                  markdown={message.message}
                  answerId={message.docId || "unknown"}
                  sources={message.sourceDocs}
                  question={previousMessage?.message ?? ""}
                  siteConfig={siteConfig}
                  temporarySession={temporarySession}
                />

                {/* Link and vote buttons - always visible after loading, but disabled until docId available */}
                {!temporarySession && (
                  <>
                    <button
                      onClick={() => message.docId && handleCopyLink(message.docId)}
                      className={`flex items-center hover:bg-gray-100 p-2 rounded-xl h-8 w-8 justify-center transition-colors ${!message.docId ? "opacity-50 cursor-not-allowed" : ""}`}
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
                      !hideVoteButtons &&
                      (message.docId ? (
                        renderVoteButtons(message.docId)
                      ) : (
                        <div className="flex items-center space-x-1">
                          <button
                            disabled
                            className="opacity-50 cursor-not-allowed hover:bg-gray-100 flex items-center p-2 rounded-xl h-8 w-8 justify-center transition-colors"
                            title="Waiting for document ID..."
                          >
                            <span className="material-icons text-gray-500">thumb_up_off_alt</span>
                          </button>
                          <button
                            disabled
                            className="opacity-50 cursor-not-allowed hover:bg-gray-100 flex items-center p-2 rounded-xl h-8 w-8 justify-center transition-colors"
                            title="Waiting for document ID..."
                          >
                            <span className="material-icons text-gray-500">thumb_down_off_alt</span>
                          </button>
                        </div>
                      ))}
                  </>
                )}
              </div>
            )}

            {answerFeedbackPrompt}

            {/* Timing metrics - display before suggestions */}
            {timingMetricsDisplay && isLastMessage && message.type === "apiMessage" && (
              <div className="mt-2">{timingMetricsDisplay}</div>
            )}

            {/* Follow-up suggestions */}
            {!readOnly &&
              message.type === "apiMessage" &&
              isLastMessage &&
              message.suggestions &&
              message.suggestions.length > 0 && (
                <SuggestionPills
                  suggestions={message.suggestions}
                  onSuggestionClick={onSuggestionClick || (() => {})}
                  loading={loading}
                />
              )}
          </div>
        )}
      </div>
    </Fragment>
  );
};

export default MessageItem;
