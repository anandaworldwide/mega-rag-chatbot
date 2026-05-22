/** @jest-environment node */
import { parseSseDataLine, SseLineBuffer } from "@/utils/client/sseLineBuffer";

describe("SseLineBuffer", () => {
  it("reassembles a data line split across chunks", () => {
    const buffer = new SseLineBuffer();
    const payload = JSON.stringify({ sourceDocs: [{ id: "a".repeat(2000) }] });
    const line = `data: ${payload}`;
    const splitAt = 1200;

    const first = buffer.append(line.slice(0, splitAt));
    expect(first).toHaveLength(0);

    const second = buffer.append(line.slice(splitAt) + "\n");
    expect(second).toHaveLength(1);
    expect(parseSseDataLine(second[0])).toEqual(JSON.parse(payload));
  });

  it("flush returns a trailing partial line", () => {
    const buffer = new SseLineBuffer();
    buffer.append("data: {\"done\":true}");
    expect(buffer.flush()).toEqual(['data: {"done":true}']);
  });
});
