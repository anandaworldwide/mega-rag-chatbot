import { getToken } from "./tokenManager";
import { getOrCreateUUID } from "./uuid";

interface AudioUrlResponse {
  signedUrl: string;
  contentType: string;
  expiresIn: number;
}

interface AudioUrlError {
  message: string;
  validExtensions?: string[];
  actualType?: string;
}

/**
 * Securely fetches a signed URL for an audio file through the API
 * This replaces the direct S3 URL construction with proper server-side validation
 *
 * @param filename - The audio filename (e.g., "meditation.mp3")
 * @param library - Optional library/collection name for path resolution
 * @returns Promise<string> - The secure signed URL for the audio file
 * @throws Error if the audio file cannot be accessed or is invalid
 */
export async function getSecureAudioUrl(filename: string, library?: string, docId?: string): Promise<string> {
  try {
    // Get JWT token for authentication
    const token = await getToken();
    const uuid = getOrCreateUUID();

    // Prepare request body based on authentication status
    const requestBody: any = {
      audioS3Key: filename,
      library,
    };

    // For authenticated users, include UUID
    if (token && !token.includes("placeholder")) {
      requestBody.uuid = uuid;
    } else if (docId) {
      // For anonymous users, include docId for share validation
      requestBody.docId = docId;
    }

    // Make request to secure audio endpoint
    const response = await fetch("/api/getAudioSignedUrl", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token && !token.includes("placeholder") ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      // Handle different error types
      const errorData: AudioUrlError = await response.json();

      switch (response.status) {
        case 400:
          throw new Error(`Invalid audio file: ${errorData.message}`);
        case 401:
          throw new Error("Authentication required for audio access");
        case 403:
          throw new Error("Access denied to audio file");
        case 404:
          throw new Error("Audio file not found");
        case 429: {
          const retryAfterHeader = response.headers.get("Retry-After");
          const error = new Error("Too many requests, wait a moment") as Error & {
            status?: number;
            retryAfterMs?: number;
          };
          error.status = 429;
          if (retryAfterHeader) {
            const seconds = Number(retryAfterHeader);
            if (Number.isFinite(seconds) && seconds >= 0) {
              error.retryAfterMs = seconds * 1000;
            }
          }
          throw error;
        }
        default:
          throw new Error(`Failed to access audio file: ${errorData.message}`);
      }
    }

    const data: AudioUrlResponse = await response.json();
    return data.signedUrl;
  } catch (error) {
    console.error("Error fetching secure audio URL:", error);

    // Re-throw with more context
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error("Failed to access audio file");
    }
  }
}

/**
 * Cache for storing audio URLs to avoid repeated API calls
 * URLs are cached with expiration time to respect signed URL validity
 */
interface CachedAudioUrl {
  url: string;
  expiresAt: number;
  missing?: boolean;
}

const audioUrlCache = new Map<string, CachedAudioUrl>();
const NOT_FOUND_CACHE_MS = 60 * 1000;

/**
 * Gets a secure audio URL with caching to improve performance
 *
 * @param filename - The audio filename
 * @param library - Optional library name
 * @returns Promise<string> - The secure signed URL
 */
export async function getCachedSecureAudioUrl(filename: string, library?: string, docId?: string): Promise<string> {
  const cacheKey = `${library || "default"}:${filename}`;
  const cached = audioUrlCache.get(cacheKey);

  // Keep a 404 result for 60 seconds so other players do not call the API again.
  if (cached?.missing && cached.expiresAt > Date.now()) {
    throw new Error("Audio file not found");
  }

  // Check if we have a valid cached URL (with 30 minute buffer before expiration)
  if (cached && !cached.missing && cached.expiresAt > Date.now() + 30 * 60 * 1000) {
    return cached.url;
  }

  try {
    const url = await getSecureAudioUrl(filename, library, docId);

    // Cache for 3.5 hours (30 minutes before the 4-hour expiration)
    audioUrlCache.set(cacheKey, {
      url,
      expiresAt: Date.now() + 3.5 * 60 * 60 * 1000,
    });

    return url;
  } catch (error) {
    if (error instanceof Error && error.message === "Audio file not found") {
      audioUrlCache.set(cacheKey, {
        url: "",
        expiresAt: Date.now() + NOT_FOUND_CACHE_MS,
        missing: true,
      });
    }
    throw error;
  }
}

/**
 * Clears the audio URL cache (useful for logout or cache invalidation)
 */
export function clearAudioUrlCache(): void {
  audioUrlCache.clear();
}
