<?php

/**
 * Regression: aichatbot_send_error_email nonce, rate limit, and field caps.
 */
class SendErrorEmailSecurityTest extends PluginTestCase {
    public function test_missing_nonce_returns_403_and_does_not_send_mail() {
        unset($_REQUEST['nonce'], $_POST['nonce']);

        $response = $this->captureJson('aichatbot_ajax_send_error_email');

        $this->assertSame(403, $response->status);
        $this->assertSame(0, $this->wpMailCalls);
    }

    public function test_over_rate_limit_returns_429_and_does_not_send_mail() {
        $nonce = wp_create_nonce('aichatbot_get_token');
        $_REQUEST['nonce'] = $nonce;
        $_POST['nonce'] = $nonce;
        $_POST['error_type'] = 'API Error';
        $_POST['error_message'] = 'boom';

        $key = aichatbot_error_email_rate_limit_key(aichatbot_error_email_client_ip());
        $this->transients[$key] = aichatbot_error_email_rate_limit_max();

        $response = $this->captureJson('aichatbot_ajax_send_error_email');

        $this->assertSame(429, $response->status);
        $this->assertSame('rate_limited', $response->code());
        $this->assertSame(0, $this->wpMailCalls);
    }

    public function test_field_length_caps_are_enforced() {
        $max = aichatbot_error_email_field_max_lengths();
        $this->assertSame(100, $max['error_type']);
        $this->assertSame(1000, $max['error_message']);
        $this->assertSame(2000, $max['error_stack']);
        $this->assertSame(500, $max['user_message']);
        $this->assertSame(300, $max['user_agent']);
        $this->assertSame(500, $max['current_url']);
        $this->assertSame(80, $max['timestamp']);
        $this->assertSame(4000, aichatbot_error_email_body_max_length());
        $this->assertSame(5, aichatbot_error_email_rate_limit_max());

        $capped = aichatbot_sanitize_error_email_fields(array(
            'error_type' => str_repeat('T', 250),
            'error_message' => str_repeat('M', 1500),
            'error_stack' => str_repeat('S', 3000),
            'user_message' => str_repeat('U', 800),
            'user_agent' => str_repeat('A', 400),
            'current_url' => 'https://example.com/' . str_repeat('p', 600),
            'timestamp' => str_repeat('0', 120),
        ));

        $this->assertSame(100, strlen($capped['error_type']));
        $this->assertSame(1000, strlen($capped['error_message']));
        $this->assertSame(2000, strlen($capped['error_stack']));
        $this->assertSame(500, strlen($capped['user_message']));
        $this->assertSame(300, strlen($capped['user_agent']));
        $this->assertLessThanOrEqual(500, strlen($capped['current_url']));
        $this->assertSame(80, strlen($capped['timestamp']));
    }

    public function test_client_ip_uses_remote_addr_unless_remote_is_a_trusted_proxy() {
        $spoofed = aichatbot_error_email_client_ip(
            array(
                'REMOTE_ADDR' => '203.0.113.10',
                'HTTP_X_FORWARDED_FOR' => '198.51.100.20',
            ),
            array()
        );
        $this->assertSame('203.0.113.10', $spoofed);

        $via_proxy = aichatbot_error_email_client_ip(
            array(
                'REMOTE_ADDR' => '10.0.0.1',
                'HTTP_X_FORWARDED_FOR' => '198.51.100.20, 10.0.0.1',
            ),
            array('10.0.0.1')
        );
        $this->assertSame('198.51.100.20', $via_proxy);
    }
}
