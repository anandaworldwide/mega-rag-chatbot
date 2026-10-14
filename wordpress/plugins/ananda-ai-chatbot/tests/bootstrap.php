<?php
/**
 * PHPUnit bootstrap for Ananda AI Chatbot plugin tests.
 *
 * WordPress is not loaded. Brain Monkey stubs WP APIs.
 * ananda_get_api_token is defined here so tests can count calls
 * before the plugin file is required.
 */

$autoload = dirname(__DIR__) . '/vendor/autoload.php';
if (!is_file($autoload)) {
    fwrite(STDERR, "Composer autoload missing. Run: composer update --working-dir=" . dirname(__DIR__) . "\n");
    exit(1);
}

require_once $autoload;
require_once __DIR__ . '/JsonResponseException.php';
require_once __DIR__ . '/PluginTestCase.php';

if (!defined('ABSPATH')) {
    define('ABSPATH', sys_get_temp_dir() . '/');
}

if (!defined('HOUR_IN_SECONDS')) {
    define('HOUR_IN_SECONDS', 3600);
}

if (!defined('WP_DEBUG')) {
    define('WP_DEBUG', false);
}

$GLOBALS['ananda_get_api_token_calls'] = 0;
$GLOBALS['ananda_get_api_token_result'] = 'header.payload.signature';

if (!function_exists('ananda_get_api_token')) {
    /**
     * Test double. The plugin wraps the real function in function_exists().
     *
     * @return string|WP_Error
     */
    function ananda_get_api_token() {
        $GLOBALS['ananda_get_api_token_calls']++;
        return $GLOBALS['ananda_get_api_token_result'];
    }
}
