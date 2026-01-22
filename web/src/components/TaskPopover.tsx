/**
 * TaskPopover Component
 *
 * A popover that shows task chips and transforms into a wizard form when a task is selected.
 * The popover stays connected to the trigger button for a cohesive UI experience.
 */

import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { TaskRegistryEntry, TaskDefinition, TaskStep } from "@/types/taskDefinition";
import { getEnabledTasks, loadTaskDefinition } from "@/utils/client/taskLoader";
import { generatePrompt } from "@/utils/client/promptGenerator";
import { logEvent } from "@/utils/client/analytics";
import { SiteConfig } from "@/types/siteConfig";

interface TaskPopoverProps {
  siteConfig: SiteConfig | null;
  onTaskSubmit: (
    prompt: string,
    sourceCount: number,
    taskMode: string,
    suggestedFollowups: string[],
    authorFilter?: string
  ) => void;
}

export const TaskPopover: React.FC<TaskPopoverProps> = ({ siteConfig, onTaskSubmit }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Task selection state
  const [tasks, setTasks] = useState<TaskRegistryEntry[]>([]);
  const [taskDetails, setTaskDetails] = useState<
    Record<string, { displayName: string; icon: string; description: string }>
  >({});
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);

  // Wizard state
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDefinition, setTaskDefinition] = useState<TaskDefinition | null>(null);
  const [isLoadingWizard, setIsLoadingWizard] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load tasks when popover opens
  useEffect(() => {
    if (!isOpen) return;

    const loadTasks = async () => {
      setIsLoadingTasks(true);
      try {
        const enabledTasks = await getEnabledTasks(siteConfig?.enabledTasks);
        setTasks(enabledTasks);

        const details: Record<string, { displayName: string; icon: string; description: string }> = {};
        for (const task of enabledTasks) {
          const definition = await loadTaskDefinition(task.taskId);
          if (definition) {
            details[task.taskId] = {
              displayName: definition.displayName,
              icon: definition.icon,
              description: definition.description,
            };
          }
        }
        setTaskDetails(details);
      } catch (error) {
        console.error("Failed to load tasks:", error);
      } finally {
        setIsLoadingTasks(false);
      }
    };

    loadTasks();
  }, [isOpen, siteConfig?.enabledTasks]);

  // Load task definition when a task is selected
  useEffect(() => {
    if (!selectedTaskId) return;

    setIsLoadingWizard(true);
    setFormError(null);
    setFormValues({});

    loadTaskDefinition(selectedTaskId)
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
          setFormError("Task definition not found");
        }
      })
      .catch((err) => {
        console.error("Failed to load task definition:", err);
        setFormError("Failed to load task definition");
      })
      .finally(() => {
        setIsLoadingWizard(false);
      });
  }, [selectedTaskId]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        handleClose();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Close popover on Escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        if (selectedTaskId) {
          // Go back to task list
          setSelectedTaskId(null);
          setTaskDefinition(null);
          setFormValues({});
          setFormError(null);
        } else {
          handleClose();
        }
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, selectedTaskId]);

  // Close popover on browser navigation (back/forward button)
  useEffect(() => {
    const handlePopState = () => {
      if (isOpen) {
        handleClose();
      }
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isOpen]);

  // Calculate popover position
  const calculatePopoverPosition = () => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 8;
    const popoverWidth = 400;
    const popoverHeight = popoverRef.current?.offsetHeight || 400;

    // Position above the button (since it's at the bottom of the screen)
    let top = rect.top - popoverHeight - gap;
    let left = rect.left;

    // Ensure it doesn't go off-screen horizontally
    if (left + popoverWidth > window.innerWidth - 10) {
      left = window.innerWidth - popoverWidth - 10;
    }
    if (left < 10) {
      left = 10;
    }

    // If not enough space above, position below
    if (top < 10) {
      top = rect.bottom + gap;
    }

    setPopoverPosition({ top: Math.max(10, top), left });
    setIsPositioned(true);
  };

  // Recalculate position on open/resize/scroll
  useEffect(() => {
    const handleUpdate = () => {
      if (isOpen) calculatePopoverPosition();
    };

    if (isOpen) {
      // Use requestAnimationFrame to ensure the DOM has updated before calculating position
      requestAnimationFrame(() => {
        calculatePopoverPosition();
      });
      window.addEventListener("resize", handleUpdate);
      window.addEventListener("scroll", handleUpdate, true);
    }

    return () => {
      window.removeEventListener("resize", handleUpdate);
      window.removeEventListener("scroll", handleUpdate, true);
    };
  }, [isOpen, selectedTaskId, taskDefinition]);

  const handleClose = () => {
    setIsOpen(false);
    setIsPositioned(false);
    setSelectedTaskId(null);
    setTaskDefinition(null);
    setFormValues({});
    setFormError(null);
  };

  const togglePopover = () => {
    if (isOpen) {
      handleClose();
    } else {
      setIsOpen(true);
      logEvent("task_popover_open", "Tasks", "button_click");
    }
  };

  const handleTaskSelect = (taskId: string) => {
    setSelectedTaskId(taskId);
    logEvent("task_popover_select", "Tasks", taskId);
  };

  const handleBack = () => {
    setSelectedTaskId(null);
    setTaskDefinition(null);
    setFormValues({});
    setFormError(null);
  };

  const handleFieldChange = (stepId: string, value: any) => {
    setFormValues((prev) => ({
      ...prev,
      [stepId]: value,
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskDefinition || isSubmitting) return;

    // Validate required fields
    const missingFields: string[] = [];
    taskDefinition.steps.forEach((step) => {
      if (step.required && (!formValues[step.id] || formValues[step.id] === "")) {
        missingFields.push(step.label);
      }
    });

    if (missingFields.length > 0) {
      setFormError(`Please fill in: ${missingFields.join(", ")}`);
      return;
    }

    setIsSubmitting(true);

    try {
      const prompt = generatePrompt(taskDefinition.promptTemplate, formValues);
      const authorFilter = formValues.author as string | undefined;

      onTaskSubmit(
        prompt,
        taskDefinition.sourceCount,
        taskDefinition.taskId,
        taskDefinition.suggestedFollowups,
        authorFilter
      );

      logEvent("task_popover_submit", "Tasks", selectedTaskId || "");
      handleClose();
    } catch (err) {
      console.error("Failed to generate prompt:", err);
      setFormError("Failed to generate prompt. Please try again.");
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
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
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

      case "select":
        return (
          <select
            id={step.id}
            value={value}
            onChange={(e) => handleFieldChange(step.id, e.target.value)}
            required={step.required}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
          >
            {step.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );

      default:
        return null;
    }
  };

  // Don't render if no tasks are enabled
  if (!siteConfig?.enabledTasks || siteConfig.enabledTasks.length === 0) {
    return null;
  }

  return (
    <>
      {/* Task Button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={togglePopover}
        className={`relative flex items-center justify-center p-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors ${
          isOpen ? "bg-gray-100 border-blue-500" : ""
        }`}
        title="Task wizard"
        aria-label="Open task wizard"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <span className="material-icons text-base">auto_fix_high</span>
      </button>

      {/* Popover */}
      {isOpen &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed w-[400px] max-w-[calc(100vw-20px)] bg-white border border-gray-200 rounded-xl shadow-lg z-[90] max-h-[70vh] overflow-hidden flex flex-col transition-opacity duration-75"
            style={{
              top: `${popoverPosition.top}px`,
              left: `${popoverPosition.left}px`,
              opacity: isPositioned ? 1 : 0,
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              {selectedTaskId && taskDefinition ? (
                <>
                  <button
                    onClick={handleBack}
                    className="flex items-center text-sm text-gray-600 hover:text-gray-900 transition-colors"
                  >
                    <span className="material-icons text-base mr-1">arrow_back</span>
                    Back
                  </button>
                  <h3 className="text-sm font-semibold text-gray-900 flex items-center">
                    <span className="material-icons text-blue-500 text-base mr-1.5">{taskDefinition.icon}</span>
                    {taskDefinition.displayName}
                  </h3>
                  <button
                    onClick={handleClose}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close"
                  >
                    <span className="material-icons text-lg">close</span>
                  </button>
                </>
              ) : (
                <>
                  <h3 className="text-sm font-semibold text-gray-900">Choose a Task</h3>
                  <button
                    onClick={handleClose}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close"
                  >
                    <span className="material-icons text-lg">close</span>
                  </button>
                </>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {!selectedTaskId ? (
                // Task Selection View
                <>
                  {isLoadingTasks ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
                      <span className="ml-2 text-sm text-gray-600">Loading tasks...</span>
                    </div>
                  ) : tasks.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">No tasks available</p>
                  ) : (
                    <div className="flex flex-wrap gap-2 justify-center">
                      {tasks.map((task) => {
                        const details = taskDetails[task.taskId];
                        if (!details) return null;

                        return (
                          <button
                            key={task.taskId}
                            onClick={() => handleTaskSelect(task.taskId)}
                            title={details.description}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-full hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                          >
                            <span className="material-icons text-base">{details.icon}</span>
                            <span>{details.displayName}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                // Wizard Form View
                <form onSubmit={handleSubmit} id="task-wizard-form">
                  {isLoadingWizard ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
                      <span className="ml-2 text-sm text-gray-600">Loading...</span>
                    </div>
                  ) : formError && !taskDefinition ? (
                    <div className="bg-red-100 border border-red-400 text-red-700 px-3 py-2 rounded text-sm">
                      {formError}
                    </div>
                  ) : taskDefinition ? (
                    <div className="space-y-3">
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
                  ) : null}
                </form>
              )}
            </div>

            {/* Footer - only show when in wizard mode */}
            {selectedTaskId && taskDefinition && !isLoadingWizard && (
              <div className="px-4 py-3 border-t border-gray-200 bg-gray-50">
                {formError && taskDefinition && (
                  <div className="bg-red-100 border border-red-400 text-red-700 px-3 py-2 rounded text-sm mb-3">
                    {formError}
                  </div>
                )}
                <div className="flex justify-end">
                  <button
                    type="submit"
                    form="task-wizard-form"
                    disabled={isSubmitting}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? "Generating..." : "Generate"}
                  </button>
                </div>
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  );
};
