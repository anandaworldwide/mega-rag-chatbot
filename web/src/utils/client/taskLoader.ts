import { TaskDefinition, TaskRegistry, TaskRegistryEntry } from "@/types/taskDefinition";

let registryCache: TaskRegistry | null = null;
const taskDefinitionCache: Record<string, TaskDefinition | null> = {};

/**
 * Loads the task registry from the site-config directory
 * @returns Promise resolving to the task registry
 */
export async function loadTaskRegistry(): Promise<TaskRegistry | null> {
  if (registryCache) {
    return registryCache;
  }

  try {
    const response = await fetch("/site-config/tasks/_registry.json");
    if (!response.ok) {
      console.warn("Task registry not found");
      return null;
    }
    const registry: TaskRegistry = await response.json();
    registryCache = registry;
    return registry;
  } catch (error) {
    console.error("Failed to load task registry:", error);
    return null;
  }
}

/**
 * Loads a task definition by task ID
 * @param taskId - The ID of the task to load
 * @returns Promise resolving to the task definition or null if not found
 */
export async function loadTaskDefinition(taskId: string): Promise<TaskDefinition | null> {
  if (taskDefinitionCache[taskId]) {
    return taskDefinitionCache[taskId];
  }

  try {
    const response = await fetch(`/site-config/tasks/${taskId}.json`);
    if (!response.ok) {
      console.warn(`Task definition not found for taskId: ${taskId}`);
      return null;
    }
    const definition: TaskDefinition = await response.json();
    taskDefinitionCache[taskId] = definition;
    return definition;
  } catch (error) {
    console.error(`Failed to load task definition for ${taskId}:`, error);
    return null;
  }
}

/**
 * Gets enabled tasks from the registry, filtered by site configuration
 * @param enabledTaskIds - Array of task IDs enabled for the current site (from siteConfig.enabledTasks)
 * @returns Promise resolving to array of enabled task entries
 */
export async function getEnabledTasks(enabledTaskIds?: string[]): Promise<TaskRegistryEntry[]> {
  // If no tasks are enabled for this site, return empty array
  if (!enabledTaskIds || enabledTaskIds.length === 0) {
    return [];
  }

  const registry = await loadTaskRegistry();
  if (!registry) {
    return [];
  }

  // Filter tasks that are both enabled in registry AND enabled for this site
  return registry.tasks.filter((task) => task.enabled && enabledTaskIds.includes(task.taskId));
}
