// Helper type for media types
export interface MediaTypes {
  text?: boolean;
  image?: boolean;
  video?: boolean;
  audio?: boolean;
  [key: string]: boolean | undefined;
}

// Helper function to determine active media types based on input and config
export function determineActiveMediaTypes(
  mediaTypes: Partial<MediaTypes> | undefined,
  configuredEnabledTypes: string[] | undefined
): string[] {
  const enabledMediaTypes = configuredEnabledTypes || ["text", "audio", "youtube"];
  let activeTypes: string[] = [];

  if (mediaTypes) {
    enabledMediaTypes.forEach((type) => {
      if (mediaTypes[type] === true) {
        activeTypes.push(type);
      }
    });
  }

  // If no valid types were explicitly selected or provided, default to all enabled types
  if (activeTypes.length === 0) {
    console.log("No valid media types selected, defaulting to all enabled types:", enabledMediaTypes);
    activeTypes = enabledMediaTypes;
  }

  return activeTypes;
}
