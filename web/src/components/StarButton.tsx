import React, { useState, useEffect } from "react";
import { toast } from "react-toastify";
import { logEvent } from "@/utils/client/analytics";

export interface StarButtonProps {
  convId: string;
  isStarred: boolean;
  onStarChange: (convId: string, isStarred: boolean) => Promise<void>;
  size?: "sm" | "md" | "lg";
  location?: "title_bar" | "sidebar" | "other";
  className?: string;
}

const StarButton: React.FC<StarButtonProps> = ({
  convId,
  isStarred,
  onStarChange,
  size = "md",
  location = "other",
  className = "",
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [optimisticStarred, setOptimisticStarred] = useState(isStarred);

  // Sync internal state when prop changes from external updates (e.g., refetch)
  useEffect(() => {
    setOptimisticStarred(isStarred);
  }, [isStarred]);

  // Use optimistic state for immediate visual feedback
  const displayStarred = optimisticStarred;

  const handleStarClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isLoading) return;

    setIsLoading(true);

    // Optimistic update
    const newStarState = !displayStarred;
    setOptimisticStarred(newStarState);

    try {
      await onStarChange(convId, newStarState);

      // Track successful star/unstar action
      logEvent(
        newStarState ? "star_conversation" : "unstar_conversation",
        "Conversation Management",
        `${newStarState ? "Star" : "Unstar"} - ${location}`,
        1
      );
    } catch (_error) {
      // Rollback on error
      setOptimisticStarred(!newStarState);
      toast.error("Failed to update star status. Please try again.");

      // Track failed star action
      logEvent(
        "star_action_failed",
        "Conversation Management",
        `Failed ${newStarState ? "Star" : "Unstar"} - ${location}`,
        1
      );
    } finally {
      setIsLoading(false);
    }
  };

  const sizeClasses = {
    sm: "w-4 h-4 text-sm",
    md: "w-5 h-5 text-base",
    lg: "w-6 h-6 text-lg",
  };

  const baseClasses =
    "inline-flex items-center justify-center transition-all duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded";

  const starClasses = displayStarred ? "text-yellow-500 hover:text-yellow-600" : "text-gray-400 hover:text-yellow-500";

  const disabledClasses = isLoading ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:scale-110";

  return (
    <button
      onClick={handleStarClick}
      disabled={isLoading}
      className={`${baseClasses} ${starClasses} ${disabledClasses} ${sizeClasses[size]} ${className}`}
      aria-label={displayStarred ? "Unstar conversation" : "Star conversation"}
      title={displayStarred ? "Unstar conversation" : "Star conversation"}
    >
      {isLoading ? (
        <div className="animate-spin rounded-full border-2 border-gray-300 border-t-current h-3 w-3"></div>
      ) : (
        <span className="select-none">{displayStarred ? "★" : "☆"}</span>
      )}
    </button>
  );
};

export default StarButton;
