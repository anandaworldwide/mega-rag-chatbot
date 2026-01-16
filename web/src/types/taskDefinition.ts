export interface TaskStep {
  id: string;
  type: "text" | "textarea" | "checkbox";
  label: string;
  placeholder?: string;
  required?: boolean;
  helpText?: string;
  default?: string | boolean;
}

export interface TaskDefinition {
  taskId: string;
  displayName: string;
  icon: string;
  description: string;
  sourceCount: number;
  steps: TaskStep[];
  suggestedFollowups: string[];
  promptTemplate: string;
}

export interface TaskRegistryEntry {
  taskId: string;
  file: string;
  enabled: boolean;
}

export interface TaskRegistry {
  tasks: TaskRegistryEntry[];
}
