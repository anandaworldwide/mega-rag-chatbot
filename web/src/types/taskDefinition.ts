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
  suggestedFollowups: string[]; // Static/general follow-ups (always shown)
  promptTemplate: string;
}

/**
 * Props for follow-up suggestions that support both dynamic (AI-generated)
 * and static (from task definition) suggestions
 */
export interface TaskFollowupsState {
  dynamic: string[]; // AI-generated context-specific suggestions
  static: string[]; // From task definition (general actions)
  isLoadingDynamic: boolean; // Loading state for AI generation
}

export interface TaskRegistryEntry {
  taskId: string;
  file: string;
  enabled: boolean;
}

export interface TaskRegistry {
  tasks: TaskRegistryEntry[];
}
