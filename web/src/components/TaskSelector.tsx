import React, { useState, useEffect } from "react";
import { TaskRegistryEntry } from "@/types/taskDefinition";
import { getEnabledTasks, loadTaskDefinition } from "@/utils/client/taskLoader";
import { logEvent } from "@/utils/client/analytics";
import { SiteConfig } from "@/types/siteConfig";

interface TaskSelectorProps {
  onTaskSelect: (taskId: string) => void;
  visible: boolean;
  siteConfig: SiteConfig | null;
}

export const TaskSelector: React.FC<TaskSelectorProps> = ({ onTaskSelect, visible, siteConfig }) => {
  const [tasks, setTasks] = useState<TaskRegistryEntry[]>([]);
  const [taskDetails, setTaskDetails] = useState<
    Record<string, { displayName: string; icon: string; description: string }>
  >({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const loadTasks = async () => {
      setIsLoading(true);
      try {
        const enabledTasks = await getEnabledTasks(siteConfig?.enabledTasks);
        setTasks(enabledTasks);

        // Load details for each task
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
        setIsLoading(false);
      }
    };

    loadTasks();
  }, [visible, siteConfig?.enabledTasks]);

  if (!visible) {
    return null;
  }

  if (isLoading || tasks.length === 0) {
    return null;
  }

  const handleTaskClick = (taskId: string) => {
    logEvent("task_card_click", "Tasks", taskId);
    onTaskSelect(taskId);
  };

  return (
    <div className="w-full mb-3">
      <div className="flex flex-wrap gap-2 justify-center">
        {tasks.map((task) => {
          const details = taskDetails[task.taskId];
          if (!details) {
            return null;
          }

          return (
            <button
              key={task.taskId}
              onClick={() => handleTaskClick(task.taskId)}
              title={details.description}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-full hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
            >
              <span className="material-icons text-base">{details.icon}</span>
              <span>{details.displayName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
