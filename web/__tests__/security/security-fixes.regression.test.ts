/**
 * Per-fix regression list for PR security remediations.
 * Each block fails if that fix is reverted.
 */
import fs from "fs";
import path from "path";
import {
  isSensitiveFilePath,
  isStaticAsset,
  isStaticAssetPath,
  buildContentSecurityPolicy,
  SENSITIVE_FILE_MARKERS,
  sensitiveFiles,
} from "../../src/proxy";
import { getRequestNonce } from "@/utils/server/cspNonce";
import { nonceFromDocumentContext } from "@/pages/_document";
import { isPlaceholderToken } from "@/utils/client/tokenManager";

const ROOT = path.resolve(__dirname, "../../..");
const PLUGIN_PHP = path.join(ROOT, "wordpress/plugins/ananda-ai-chatbot/ai-chatbot.php");
const CHATBOT_AUTH_JS = path.join(ROOT, "wordpress/plugins/ananda-ai-chatbot/assets/js/chatbot-auth.js");
const CHATBOT_JS = path.join(ROOT, "wordpress/plugins/ananda-ai-chatbot/assets/js/chatbot.js");
const MIDDLEWARE = path.join(ROOT, "web/src/proxy.ts");
const DOCUMENT = path.join(ROOT, "web/src/pages/_document.tsx");
const TOKEN_MANAGER = path.join(ROOT, "web/src/utils/client/tokenManager.ts");
const AUTH_GUARD = path.join(ROOT, "web/src/components/AuthGuard.tsx");

describe("security fix regression list", () => {
  describe("1. WordPress chat nonce", () => {
    it("creates, sends, and verifies the same nonce on the token path", () => {
      const php = fs.readFileSync(PLUGIN_PHP, "utf8");
      const js = fs.readFileSync(CHATBOT_AUTH_JS, "utf8");
      expect(php).toMatch(/wp_create_nonce\s*\(\s*aichatbot_chat_nonce_action\s*\(\s*\)\s*\)/);
      expect(php).toContain("aichatbot_verify_chat_request_nonce");
      expect(php).toContain("invalid_nonce");
      expect(js).toContain("buildChatTokenUrl");
      expect(js).toContain("encodeURIComponent(nonce)");
    });
  });

  describe("2. Middleware sensitive files and fail-closed config", () => {
    it("blocks secret paths and fails closed when site config is missing", () => {
      const source = fs.readFileSync(MIDDLEWARE, "utf8");
      expect(sensitiveFiles.length).toBeGreaterThan(0);
      expect(SENSITIVE_FILE_MARKERS).toEqual(expect.arrayContaining([".env", ".git", "secrets.json"]));
      expect(isSensitiveFilePath("/.env.production")).toBe(true);
      expect(isSensitiveFilePath("/answers")).toBe(false);
      expect(isSensitiveFilePath("/x.envelope")).toBe(false);
      expect(isSensitiveFilePath("/.github")).toBe(false);
      expect(source).toContain("status: 503");
      expect(source).toContain("Site configuration unavailable");
      expect(source).not.toMatch(/sensitiveFiles:\s*string\[\]\s*=\s*\[\]/);
    });
  });

  describe("3. CSP nonce wiring", () => {
    it("puts the nonce in CSP and on document script tags", () => {
      const documentSource = fs.readFileSync(DOCUMENT, "utf8");
      const csp = buildContentSecurityPolicy("regression-nonce");
      expect(csp).toContain("'nonce-regression-nonce'");
      expect(getRequestNonce({ "x-nonce": "regression-nonce" })).toBe("regression-nonce");
      expect(nonceFromDocumentContext({ req: { headers: { "x-nonce": "regression-nonce" } } })).toBe("regression-nonce");
      expect(documentSource).toContain("<NextScript nonce={nonce} />");
      expect(documentSource).toContain("<Head nonce={nonce}>");
    });
  });

  describe("4. Static-file regex", () => {
    it("matches a literal dot, not a backslash", () => {
      expect(isStaticAsset("/logo.png")).toBe(true);
      expect(isStaticAssetPath("/logo.png")).toBe(true);
      expect(isStaticAsset("/secret.png.html")).toBe(false);
      expect(isStaticAssetPath("/folder\\png")).toBe(false);
      expect(fs.readFileSync(MIDDLEWARE, "utf8")).not.toContain("/\\\\.(png|jpg");
    });
  });

  describe("5. AuthGuard placeholder tokens", () => {
    it("rejects leftover placeholder strings and no longer caches them", () => {
      const tokenSource = fs.readFileSync(TOKEN_MANAGER, "utf8");
      const guardSource = fs.readFileSync(AUTH_GUARD, "utf8");
      expect(isPlaceholderToken("login-page-placeholder")).toBe(true);
      expect(isPlaceholderToken("public-page-placeholder")).toBe(true);
      expect(isPlaceholderToken("")).toBe(false);
      expect(tokenSource).not.toContain('const placeholderToken = "login-page-placeholder"');
      expect(tokenSource).not.toContain('const placeholderToken = "public-page-placeholder"');
      expect(guardSource).toContain("isPlaceholderToken");
    });
  });

  describe("6. Error-email flood controls", () => {
    it("requires a nonce, a rate limit, and a size cap before wp_mail", () => {
      const php = fs.readFileSync(PLUGIN_PHP, "utf8");
      const js = fs.readFileSync(CHATBOT_JS, "utf8");
      const handler = php.slice(
        php.indexOf("function aichatbot_ajax_send_error_email()"),
        php.indexOf("wp_mail(", php.indexOf("function aichatbot_ajax_send_error_email()"))
      );
      expect(handler).toMatch(/check_ajax_referer\s*\(\s*aichatbot_chat_nonce_action\s*\(\s*\)\s*,\s*'nonce'\s*\)/);
      expect(handler).toContain("aichatbot_allow_error_email_send");
      expect(handler).toContain("aichatbot_sanitize_error_email_fields");
      expect(js).toContain("nonce: aichatbotData.nonce");
    });
  });

  describe("7. Next 16 proxy file convention", () => {
    it("keeps the request interceptor at src/proxy.ts with a named proxy export", () => {
      const proxyPath = path.join(ROOT, "web/src/proxy.ts");
      const staleRootMiddleware = path.join(ROOT, "web/middleware.ts");
      expect(fs.existsSync(proxyPath)).toBe(true);
      expect(fs.existsSync(staleRootMiddleware)).toBe(false);
      const source = fs.readFileSync(proxyPath, "utf8");
      expect(source).toMatch(/export function proxy\s*\(/);
      expect(source).toContain("export const config");
    });
  });
});
