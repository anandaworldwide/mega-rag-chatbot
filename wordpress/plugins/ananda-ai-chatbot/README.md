# Ananda AI Chatbot WordPress Plugin

A WordPress plugin that adds an AI chatbot bubble to your site, connecting to this repo's
chat backend.

## Installation (Production)

1. Upload the `ananda-ai-chatbot` folder to the `/wp-content/plugins/` directory
2. Activate the plugin through the 'Plugins' menu in WordPress
3. Go to Settings > Ananda AI Chatbot to configure the Vercel API URL and UI settings
4. Configure the secure API connection in your wp-config.php (see Security Configuration below)

## Security Configuration

The plugin uses token-based security to communicate with the Vercel backend. To configure this:

### Add to wp-config.php

```php
// Option 1 (Recommended): Use the same SECURE_TOKEN as your Vercel backend
define('CHATBOT_BACKEND_SECURE_TOKEN', 'your-secure-token-value');

// OR Option 2: Directly set the WordPress API secret
define('WP_API_SECRET', 'your-wordpress-api-secret');
```

Option 1 is recommended as it automatically derives the correct WordPress token from the same SECURE_TOKEN
used in the Vercel backend, ensuring compatibility between systems.

After configuring, visit the "Secure API Test" page under Settings to verify your connection.

## Error Handling and Troubleshooting

### Connection Failures

If you encounter problems connecting to the Vercel backend:

- **Connection failed errors**:
  - Verify your SECURE_TOKEN in wp-config.php matches the one in your Vercel backend
  - Check that your Vercel API URL is correct and accessible from your WordPress server
  - Ensure your WordPress site can make outbound HTTP requests
  - Try using a tool like cURL to test the connection from your server to the Vercel backend

### Authentication Errors

Authentication issues usually manifest as 401 Unauthorized errors:

- **Token verification failures**:
  - Verify the secret in wp-config.php matches the Vercel backend's SECURE_TOKEN exactly
  - Check for typos or whitespace in your token values
  - Ensure the token hasn't expired (tokens typically expire after 15 minutes)
  - Verify the WordPress site's clock is synchronized (time drift can cause JWT validation failures)

### Plugin Loading Issues

If the plugin doesn't load properly:

- **"window.aichatbotAuth is undefined" errors**:
  - Check if all plugin JavaScript files are loading properly in the browser console
  - Verify that wp_enqueue_script is correctly registering all dependencies
  - Check if there are any JavaScript errors preventing script execution
  - Try clearing your browser cache and any WordPress caching plugins
  - Check browser console for script loading sequence issues

### Common JavaScript Errors

If the chatbot interface isn't working correctly:

- **Initialization failures**:
  - Check browser console for specific error messages
  - Verify the API URL is correctly set in the plugin settings
  - Ensure the token is being properly retrieved from the WordPress AJAX endpoint
  - Try disabling other plugins to check for conflicts

### Logging and Debugging

To enable detailed debugging:

1. **Enable WordPress debugging** in wp-config.php:

   ```php
   define('WP_DEBUG', true);
   define('WP_DEBUG_LOG', true);
   define('WP_DEBUG_DISPLAY', false); // Don't display errors on front-end
   ```

2. **Check log files**:
   - Debug.log will be in wp-content/debug.log
   - Use browser developer tools to monitor network requests and console errors
   - Enable verbose logging in the plugin settings if available

### Security Best Practices

1. **Token Protection**:

   - Never expose your SECURE_TOKEN in client-side code
   - Store it only in server-side files (wp-config.php)
   - Consider using environment variables if your hosting supports them
   - Regularly rotate your tokens, especially if you suspect a security breach

2. **Regular Updates**:

   - Keep the plugin updated to receive security patches
   - Monitor for any security advisories related to JWT implementations
   - Subscribe to security bulletins for dependencies

3. **Access Controls**:
   - Limit access to the plugin settings page to administrators only
   - Use WordPress capabilities to control which users can configure the plugin
   - Restrict access to the secure API test page

4. **Error-email rate limit and proxies**:
   - Error reports are capped per client IP (transient, a few per hour)
   - The limiter uses `REMOTE_ADDR` only
   - `X-Forwarded-For` / `X-Real-IP` are read only when `REMOTE_ADDR` is a trusted proxy
   - `X-Forwarded-For` is walked right-to-left; trusted hops are skipped
   - The first non-trusted IP is the rate-limit key; if every hop is trusted, `REMOTE_ADDR` is used
   - Left-most `X-Forwarded-For` values are client-controlled and are not used
   - Set trusted proxies in wp-config.php when WordPress sits behind a known load balancer:

   ```php
   define('AICHATBOT_TRUSTED_PROXIES', array('203.0.113.10', '10.0.0.2'));
   ```

   - Or filter `aichatbot_trusted_proxy_ips`
   - Do not trust forwarded headers from arbitrary clients; that bypasses the per-IP cap

### Integration Testing Checklist

After setup, perform these tests to verify proper integration:

1. Open your WordPress site in an incognito/private browser window
2. Click the chatbot bubble to open the chat interface
3. Ask a test question and verify you receive a response
4. Check the network requests in browser dev tools to confirm JWT authentication is working
5. Test across different browsers and devices to ensure consistent behavior
6. Verify that error messages are displayed appropriately when issues occur

If any test fails, use the browser console and WordPress error logs for diagnostic information.

## Development Setup

This plugin uses Composer for dependency management and IDE support.

### Prerequisites

- PHP 7.4+ (8.2 in CI)
- Composer

### Setup

1. Clone this repository to your WordPress plugins directory
2. Run `composer update` in this plugin directory to install dependencies (including PHPUnit and Brain Monkey)
3. Configure your IDE to use the WordPress stubs

### PHPUnit (Brain Monkey)

WordPress is not required. Tests stub WP APIs with Brain Monkey.

```bash
cd wordpress/plugins/ananda-ai-chatbot
composer update
vendor/bin/phpunit
```

CI runs the same commands in the WordPress Plugin PHPUnit job of `.github/workflows/comprehensive-tests.yml`.

Covered handlers:

- `aichatbot_ajax_get_token` — missing/wrong nonce returns 403 and does not call `ananda_get_api_token`; a nonce from `wp_create_nonce('aichatbot_get_token')` succeeds; `wp_localize_script` `aichatbotData` includes `nonce`
- `aichatbot_ajax_send_error_email` — missing nonce returns 403; over the per-IP transient limit returns 429; neither case calls `wp_mail`; field length caps are enforced

### IDE Configuration (VS Code with Intelephense)

The plugin includes configuration files for VS Code with the Intelephense extension:

1. Install the Intelephense extension in VS Code
2. Open the plugin folder in VS Code
3. The included `.vscode/settings.json` and `.vscode/intelephense.json` files should configure your environment
   automatically
4. Restart VS Code completely

If you still see "undefined function" errors after restarting VS Code:

1. Open VS Code settings (Cmd+, or Ctrl+,)
2. Search for "intelephense stubs"
3. Make sure "wordpress" is in the list of stubs
4. Search for "intelephense include paths"
5. Make sure the path to the WordPress stubs is included (e.g., "vendor/php-stubs/wordpress-stubs")

## Files

- `ai-chatbot.php` - Main plugin file (Ananda AI Chatbot core)
- `secure-api-client.php` - Handles secure token-based API communication
- `secure-api-test.php` - Admin test page for verifying API connection
- `assets/css/chatbot.css` - Styles for the chatbot
- `assets/js/chatbot.js` - JavaScript for the chatbot functionality
- `composer.json` - Composer package definition and dependencies
