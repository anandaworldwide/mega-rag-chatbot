/**
 * Shared model options configuration
 * Used across Model Comparison and main chat interface
 */

export interface ModelOption {
  value: string;
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
  { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  { value: "gpt-4o", label: "GPT-4 Optimized" },
  { value: "gpt-4o-mini", label: "GPT-4 Optimized Mini" },
  { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { value: "gpt-4", label: "GPT-4" },
  { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
];

export const DEFAULT_MODEL = "gpt-4.1-mini";
