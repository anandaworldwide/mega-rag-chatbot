<?php

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

/**
 * Shared WordPress stubs and one-time plugin load.
 */
abstract class PluginTestCase extends TestCase {
    /** @var bool */
    private static $pluginLoaded = false;

    /** @var array<int, array{handle:string,object_name:string,data:array}> */
    protected $localizedScripts = array();

    /** @var array<string, mixed> */
    protected $transients = array();

    /** @var int */
    protected $wpMailCalls = 0;

    protected function setUp(): void {
        parent::setUp();
        Monkey\setUp();

        $this->localizedScripts = array();
        $this->transients = array();
        $this->wpMailCalls = 0;
        $GLOBALS['ananda_get_api_token_calls'] = 0;
        $GLOBALS['ananda_get_api_token_result'] = 'header.payload.signature';
        $_REQUEST = array();
        $_POST = array();
        $_GET = array();
        $_SERVER['REMOTE_ADDR'] = '203.0.113.10';

        $this->stubWordPress();
        $this->loadPluginOnce();
    }

    protected function tearDown(): void {
        Monkey\tearDown();
        parent::tearDown();
    }

    private function stubWordPress(): void {
        $case = $this;

        Functions\when('plugin_dir_path')->alias(static function ($file) {
            return dirname($file) . '/';
        });
        Functions\when('plugin_dir_url')->justReturn('http://example.com/wp-content/plugins/ananda-ai-chatbot/');
        Functions\when('add_action')->justReturn(true);
        Functions\when('add_filter')->justReturn(true);
        Functions\when('apply_filters')->alias(static function ($_hook, $value) {
            return $value;
        });
        Functions\when('add_options_page')->justReturn(true);
        Functions\when('add_submenu_page')->justReturn(true);
        Functions\when('register_setting')->justReturn(true);
        Functions\when('wp_enqueue_style')->justReturn(true);
        Functions\when('wp_enqueue_script')->justReturn(true);
        Functions\when('wp_script_add_data')->justReturn(true);
        Functions\when('is_search')->justReturn(false);
        Functions\when('admin_url')->justReturn('http://example.com/wp-admin/admin-ajax.php');
        Functions\when('get_site_url')->justReturn('http://example.com');
        Functions\when('sanitize_text_field')->returnArg();
        Functions\when('sanitize_textarea_field')->returnArg();
        Functions\when('esc_url_raw')->returnArg();
        Functions\when('wp_unslash')->returnArg();
        Functions\when('is_wp_error')->alias(static function ($value) {
            return is_object($value) && method_exists($value, 'get_error_message');
        });

        Functions\when('wp_create_nonce')->alias(static function ($action) {
            return 'nonce-for-' . $action;
        });
        Functions\when('wp_verify_nonce')->alias(static function ($nonce, $action) {
            if (!is_string($nonce) || $nonce === '') {
                return false;
            }
            return $nonce === 'nonce-for-' . $action ? 1 : false;
        });

        Functions\when('check_ajax_referer')->alias(static function ($action, $query_arg = false, $die = true) {
            $key = $query_arg ? $query_arg : '_wpnonce';
            $nonce = '';
            if (isset($_REQUEST[$key])) {
                $nonce = $_REQUEST[$key];
            } elseif (isset($_POST[$key])) {
                $nonce = $_POST[$key];
            }
            $valid = wp_verify_nonce($nonce, $action);
            if (!$valid) {
                if ($die) {
                    throw new JsonResponseException('error', array('code' => 'invalid_nonce'), 403);
                }
                return false;
            }
            return 1;
        });

        Functions\when('wp_send_json_error')->alias(static function ($data = null, $status_code = null) {
            throw new JsonResponseException('error', $data, $status_code ? (int) $status_code : 400);
        });
        Functions\when('wp_send_json_success')->alias(static function ($data = null, $status_code = null) {
            throw new JsonResponseException('success', $data, $status_code ? (int) $status_code : 200);
        });

        Functions\when('get_option')->alias(static function ($key, $default = false) {
            return $default;
        });

        Functions\when('get_transient')->alias(static function ($key) use ($case) {
            return array_key_exists($key, $case->transients) ? $case->transients[$key] : false;
        });
        Functions\when('set_transient')->alias(static function ($key, $value, $ttl = 0) use ($case) {
            $case->transients[$key] = $value;
            return true;
        });

        Functions\when('wp_localize_script')->alias(static function ($handle, $object_name, $data) use ($case) {
            $case->localizedScripts[] = array(
                'handle' => $handle,
                'object_name' => $object_name,
                'data' => $data,
            );
            return true;
        });

        Functions\when('wp_mail')->alias(static function () use ($case) {
            $case->wpMailCalls++;
            return true;
        });
    }

    private function loadPluginOnce(): void {
        if (self::$pluginLoaded) {
            return;
        }
        require_once dirname(__DIR__) . '/ai-chatbot.php';
        self::$pluginLoaded = true;
    }

    /**
     * Invoke a handler that exits via wp_send_json_* / check_ajax_referer.
     *
     * @return JsonResponseException
     */
    protected function captureJson(callable $handler) {
        $bufferLevel = ob_get_level();
        try {
            $handler();
        } catch (JsonResponseException $exception) {
            while (ob_get_level() > $bufferLevel) {
                ob_end_clean();
            }
            return $exception;
        }
        while (ob_get_level() > $bufferLevel) {
            ob_end_clean();
        }
        $this->fail('Handler did not send a JSON response');
    }
}
