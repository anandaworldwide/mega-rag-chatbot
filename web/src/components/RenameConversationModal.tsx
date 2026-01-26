import React, { useState, useEffect, useRef, useCallback } from "react";

interface RenameConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (newTitle: string) => Promise<void>;
  currentTitle: string;
  isLoading?: boolean;
}

export default function RenameConversationModal({
  isOpen,
  onClose,
  onSave,
  currentTitle,
  isLoading = false,
}: RenameConversationModalProps) {
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setTitle(currentTitle);
      setError(null);
      // Focus input after modal animation
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 100);
    }
  }, [isOpen, currentTitle]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const trimmedTitle = title.trim();

      // Validation
      if (!trimmedTitle) {
        setError("Title cannot be empty");
        return;
      }

      if (trimmedTitle.length > 100) {
        setError("Title must be 100 characters or less");
        return;
      }

      if (trimmedTitle === currentTitle.trim()) {
        // No change, just close
        onClose();
        return;
      }

      setError(null);

      try {
        await onSave(trimmedTitle);
        onClose();
      } catch (error) {
        setError(error instanceof Error ? error.message : "Failed to rename conversation");
      }
    },
    [title, currentTitle, onClose, onSave]
  );

  // Handle escape and enter keys
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen && !isLoading) {
        onClose();
      } else if (e.key === "Enter" && isOpen && !isLoading) {
        e.preventDefault();
        handleSubmit(e as any); // Cast to React.FormEvent for compatibility
      }
    }

    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, isLoading, onClose, handleSubmit]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isLoading) {
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Rename Conversation</h3>
        </div>

        {/* Form */}
        <div className="px-6 py-4">
          <div className="mb-4">
            <label htmlFor="conversation-title" className="block text-sm font-medium text-gray-700 mb-2">
              Conversation Title
            </label>
            <input
              ref={inputRef}
              id="conversation-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isLoading}
              className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
              placeholder="Enter conversation title"
              maxLength={100}
            />
            <div className="mt-1 text-xs text-gray-500">{title.length}/100 characters</div>
            {error && (
              <div className="mt-2 text-sm text-red-600 flex items-center">
                <span className="material-icons text-sm mr-1">error</span>
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading || !title.trim() || title.trim() === currentTitle.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          >
            {isLoading && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
