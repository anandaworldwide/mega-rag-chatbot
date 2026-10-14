<?php
/**
 * Error-email flood controls that do not require a loaded WordPress runtime.
 */

function aichatbot_error_email_field_max_lengths() {
    return array(
        'error_type' => 100,
        'error_message' => 1000,
        'error_stack' => 2000,
        'user_message' => 500,
        'user_agent' => 300,
        'current_url' => 500,
        'timestamp' => 80,
    );
}

function aichatbot_error_email_body_max_length() {
    return 4000;
}

function aichatbot_error_email_rate_limit_max() {
    return 5;
}

function aichatbot_error_email_rate_limit_window() {
    return defined('HOUR_IN_SECONDS') ? HOUR_IN_SECONDS : 3600;
}

function aichatbot_cap_text($value, $max_length) {
    if (!is_string($value)) {
        $value = '';
    }
    $max_length = (int) $max_length;
    if ($max_length < 0) {
        $max_length = 0;
    }
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $max_length);
    }
    return substr($value, 0, $max_length);
}

function aichatbot_should_rate_limit_error_email($count, $max = null) {
    $limit = $max === null ? aichatbot_error_email_rate_limit_max() : (int) $max;
    return (int) $count >= $limit;
}

function aichatbot_error_email_client_ip() {
    $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
    if (filter_var($ip, FILTER_VALIDATE_IP)) {
        return $ip;
    }
    return '0.0.0.0';
}

function aichatbot_error_email_rate_limit_key($ip) {
    return 'aichatbot_err_email_' . md5((string) $ip);
}
