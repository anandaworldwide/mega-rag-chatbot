<?php
/**
 * CLI regression checks for error-email flood controls.
 * Run: php error-email-security.test.php
 */
require_once __DIR__ . '/error-email-security.php';

$failures = 0;

function expect_true($condition, $message) {
    global $failures;
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        $failures++;
    }
}

expect_true(aichatbot_cap_text(str_repeat('a', 20), 5) === 'aaaaa', 'cap_text truncates');
expect_true(aichatbot_cap_text(null, 10) === '', 'cap_text rejects non-strings');
expect_true(aichatbot_cap_text('short', 100) === 'short', 'cap_text keeps short text');
expect_true(aichatbot_should_rate_limit_error_email(5) === true, '5 per hour is limited');
expect_true(aichatbot_should_rate_limit_error_email(4) === false, '4 per hour is allowed');
expect_true(aichatbot_should_rate_limit_error_email(0) === false, '0 is allowed');
expect_true(aichatbot_error_email_rate_limit_max() === 5, 'max is a few per hour');
expect_true(aichatbot_error_email_body_max_length() === 4000, 'body cap is 4000');
expect_true(aichatbot_error_email_field_max_lengths()['error_stack'] === 2000, 'stack cap is 2000');
expect_true(strpos(aichatbot_error_email_rate_limit_key('1.2.3.4'), 'aichatbot_err_email_') === 0, 'transient key is per IP');
expect_true(
    aichatbot_error_email_rate_limit_key('1.2.3.4') !== aichatbot_error_email_rate_limit_key('5.6.7.8'),
    'different IPs get different keys'
);

if ($failures > 0) {
    fwrite(STDERR, "{$failures} assertion(s) failed\n");
    exit(1);
}

echo "OK\n";
exit(0);
