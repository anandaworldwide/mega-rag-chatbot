import React from "react";
import StarButton from "./StarButton";

interface ConversationTitleBarProps {
  convId: string | null;
  title: string | null;
  isStarred: boolean;
  onStarChange: (convId: string, isStarred: boolean) => Promise<void>;
}

export default function ConversationTitleBar({ convId, title, isStarred, onStarChange }: ConversationTitleBarProps) {
  if (!convId) return null;

  const handleStarChange = async (convId: string, newStarState: boolean) => {
    await onStarChange(convId, newStarState);
  };

  return (
    <div className="bg-white border-b border-gray-200 py-2 mb-4 flex items-center gap-3">
      <StarButton
        convId={convId}
        isStarred={isStarred}
        onStarChange={handleStarChange}
        size="sm"
        location="title_bar"
        className="flex-shrink-0"
      />
      <h2 className="text-sm font-medium text-gray-700 truncate flex-1">{title || "Untitled Conversation"}</h2>
    </div>
  );
}
