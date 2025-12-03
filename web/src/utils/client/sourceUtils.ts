/**
 * Utility functions for generating stable source identifiers
 * Used for deep linking to specific sources in shared conversations
 */

import { Document } from "langchain/document";
import { DocMetadata } from "@/types/DocMetadata";

/**
 * Generates a stable, unique identifier for a source document
 * This ID is used in URL hash fragments for deep linking
 *
 * For audio sources: Uses file_hash if available, otherwise filename + start_time
 * For YouTube sources: Uses URL hash (video ID + start_time)
 * For text sources: Uses a combination of title + library + source URL hash
 *
 * @param doc - The document to generate an ID for
 * @returns A stable identifier string (e.g., "source-abc123def")
 */
export function generateSourceId(doc: Document<DocMetadata>): string {
  const metadata = doc.metadata;

  // Audio sources: prefer file_hash, fallback to filename + start_time
  if (metadata.type === "audio") {
    if (metadata.file_hash) {
      return `source-audio-${metadata.file_hash}`;
    }
    if (metadata.filename && metadata.start_time !== undefined) {
      // Create a simple hash from filename + start_time
      const hashInput = `${metadata.filename}-${metadata.start_time}`;
      return `source-audio-${hashInput.replace(/[^a-zA-Z0-9]/g, "-")}`;
    }
    if (metadata.filename) {
      return `source-audio-${metadata.filename.replace(/[^a-zA-Z0-9]/g, "-")}`;
    }
  }

  // YouTube sources: use URL + start_time
  if (metadata.type === "youtube" && metadata.url) {
    try {
      const urlObj = new URL(metadata.url);
      let videoId = "";
      if (urlObj.hostname === "youtu.be") {
        videoId = urlObj.pathname.slice(1);
      } else if (urlObj.hostname === "www.youtube.com" && urlObj.pathname.includes("watch")) {
        videoId = urlObj.searchParams.get("v") || "";
      }
      if (videoId) {
        const startTime = metadata.start_time ? `-${Math.floor(metadata.start_time)}` : "";
        return `source-youtube-${videoId}${startTime}`;
      }
    } catch (e) {
      // Invalid URL, fall through to generic ID
    }
  }

  // Text sources: use title + library + source URL hash
  if (metadata.type === "text" || !metadata.type) {
    const title = metadata.title || metadata["pdf.info.Title"] || "unknown";
    const library = metadata.library || "default";
    const source = metadata.source || "";
    
    // Create a simple hash from title + library + source
    const hashInput = `${title}-${library}-${source}`;
    // Remove special characters and limit length
    const cleanHash = hashInput
      .replace(/[^a-zA-Z0-9]/g, "-")
      .substring(0, 50)
      .toLowerCase();
    
    return `source-text-${cleanHash}`;
  }

  // Fallback: use title + type
  const title = metadata.title || metadata["pdf.info.Title"] || "unknown";
  const cleanTitle = title.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30).toLowerCase();
  return `source-${metadata.type || "unknown"}-${cleanTitle}`;
}

/**
 * Generates a deep link URL for a source within a shared conversation
 *
 * @param docId - The document/conversation ID
 * @param sourceDoc - The source document to link to
 * @returns A full URL with hash fragment (e.g., "https://example.com/share/abc123#source-audio-xyz")
 */
export function generateSourceDeepLink(docId: string, sourceDoc: Document<DocMetadata>): string {
  const sourceId = generateSourceId(sourceDoc);
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  return `${baseUrl}/share/${docId}#${sourceId}`;
}

