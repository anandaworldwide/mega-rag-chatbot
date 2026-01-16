import React, { useState, useEffect } from "react";
import { TaskRegistryEntry } from "@/types/taskDefinition";
import { getEnabledTasks, loadTaskDefinition } from "@/utils/client/taskLoader";
import { logEvent } from "@/utils/client/analytics";

interface TaskSelectorProps {
  onTaskSelect: (taskId: string) => void;
  visible: boolean;
}

export const TaskSelector: React.FC<TaskSelectorProps> = ({ onTaskSelect, visible }) => {
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
        const enabledTasks = await getEnabledTasks();
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
  }, [visible]);

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
    <div className="w-full mb-4">
      <div className="text-sm font-medium text-gray-700 mb-3">Try one of these:</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tasks.map((task) => {
          const details = taskDetails[task.taskId];
          if (!details) {
            return null;
          }

          return (
            <button
              key={task.taskId}
              onClick={() => handleTaskClick(task.taskId)}
              className="flex items-start p-4 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50 transition-colors text-left"
            >
              <span className="material-icons text-blue-500 mr-3 mt-0.5">{details.icon}</span>
              <div className="flex-1">
                <div className="font-semibold text-gray-900 mb-1">{details.displayName}</div>
                <div className="text-sm text-gray-600">{details.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
