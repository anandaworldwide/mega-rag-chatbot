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

/**
 * Trusted reverse-proxy IPs for error-email rate limiting.
 *
 * Default is REMOTE_ADDR only. X-Forwarded-For and X-Real-IP are read only
 * when REMOTE_ADDR is in this list. X-Forwarded-For is then walked
 * right-to-left; trusted hops are skipped. Otherwise a client can spoof
 * those headers and bypass the per-IP cap.
 *
 * Configure in wp-config.php:
 *   define('AICHATBOT_TRUSTED_PROXIES', array('203.0.113.10'));
 * or a comma-separated string. Hosts may also filter
 * 'aichatbot_trusted_proxy_ips'.
 *
 * @param mixed $value Array or comma-separated string of IPs.
 * @return string[]
 */
function aichatbot_normalize_ip_list($value) {
    if (is_string($value)) {
        $parts = preg_split('/\s*,\s*/', $value);
    } elseif (is_array($value)) {
        $parts = $value;
    } else {
        $parts = array();
    }
    $ips = array();
    foreach ($parts as $part) {
        $part = trim((string) $part);
        if (filter_var($part, FILTER_VALIDATE_IP)) {
            $ips[] = $part;
        }
    }
    return $ips;
}

function aichatbot_trusted_proxy_ips() {
    $proxies = array();
    if (defined('AICHATBOT_TRUSTED_PROXIES')) {
        $proxies = aichatbot_normalize_ip_list(AICHATBOT_TRUSTED_PROXIES);
    }
    if (function_exists('apply_filters')) {
        $proxies = aichatbot_normalize_ip_list(apply_filters('aichatbot_trusted_proxy_ips', $proxies));
    }
    return $proxies;
}

function aichatbot_is_trusted_proxy($ip, $trusted_proxies = null) {
    $trusted = $trusted_proxies === null ? aichatbot_trusted_proxy_ips() : aichatbot_normalize_ip_list($trusted_proxies);
    return $ip !== '' && in_array($ip, $trusted, true);
}

/**
 * Valid IPs from an X-Forwarded-For style header, left to right.
 *
 * @param mixed $header Header value.
 * @return string[]
 */
function aichatbot_parse_forwarded_ip_chain($header) {
    $ips = array();
    foreach (preg_split('/\s*,\s*/', (string) $header) as $part) {
        $part = trim($part);
        if (filter_var($part, FILTER_VALIDATE_IP)) {
            $ips[] = $part;
        }
    }
    return $ips;
}

/**
 * Client IP from forwarded headers when REMOTE_ADDR is a trusted proxy.
 *
 * Walks X-Forwarded-For right-to-left and skips trusted proxy hops.
 * The right-most untrusted IP is the connecting client as seen by the
 * nearest trusted proxy. Left-most values are client-controlled and ignored.
 * If every hop is trusted, returns empty so the caller uses REMOTE_ADDR.
 * X-Real-IP is used only when X-Forwarded-For is absent.
 *
 * @param array $server Server vars.
 * @param array|string|null $trusted_proxies Trusted proxy list.
 * @return string Empty when none is usable.
 */
function aichatbot_untrusted_forwarded_ip($server, $trusted_proxies = null) {
    $chain = array();
    if (!empty($server['HTTP_X_FORWARDED_FOR'])) {
        $chain = aichatbot_parse_forwarded_ip_chain($server['HTTP_X_FORWARDED_FOR']);
    } elseif (!empty($server['HTTP_X_REAL_IP'])) {
        $chain = aichatbot_parse_forwarded_ip_chain($server['HTTP_X_REAL_IP']);
    }

    for ($i = count($chain) - 1; $i >= 0; $i--) {
        $ip = $chain[$i];
        if (!aichatbot_is_trusted_proxy($ip, $trusted_proxies)) {
            return $ip;
        }
    }
    return '';
}

/**
 * Client IP for the error-email rate-limit key.
 *
 * Uses REMOTE_ADDR unless that address is a configured trusted proxy.
 * Only then are forwarded-IP headers walked right-to-left.
 *
 * @param array|null $server          Server vars. Null uses $_SERVER.
 * @param array|string|null $trusted_proxies Override proxy list. Null uses config.
 * @return string
 */
function aichatbot_error_email_client_ip($server = null, $trusted_proxies = null) {
    $server = is_array($server) ? $server : $_SERVER;
    $remote = isset($server['REMOTE_ADDR']) ? trim((string) $server['REMOTE_ADDR']) : '';
    $trusted = $trusted_proxies === null ? aichatbot_trusted_proxy_ips() : aichatbot_normalize_ip_list($trusted_proxies);
    if (aichatbot_is_trusted_proxy($remote, $trusted)) {
        $forwarded = aichatbot_untrusted_forwarded_ip($server, $trusted);
        if ($forwarded !== '') {
            return $forwarded;
        }
    }
    if (filter_var($remote, FILTER_VALIDATE_IP)) {
        return $remote;
    }
    return '0.0.0.0';
}

function aichatbot_error_email_rate_limit_key($ip) {
    return 'aichatbot_err_email_' . md5((string) $ip);
}
