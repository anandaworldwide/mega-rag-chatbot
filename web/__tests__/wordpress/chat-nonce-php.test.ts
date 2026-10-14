/** @jest-environment node */
import fs from "fs";
import path from "path";

const PLUGIN_PHP = path.resolve(__dirname, "../../../wordpress/plugins/ananda-ai-chatbot/ai-chatbot.php");

describe("WordPress chatbot nonce (PHP)", () => {
  const source = fs.readFileSync(PLUGIN_PHP, "utf8");

  it("creates and verifies the same nonce action on the chat token path", () => {
    expect(source).toContain("function aichatbot_chat_nonce_action()");
    expect(source).toContain("return 'aichatbot_get_token'");
    expect(source).toMatch(/wp_create_nonce\s*\(\s*aichatbot_chat_nonce_action\s*\(\s*\)\s*\)/);
    expect(source).toMatch(/wp_verify_nonce\s*\(\s*\$value\s*,\s*aichatbot_chat_nonce_action\s*\(\s*\)\s*\)/);
  });

  it("rejects the token handler when the nonce is missing or invalid", () => {
    const handlerIndex = source.indexOf("function aichatbot_ajax_get_token()");
    const tokenFetchIndex = source.indexOf("ananda_get_api_token()", handlerIndex);

    expect(handlerIndex).toBeGreaterThan(-1);
    expect(tokenFetchIndex).toBeGreaterThan(handlerIndex);

    const handlerPrefix = source.slice(handlerIndex, tokenFetchIndex);
    expect(handlerPrefix).toContain("aichatbot_verify_chat_request_nonce");
    expect(handlerPrefix).toContain("invalid_nonce");
    expect(handlerPrefix).toContain("403");
  });

  it("does not leave the old nonce TODO comment on the chat request path", () => {
    expect(source).not.toContain("Security check with nonce would typically go here");
  });
});
