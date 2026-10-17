/**
 * Read the CSP nonce forwarded by middleware on x-nonce.
 */
export function readBrowserCspNonce(): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  return document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") || undefined;
}

export function getRequestNonce(
  headers: { get?(name: string): string | null } | Record<string, string | string[] | undefined> | undefined
): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === "function") {
    return headers.get("x-nonce") || undefined;
  }
  const value = (headers as Record<string, string | string[] | undefined>)["x-nonce"];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
