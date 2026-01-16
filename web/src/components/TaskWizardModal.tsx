import React, { useState, useEffect } from "react";
import { TaskDefinition, TaskStep } from "@/types/taskDefinition";
import { loadTaskDefinition } from "@/utils/client/taskLoader";
import { generatePrompt } from "@/utils/client/promptGenerator";
import { logEvent } from "@/utils/client/analytics";

interface TaskWizardModalProps {
  taskId: string;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string, sourceCount: number, taskMode: string, suggestedFollowups: string[]) => void;
}

export const TaskWizardModal: React.FC<TaskWizardModalProps> = ({ taskId, isOpen, onClose, onSubmit }) => {
  const [taskDefinition, setTaskDefinition] = useState<TaskDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load task definition when modal opens
  useEffect(() => {
    if (isOpen && taskId) {
      setIsLoading(true);
      setError(null);
      setFormValues({});

      loadTaskDefinition(taskId)
        .then((definition) => {
          if (definition) {
            setTaskDefinition(definition);
            // Initialize form values with defaults
            const initialValues: Record<string, any> = {};
            definition.steps.forEach((step) => {
              if (step.default !== undefined) {
                initialValues[step.id] = step.default;
              } else if (step.type === "checkbox") {
                initialValues[step.id] = false;
              } else {
                initialValues[step.id] = "";
              }
            });
            setFormValues(initialValues);
          } else {
            setError("Task definition not found");
          }
        })
        .catch((err) => {
          console.error("Failed to load task definition:", err);
          setError("Failed to load task definition");
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [isOpen, taskId]);

  // Handle Escape key to close modal
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        onClose();
        logEvent("task_wizard_cancel", "Tasks", taskId);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose, taskId]);

  // Handle backdrop click to close modal
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
      logEvent("task_wizard_cancel", "Tasks", taskId);
    }
  };

  // Handle close button click
  const handleCloseClick = () => {
    logEvent("task_wizard_cancel", "Tasks", taskId);
    onClose();
  };

  // Handle form field changes
  const handleFieldChange = (stepId: string, value: any) => {
    setFormValues((prev) => ({
      ...prev,
      [stepId]: value,
    }));
  };

  // Handle form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskDefinition || isSubmitting) {
      return;
    }

    // Validate required fields
    const missingFields: string[] = [];
    taskDefinition.steps.forEach((step) => {
      if (step.required && (!formValues[step.id] || formValues[step.id] === "")) {
        missingFields.push(step.label);
      }
    });

    if (missingFields.length > 0) {
      setError(`Please fill in: ${missingFields.join(", ")}`);
      return;
    }

    setIsSubmitting(true);

    try {
      // Generate prompt from template
      const prompt = generatePrompt(taskDefinition.promptTemplate, formValues);

      // Submit
      onSubmit(prompt, taskDefinition.sourceCount, taskDefinition.taskId, taskDefinition.suggestedFollowups);

      logEvent("task_wizard_submit", "Tasks", taskId);
      onClose();
    } catch (err) {
      console.error("Failed to generate prompt:", err);
      setError("Failed to generate prompt. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Render form field based on step type
  const renderField = (step: TaskStep) => {
    const value =
      formValues[step.id] ?? (step.default !== undefined ? step.default : step.type === "checkbox" ? false : "");

    switch (step.type) {
      case "text":
        return (
          <input
            type="text"
            id={step.id}
            value={value}
            onChange={(e) => handleFieldChange(step.id, e.target.value)}
            placeholder={step.placeholder}
            required={step.required}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        );

      case "textarea":
        return (
          <textarea
            id={step.id}
            value={value}
            onChange={(e) => handleFieldChange(step.id, e.target.value)}
            placeholder={step.placeholder}
            required={step.required}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
          />
        );

      case "checkbox":
        return (
          <label className="flex items-center">
            <input
              type="checkbox"
              id={step.id}
              checked={value}
              onChange={(e) => handleFieldChange(step.id, e.target.checked)}
              className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <span className="text-sm text-gray-700">{step.label}</span>
          </label>
        );

      default:
        return null;
    }
  };

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100]"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="fixed z-[101] top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white p-6 rounded-xl shadow-lg max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            {taskDefinition && <span className="material-icons text-blue-500 mr-2">{taskDefinition.icon}</span>}
            {taskDefinition?.displayName || "Task Wizard"}
          </h3>
          <button
            onClick={handleCloseClick}
            className="text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Close wizard"
          >
            <span className="material-icons">close</span>
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit}>
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <span className="ml-3 text-gray-600">Loading task...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
              <span className="block sm:inline">{error}</span>
            </div>
          )}

          {!isLoading && taskDefinition && (
            <div className="space-y-4">
              {taskDefinition.steps.map((step) => (
                <div key={step.id}>
                  {step.type !== "checkbox" && (
                    <label htmlFor={step.id} className="block text-sm font-medium text-gray-700 mb-1">
                      {step.label}
                      {step.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                  )}
                  {renderField(step)}
                  {step.helpText && <p className="mt-1 text-xs text-gray-500">{step.helpText}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          {!isLoading && taskDefinition && (
            <div className="mt-6 pt-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseClick}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Generating..." : "Generate"}
              </button>
            </div>
          )}
        </form>
      </div>
    </>
  );
};
