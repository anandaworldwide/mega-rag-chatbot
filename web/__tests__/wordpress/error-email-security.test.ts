/** @jest-environment node */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import vm from "vm";

const PLUGIN_DIR = path.resolve(__dirname, "../../../wordpress/plugins/ananda-ai-chatbot");
const PLUGIN_PHP = path.join(PLUGIN_DIR, "ai-chatbot.php");
const CHATBOT_JS = path.join(PLUGIN_DIR, "assets/js/chatbot.js");
const PHP_HELPERS = path.join(PLUGIN_DIR, "error-email-security.php");
const PHP_TEST = path.join(PLUGIN_DIR, "error-email-security.test.php");

function loadBuildErrorEmailPayload() {
  const code = fs.readFileSync(CHATBOT_JS, "utf8");
  const helper = code.slice(0, code.indexOf("function initChatbot()"));
  type ErrorEmailBuilder = (
    data: Record<string, string> | undefined,
    error: { message?: string; opsMessage?: string; stack?: string },
    errorType: string,
    userMessage: string,
    extras?: Record<string, unknown>
  ) => Record<string, string> | null;

  const context = {
    window: {} as { aichatbotBuildErrorEmailPayload?: ErrorEmailBuilder },
  };
  vm.createContext(context);
  vm.runInContext(helper, context);
  return context.window.aichatbotBuildErrorEmailPayload as ErrorEmailBuilder;
}

describe("WordPress error-email flood controls", () => {
  const php = fs.readFileSync(PLUGIN_PHP, "utf8");
  const js = fs.readFileSync(CHATBOT_JS, "utf8");

  it("verifies the AJAX nonce with check_ajax_referer before mail", () => {
    const handlerIndex = php.indexOf("function aichatbot_ajax_send_error_email()");
    const mailIndex = php.indexOf("wp_mail(", handlerIndex);
    const prefix = php.slice(handlerIndex, mailIndex);

    expect(handlerIndex).toBeGreaterThan(-1);
    expect(mailIndex).toBeGreaterThan(handlerIndex);
    expect(prefix).toMatch(/check_ajax_referer\s*\(\s*aichatbot_chat_nonce_action\s*\(\s*\)\s*,\s*'nonce'\s*\)/);
  });

  it("rate-limits error emails with a per-IP transient", () => {
    const handlerIndex = php.indexOf("function aichatbot_ajax_send_error_email()");
    const mailIndex = php.indexOf("wp_mail(", handlerIndex);
    const prefix = php.slice(handlerIndex, mailIndex);

    expect(prefix).toContain("aichatbot_allow_error_email_send");
    expect(prefix).toContain("rate_limited");
    expect(prefix).toContain("429");
    expect(php).toContain("get_transient");
    expect(php).toContain("set_transient");
    expect(fs.readFileSync(PHP_HELPERS, "utf8")).toContain("aichatbot_err_email_");
  });

  it("caps and sanitizes error-email fields before wp_mail", () => {
    const handlerIndex = php.indexOf("function aichatbot_ajax_send_error_email()");
    const mailIndex = php.indexOf("wp_mail(", handlerIndex);
    const prefix = php.slice(handlerIndex, mailIndex);

    expect(prefix).toContain("aichatbot_sanitize_error_email_fields");
    expect(php).toContain("aichatbot_cap_text");
    expect(php).toContain("aichatbot_error_email_body_max_length");
    expect(fs.readFileSync(PHP_HELPERS, "utf8")).toContain("'error_stack' => 2000");
  });

  it("sends the localized nonce from the JS caller", () => {
    const build = loadBuildErrorEmailPayload();
    const payload = build(
      { ajaxUrl: "https://example.com/wp-admin/admin-ajax.php", nonce: "wp-nonce-1" },
      { message: "boom", stack: "trace" },
      "API Error",
      "user question",
      { userAgent: "Test", currentUrl: "https://example.com/", chatHistoryCount: 2 }
    );

    expect(payload).not.toBeNull();
    expect(payload?.action).toBe("aichatbot_send_error_email");
    expect(payload?.nonce).toBe("wp-nonce-1");
    expect(js).toContain("buildErrorEmailPayload");
    expect(js).toContain('credentials: "same-origin"');
  });

  it("does not send an error email when the nonce is missing", () => {
    const build = loadBuildErrorEmailPayload();
    expect(build({ ajaxUrl: "https://example.com/wp-admin/admin-ajax.php" }, { message: "x" }, "x", "y")).toBeNull();
    expect(build(undefined, { message: "x" }, "x", "y")).toBeNull();
  });

  it("passes PHP helper regressions for cap and rate-limit math", () => {
    const result = spawnSync("php", [PHP_TEST], { encoding: "utf8" });
    const missingPhp =
      result.status === 127 ||
      (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT");
    if (missingPhp) {
      // PHP is not on this runner; source contracts above still cover the handler.
      expect(fs.existsSync(PHP_TEST)).toBe(true);
      return;
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });
});
