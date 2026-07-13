export const TOKEN_SERVICE_UNAVAILABLE_CODE = "TOKEN_SERVICE_UNAVAILABLE";
export const TOKEN_SERVICE_UNAVAILABLE_USER_MESSAGE =
  "The chatbot authentication service is temporarily unavailable. Please try again in a few minutes. If this continues, contact support.";

export function isModuleInteropError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ERR_REQUIRE_ESM" ||
    error.message.includes("ERR_REQUIRE_ESM") ||
    error.message.includes("require() of ES Module")
  );
}

export function buildTokenServiceFailureResponse(error: unknown): {
  status: number;
  body: { error: string; code: string };
} {
  return {
    status: isModuleInteropError(error) ? 503 : 500,
    body: {
      error: TOKEN_SERVICE_UNAVAILABLE_USER_MESSAGE,
      code: TOKEN_SERVICE_UNAVAILABLE_CODE,
    },
  };
}
