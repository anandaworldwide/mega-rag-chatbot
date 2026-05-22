export class SseLineBuffer {
  private buffer = "";

  append(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines;
  }

  flush(): string[] {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining ? [remaining] : [];
  }
}

export function parseSseDataLine(line: string): unknown {
  return JSON.parse(line.slice(5));
}

export async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const decoder = new TextDecoder();
  const sseBuffer = new SseLineBuffer();

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      const chunk = decoder.decode(value, { stream: !done });
      for (const line of sseBuffer.append(chunk)) {
        onLine(line);
      }
    }
    if (done) {
      for (const line of sseBuffer.flush()) {
        onLine(line);
      }
      break;
    }
  }
}
