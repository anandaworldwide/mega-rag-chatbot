/**
 * Streaming test utilities
 *
 * This file contains utilities for testing streaming functionality in the chat API.
 * It uses a Stream Consumer Pattern to read and verify stream data without modifying
 * the ReadableStream implementation, avoiding circular references.
 *
 * Note: This file is NOT a test file, despite being in the __tests__ directory.
 * It provides utility functions for the actual test files.
 */

import { ReadableStream } from 'stream/web';

/**
 * Represents a parsed SSE event from the stream
 */
export interface ParsedStreamEvent {
  type: string;
  data: Record<string, unknown>;
  raw: string;
}

/**
 * Consumes a ReadableStream and collects all chunks as strings
 *
 * @param stream The ReadableStream to consume
 * @returns A promise that resolves to an array of string chunks
 */
export async function collectStreamChunks(
  stream: ReadableStream<Uint8Array>,
): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}

/**
 * Parses SSE format data from stream chunks into structured events
 *
 * @param chunks Array of string chunks from the stream
 * @returns Array of parsed stream events
 */
export function parseStreamEvents(chunks: string[]): ParsedStreamEvent[] {
  const events: ParsedStreamEvent[] = [];

  for (const chunk of chunks) {
    // SSE format is "data: {...}\n\n"
    const lines = chunk.split('\n\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const jsonStr = line.replace('data: ', '');
          const data = JSON.parse(jsonStr);

          // Determine the event type based on the data
          let type = 'unknown';
          if (data.token) type = 'token';
          else if (data.done) type = 'done';
          else if (data.docId) type = 'docId';
          else if (data.sourceDocs) type = 'sourceDocs';
          else if (data.error) type = 'error';

          events.push({
            type,
            data,
            raw: jsonStr,
          });
        } catch {
          // If we can't parse the JSON, add it as a raw event
          events.push({
            type: 'unparseable',
            data: { raw: line },
            raw: line,
          });
        }
      }
    }
  }

  return events;
}

/**
 * Consumes a stream and returns parsed events
 *
 * @param stream The ReadableStream to consume
 * @returns A promise that resolves to an array of parsed stream events
 */
export async function consumeStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ParsedStreamEvent[]> {
  const chunks = await collectStreamChunks(stream);
  return parseStreamEvents(chunks);
}

/**
 * Creates a mock response object with a stream body
 *
 * @param status HTTP status code
 * @param headers Response headers
 * @returns A Response object with the given status and headers
 */
export function createMockStreamResponse(
  status = 200,
  headers = { 'content-type': 'text/event-stream' },
): Response {
  // Use a more compatible approach to create the response
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // This is just a placeholder stream that will be replaced in tests
      controller.close();
    },
  });

  // Response accepts BodyInit; cast through BodyInit to keep type safety and avoid `any`.
  return new Response(stream as unknown as BodyInit, { status, headers });
}
