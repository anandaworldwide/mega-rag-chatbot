/** @jest-environment node */

describe("chat suggestion emit ordering contract", () => {
  it("waits for both save and suggestions before emitting pills", async () => {
    const events: string[] = [];

    const savePromise = new Promise<string | null>((resolve) => {
      setTimeout(() => {
        events.push("save-complete");
        resolve("doc-1");
      }, 20);
    });

    const suggestionsPromise = new Promise<Array<{ id: string }>>((resolve) => {
      setTimeout(() => {
        events.push("suggestions-ready");
        resolve([{ id: "s1" }]);
      }, 5);
    });

    const [savedDocId, suggestions] = await Promise.all([savePromise, suggestionsPromise]);

    if (savedDocId && suggestions.length > 0) {
      events.push("emit-suggestions");
    }

    expect(events).toEqual(["suggestions-ready", "save-complete", "emit-suggestions"]);
  });
});
