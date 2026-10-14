<?php

/**
 * Regression: aichatbot_ajax_get_token requires a valid WP nonce.
 */
class AjaxGetTokenNonceTest extends PluginTestCase {
    public function test_missing_nonce_returns_403_and_does_not_fetch_token() {
        unset($_REQUEST['nonce'], $_POST['nonce'], $_GET['nonce']);

        $response = $this->captureJson('aichatbot_ajax_get_token');

        $this->assertSame(403, $response->status);
        $this->assertSame('invalid_nonce', $response->code());
        $this->assertSame(0, $GLOBALS['ananda_get_api_token_calls']);
    }

    public function test_wrong_nonce_returns_403_and_does_not_fetch_token() {
        $_REQUEST['nonce'] = 'definitely-not-the-nonce';

        $response = $this->captureJson('aichatbot_ajax_get_token');

        $this->assertSame(403, $response->status);
        $this->assertSame('invalid_nonce', $response->code());
        $this->assertSame(0, $GLOBALS['ananda_get_api_token_calls']);
    }

    public function test_valid_nonce_from_wp_create_nonce_succeeds() {
        $_REQUEST['nonce'] = wp_create_nonce('aichatbot_get_token');

        $response = $this->captureJson('aichatbot_ajax_get_token');

        $this->assertSame('success', $response->kind);
        $this->assertSame(200, $response->status);
        $this->assertSame(1, $GLOBALS['ananda_get_api_token_calls']);
        $this->assertSame(
            'header.payload.signature',
            is_array($response->payload) ? $response->payload['token'] : null
        );
    }

    public function test_wp_localize_script_aichatbot_data_includes_nonce() {
        $this->assertSame('aichatbot_get_token', aichatbot_chat_nonce_action());

        if (!function_exists('aichatbot_is_search_page')) {
            aichatbot_enqueue_assets();
        } else {
            $data = aichatbot_frontend_script_data('https://example.com', 16, 560, 600, '/chat', false, '');
            wp_localize_script('aichatbot-auth', 'aichatbotData', $data);
        }

        $this->assertNotEmpty($this->localizedScripts);
        $found = false;
        foreach ($this->localizedScripts as $localized) {
            $this->assertSame('aichatbotData', $localized['object_name']);
            $this->assertArrayHasKey('nonce', $localized['data']);
            $this->assertSame(
                wp_create_nonce('aichatbot_get_token'),
                $localized['data']['nonce']
            );
            $found = true;
        }
        $this->assertTrue($found);
    }
}
