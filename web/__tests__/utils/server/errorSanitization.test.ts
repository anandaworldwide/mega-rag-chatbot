/** @jest-environment node */

import {
  classifyLlmProviderChatFailure,
  CHATBOT_UNAVAILABLE_USER_MESSAGE,
  containsSensitiveInfo,
  getSafeErrorMessage,
  inferLlmProviderFromError,
  isLlmProviderAuthError,
  isLlmProviderCapacityError,
  isLlmProviderQuotaError,
  isLlmProviderRateLimitError,
  LLM_CAPACITY_USER_MESSAGE,
  sanitizeErrorForLogging,
  sanitizeErrorMessage,
} from "@/utils/server/errorSanitization";
import { isDevelopment } from "@/utils/env";

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn(() => false),
}));

const mockIsDevelopment = isDevelopment as jest.MockedFunction<typeof isDevelopment>;

describe("errorSanitization LLM provider auth errors", () => {
  test("detects xAI incorrect API key 400", () => {
    const error = new Error('400 "Incorrect API key provided. You can obtain an API key from https://console.x.ai."');
    expect(isLlmProviderAuthError(error)).toBe(true);
    expect(inferLlmProviderFromError(error)).toBe("xAI (Grok)");
  });

  test("detects missing XAI_API_KEY configuration", () => {
    const error = new Error("XAI_API_KEY is required for Grok models but is not set");
    expect(isLlmProviderAuthError(error)).toBe(true);
    expect(inferLlmProviderFromError(error)).toBe("xAI (Grok)");
  });

  test("detects OpenAI invalid_api_key", () => {
    const error = new Error("OpenAI 401 Incorrect API key provided: invalid_api_key");
    expect(isLlmProviderAuthError(error)).toBe(true);
    expect(inferLlmProviderFromError(error)).toBe("OpenAI");
  });

  test("does not treat unrelated errors as auth failures", () => {
    expect(isLlmProviderAuthError(new Error("Pinecone index not found"))).toBe(false);
    expect(isLlmProviderAuthError(new Error("Network timeout"))).toBe(false);
    expect(isLlmProviderAuthError(new Error("authentication_error: session expired"))).toBe(false);
  });

  test("detects Anthropic authentication_error only with API-key cue", () => {
    expect(isLlmProviderAuthError(new Error("authentication_error: invalid x-api-key"))).toBe(true);
    expect(isLlmProviderAuthError(new Error("Anthropic authentication_error"))).toBe(true);
  });

  test("getSafeErrorMessage never returns raw API key errors", () => {
    const error = new Error('400 "Incorrect API key provided. You can obtain an API key from https://console.x.ai."');
    expect(getSafeErrorMessage(error)).toBe(CHATBOT_UNAVAILABLE_USER_MESSAGE);
  });
});

describe("errorSanitization LLM provider quota errors", () => {
  test("detects xAI credits / spending limit 403", () => {
    const error = new Error(
      '403 "Your team 9bd216ec-d39a-4422-81a3-5a0f430a2d56 has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."'
    );
    expect(isLlmProviderQuotaError(error)).toBe(true);
    expect(isLlmProviderAuthError(error)).toBe(false);
    expect(inferLlmProviderFromError(error)).toBe("xAI (Grok)");
  });

  test("getSafeErrorMessage never returns raw quota / team id errors", () => {
    const error = new Error(
      '403 "Your team 9bd216ec-d39a-4422-81a3-5a0f430a2d56 has either used all available credits or reached its monthly spending limit."'
    );
    expect(getSafeErrorMessage(error)).toBe(CHATBOT_UNAVAILABLE_USER_MESSAGE);
  });

  test("does not treat unrelated 403s as quota failures", () => {
    expect(isLlmProviderQuotaError(new Error('403 "Forbidden"'))).toBe(false);
  });

  test("detects rate limit / 429 as rate-limit class", () => {
    expect(isLlmProviderRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isLlmProviderRateLimitError(new Error("OpenAI rate_limit exceeded"))).toBe(true);
  });
});

describe("isLlmProviderCapacityError", () => {
  test("matches resource-exhausted code with no HTTP status", () => {
    const error = Object.assign(new Error("provider busy"), { code: "resource-exhausted" });
    expect(isLlmProviderCapacityError(error)).toBe(true);
    expect((error as { status?: number }).status).toBeUndefined();
  });

  test("matches nested xAI SSE payload with server_error and capacity text", () => {
    const error = Object.assign(new Error("The model is currently at capacity due to high demand"), {
      error: { code: "resource-exhausted", type: "server_error" },
    });
    expect(isLlmProviderCapacityError(error)).toBe(true);
  });

  test("matches at capacity / high demand text", () => {
    expect(isLlmProviderCapacityError(new Error("The model is currently at capacity"))).toBe(true);
    expect(isLlmProviderCapacityError(new Error("Unavailable due to high demand"))).toBe(true);
  });

  test("matches HTTP 503 and 529", () => {
    const unavailable = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const overloaded = Object.assign(new Error("Overloaded"), { status: 529 });
    expect(isLlmProviderCapacityError(unavailable)).toBe(true);
    expect(isLlmProviderCapacityError(overloaded)).toBe(true);
  });

  test("does not treat auth or quota errors as capacity", () => {
    expect(isLlmProviderCapacityError(new Error('400 "Incorrect API key provided."'))).toBe(false);
    expect(
      isLlmProviderCapacityError(
        new Error("Your team 9bd216ec-d39a-4422-81a3-5a0f430a2d56 has used all available credits")
      )
    ).toBe(false);
  });
});

describe("classifyLlmProviderChatFailure", () => {
  test("classifies auth failures with generic user message and ops plan", () => {
    const error = new Error('400 "Incorrect API key provided. You can obtain an API key from https://console.x.ai."');
    const plan = classifyLlmProviderChatFailure(error);
    expect(plan).toEqual(
      expect.objectContaining({
        kind: "auth",
        userMessage: CHATBOT_UNAVAILABLE_USER_MESSAGE,
        provider: "xAI (Grok)",
        errorType: "llm_provider_auth_failure",
        throttleKey: "llm_provider_auth_failure",
      })
    );
    expect(plan?.opsSubject).toContain("API Key");
    expect(plan?.opsBody).toContain("console.x.ai");
  });

  test("classifies quota failures before bare messaging leaks", () => {
    const error = new Error(
      '403 "Your team 9bd216ec-d39a-4422-81a3-5a0f430a2d56 has either used all available credits or reached its monthly spending limit."'
    );
    const plan = classifyLlmProviderChatFailure(error);
    expect(plan).toEqual(
      expect.objectContaining({
        kind: "quota",
        userMessage: CHATBOT_UNAVAILABLE_USER_MESSAGE,
        provider: "xAI (Grok)",
        errorType: "llm_provider_quota_failure",
        throttleKey: "llm_provider_quota_failure",
      })
    );
  });

  test("classifies 429 as quota/rate-limit with generic user message", () => {
    const plan = classifyLlmProviderChatFailure(new Error("429 rate_limit exceeded"));
    expect(plan).toEqual(
      expect.objectContaining({
        kind: "quota",
        userMessage: CHATBOT_UNAVAILABLE_USER_MESSAGE,
        errorType: "llm_provider_quota_failure",
      })
    );
  });

  test("returns null for unrelated errors", () => {
    expect(classifyLlmProviderChatFailure(new Error("Pinecone timeout"))).toBeNull();
  });

  test("classifies resource-exhausted with no status as capacity", () => {
    const error = Object.assign(new Error("busy"), { code: "resource-exhausted" });
    const plan = classifyLlmProviderChatFailure(error);
    expect(plan).toEqual(
      expect.objectContaining({
        kind: "capacity",
        userMessage: LLM_CAPACITY_USER_MESSAGE,
        errorType: "llm_capacity",
      })
    );
  });

  test("classifies 503 capacity separately from auth and quota", () => {
    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(classifyLlmProviderChatFailure(error)?.kind).toBe("capacity");
    expect(classifyLlmProviderChatFailure(new Error('400 "Incorrect API key provided."'))?.kind).toBe("auth");
    expect(
      classifyLlmProviderChatFailure(
        new Error("Your team 9bd216ec-d39a-4422-81a3-5a0f430a2d56 has used all available credits")
      )?.kind
    ).toBe("quota");
  });
});

describe("getSafeErrorMessage production provider text", () => {
  beforeEach(() => {
    mockIsDevelopment.mockReturnValue(false);
  });

  test("returns the busy message for capacity errors", () => {
    const error = Object.assign(new Error("The model is currently at capacity due to high demand"), {
      code: "resource-exhausted",
    });
    expect(getSafeErrorMessage(error)).toBe(LLM_CAPACITY_USER_MESSAGE);
    expect(getSafeErrorMessage(error)).not.toContain("high demand");
  });

  test("does not return raw unknown provider text in production", () => {
    const error = Object.assign(new Error("xAI mystery failure xyz-secret-trace"), {
      type: "server_error",
      status: 500,
    });
    const safe = getSafeErrorMessage(error, "An error occurred. Please try again later.");
    expect(safe).toBe("An error occurred. Please try again later.");
    expect(safe).not.toContain("mystery");
    expect(safe).not.toContain("xyz-secret-trace");
  });
});

describe("sanitizeErrorMessage / containsSensitiveInfo", () => {
  test("redacts API keys, JWTs, Mongo URIs, and AWS access keys", () => {
    const message =
      "fail sk-abcdefghijklmnopqrstuvwxyz0123456789 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig mongodb://user:pass@host/db AKIAIOSFODNN7EXAMPLE";
    const sanitized = sanitizeErrorMessage(message);
    expect(sanitized).not.toMatch(/sk-[a-zA-Z0-9]{32,}/);
    expect(sanitized).not.toContain("mongodb://user:pass@host/db");
    expect(sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sanitized).toMatch(/\[redacted\]|\[connection-string-redacted\]/);
  });

  test("containsSensitiveInfo is stable across repeated calls", () => {
    const message = "secret key sk-abcdefghijklmnopqrstuvwxyz0123456789 leaked";
    expect(containsSensitiveInfo(message)).toBe(true);
    expect(containsSensitiveInfo(message)).toBe(true);
    expect(containsSensitiveInfo("benign timeout")).toBe(false);
    expect(containsSensitiveInfo("benign timeout")).toBe(false);
  });

  test("sanitizeErrorForLogging strips sensitive values from Error and non-Error throwables", () => {
    const fromError = sanitizeErrorForLogging(
      new Error("OpenAI key sk-abcdefghijklmnopqrstuvwxyz0123456789 failed")
    );
    expect(fromError.message).not.toMatch(/sk-[a-zA-Z0-9]{32,}/);
    const fromString = sanitizeErrorForLogging("postgres://u:p@localhost/db boom");
    expect(fromString.message).toContain("[connection-string-redacted]");
  });
});
