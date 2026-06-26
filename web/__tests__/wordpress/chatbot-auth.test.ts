/** @jest-environment node */
import fs from "fs";
import path from "path";
import vm from "vm";

const SCRIPT_PATH = path.resolve(
  __dirname,
  "../../../wordpress/plugins/ananda-ai-chatbot/assets/js/chatbot-auth.js"
);

type ChatbotAuthTesting = {
  isRetryableNetworkError: (error: unknown) => boolean;
  isPostRetryAllowed: (method: string | undefined, idempotencyKey: unknown) => boolean;
  retryOnNetworkError: <T>(fn: () => Promise<T>, maxRetries?: number, baseDelay?: number) => Promise<T>;
};

type ChatbotAuthContext = {
  window: {
    location: { search: string };
    aichatbotAuth: {
      fetchWithAuth: (url: string, options?: Record<string, unknown>) => Promise<Response>;
      __testing__: ChatbotAuthTesting;
    };
  };
  fetch: jest.Mock;
  aichatbotData: { ajaxUrl: string };
  document?: { body: { appendChild: jest.Mock } };
};

function loadChatbotAuth(): ChatbotAuthContext {
  const code = fs.readFileSync(SCRIPT_PATH, "utf8");
  const fetch = jest.fn();
  const context: ChatbotAuthContext & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    Promise: PromiseConstructor;
    atob: (value: string) => string;
  } = {
    window: {
      location: { search: "" },
    } as ChatbotAuthContext["window"],
    fetch,
    aichatbotData: { ajaxUrl: "https://example.com/wp-admin/admin-ajax.php" },
    document: { body: { appendChild: jest.fn() } },
    setTimeout,
    clearTimeout,
    Promise,
    atob: (value: string) => Buffer.from(value, "base64url").toString("utf8"),
  };

  vm.createContext(context as unknown as vm.Context);
  vm.runInContext(code, context as unknown as vm.Context);
  return context;
}

function mockValidTokenFetch(fetch: jest.Mock) {
  const exp = Math.floor(Date.now() / 1000) + 900;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const token = `header.${payload}.signature`;

  fetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      JSON.stringify({
        success: true,
        data: { token },
      }),
  });
}

describe("chatbot-auth.js", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("detects retryable browser network errors narrowly", () => {
    const { window } = loadChatbotAuth();
    const { isRetryableNetworkError } = window.aichatbotAuth.__testing__;

    expect(isRetryableNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableNetworkError(Object.assign(new TypeError("x"), { name: "AbortError" }))).toBe(false);
    expect(isRetryableNetworkError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isRetryableNetworkError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
  });

  it("allows POST retries only when an idempotency key is provided", () => {
    const { window } = loadChatbotAuth();
    const { isPostRetryAllowed } = window.aichatbotAuth.__testing__;

    expect(isPostRetryAllowed("GET")).toBe(true);
    expect(isPostRetryAllowed("POST")).toBe(false);
    expect(isPostRetryAllowed("POST", "423e4567-e89b-42d3-a456-426614174000")).toBe(true);
  });

  it("retries chat POST requests when idempotencyKey is supplied", async () => {
    const context = loadChatbotAuth();
    mockValidTokenFetch(context.fetch);

    context.fetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = context.window.aichatbotAuth.fetchWithAuth("https://vivek.ananda.org/api/chat/v1", {
      method: "POST",
      idempotencyKey: "423e4567-e89b-42d3-a456-426614174000",
      body: JSON.stringify({ clientRequestId: "423e4567-e89b-42d3-a456-426614174000" }),
    });

    await jest.runAllTimersAsync();
    const response = await promise;

    expect(response.ok).toBe(true);
    expect(context.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry POST requests without an idempotency key", async () => {
    const context = loadChatbotAuth();
    mockValidTokenFetch(context.fetch);
    context.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(
      context.window.aichatbotAuth.fetchWithAuth("https://vivek.ananda.org/api/vote", {
        method: "POST",
        body: JSON.stringify({ docId: "abc", vote: 1 }),
      })
    ).rejects.toThrow("Failed to fetch");

    expect(context.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry AbortError", async () => {
    const context = loadChatbotAuth();
    mockValidTokenFetch(context.fetch);

    const abortError = new TypeError("The user aborted a request.");
    abortError.name = "AbortError";

    context.fetch.mockRejectedValueOnce(abortError);

    await expect(
      context.window.aichatbotAuth.fetchWithAuth("https://vivek.ananda.org/api/chat/v1", {
        method: "POST",
        idempotencyKey: "423e4567-e89b-42d3-a456-426614174000",
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(context.fetch).toHaveBeenCalledTimes(2);
  });
});
