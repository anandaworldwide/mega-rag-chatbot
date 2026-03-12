<?php
/**
 * Secure API Client for WordPress Plugin
 * 
 * This file provides functions for secure communication with the Vercel backend
 * using JSON Web Tokens (JWT) for authentication. It handles the complete token
 * lifecycle including:
 * 
 * 1. Obtaining tokens from the Vercel backend using the configured API secret
 * 2. Making authenticated API calls with the obtained tokens
 * 3. Handling error conditions and token refresh when needed
 * 
 * The implementation is designed to be robust against network failures, API errors,
 * and security threats, with comprehensive error reporting for debugging.
 */

// If this file is called directly, abort.
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Get an API token from the Vercel backend
 * 
 * This function contacts the Vercel backend to obtain a JWT token for
 * API authentication. It sends the configured ANANDA_WP_API_SECRET
 * to verify the WordPress plugin's identity.
 * 
 * The token is short-lived (15 minutes) for security, requiring periodic refresh.
 * 
 * @return string|WP_Error Token string on success, WP_Error object on failure
 */
function ananda_get_api_token() {
    // Get the Vercel URL using the centralized function
    $vercel_url = aichatbot_get_api_url();
    
    // Extract the base URL (remove /api/chat/v1 or similar endpoints)
    // This uses regex to find and remove API path components
    $base_url = preg_replace('/(\/api\/.*$)/', '', $vercel_url);
    
    // Verify the API secret is configured
    // This is required for authentication with the Vercel backend
    if (!defined('ANANDA_WP_API_SECRET') || empty(ANANDA_WP_API_SECRET)) {
        return new WP_Error('missing_secret', 'WordPress API secret is not configured');
    }
    
    // Get the expected site ID from settings
    $expected_site_id = get_option('aichatbot_expected_site_id', 'ananda-public');
    
    if (defined('WP_DEBUG') && WP_DEBUG) {
        error_log("Connecting to backend URL: $base_url");
        error_log("Expected site ID: $expected_site_id");
    }
    
    // Make the API request to get a token
    // We use wp_remote_post to handle the HTTP request securely
    $response = wp_remote_post("$base_url/api/get-token", [
        'body' => json_encode([
            'secret' => ANANDA_WP_API_SECRET,
            'expectedSiteId' => $expected_site_id
        ]),
        'headers' => [
            'Content-Type' => 'application/json'
        ],
        'timeout' => 15 // 15 second timeout for network issues
    ]);
    
    // Check for WordPress HTTP API errors (network issues, etc.)
    if (is_wp_error($response)) {
        return $response; // Return the error directly for the caller to handle
    }
    
    // Check HTTP response code for API errors
    $response_code = wp_remote_retrieve_response_code($response);
    
    if (defined('WP_DEBUG') && WP_DEBUG) {
        $raw_body = wp_remote_retrieve_body($response);
        error_log("Raw API response body: " . substr($raw_body, 0, 500));
    }
    
    if ($response_code !== 200) {
        // Extract error details from the response if available
        $body = wp_remote_retrieve_body($response);
        $data = json_decode($body, true);
        $error_message = isset($data['error']) ? $data['error'] : 'Unknown error';
        $error_code = isset($data['code']) ? $data['code'] : '';
        
        // Special handling for site mismatch errors - make these user friendly
        if ($error_code === 'SITE_MISMATCH') {
            error_log("SITE MISMATCH ERROR: " . $error_message);
            
            // Return a user-friendly error
            return new WP_Error('site_mismatch', $error_message, [
                'status' => $response_code,
                'code' => 'site_mismatch'
            ]);
        }
        
        return new WP_Error('token_fetch_failed', "Failed to fetch token: $error_message", [
            'status' => $response_code
        ]);
    }
    
    // Parse the successful response to extract the token
    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    
    // Verify the token exists in the response
    if (!isset($data['token'])) {
        return new WP_Error('invalid_token_response', 'Invalid token response from server');
    }
    
    // Return the token
    return $data['token'];
}

/**
 * Call a secure API endpoint with token authentication
 * 
 * This function makes authenticated API calls to the Vercel backend using
 * JWT tokens. It handles the complete process:
 * 1. Getting a token
 * 2. Setting up the authenticated request
 * 3. Making the API call
 * 4. Processing the response
 * 
 * @param string $endpoint The API endpoint to call (e.g., 'secure-data')
 * @param array $args Additional arguments for the request (optional)
 * @return array|WP_Error Response data on success, WP_Error object on failure
 */
function ananda_call_secure_api($endpoint, $args = []) {
    // Get the Vercel URL using the centralized function
    $vercel_url = aichatbot_get_api_url();
    
    // Extract the base URL (remove /api/chat/v1 or similar endpoints)
    $base_url = preg_replace('/(\/api\/.*$)/', '', $vercel_url);
    
    // Get an authentication token
    $token = ananda_get_api_token();
    if (is_wp_error($token)) {
        return $token; // Propagate token errors to the caller
    }
    
    // Set default arguments for the API request
    // These ensure the token is included in the Authorization header
    $default_args = [
        'method' => 'GET', // Default to GET requests
        'headers' => [
            'Authorization' => "Bearer $token", // JWT token in Authorization header
            'Content-Type' => 'application/json'
        ],
        'timeout' => 15 // 15 second timeout for network issues
    ];
    
    // Merge with user-provided arguments, preserving headers properly
    $args = wp_parse_args($args, $default_args);
    if (isset($args['headers']) && is_array($args['headers'])) {
        $args['headers'] = array_merge($default_args['headers'], $args['headers']);
    }
    
    // Make the API call
    $response = wp_remote_request("$base_url/api/$endpoint", $args);
    
    // Check for WordPress HTTP API errors
    if (is_wp_error($response)) {
        return $response;
    }
    
    // Process the API response
    $response_code = wp_remote_retrieve_response_code($response);
    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    
    // Handle error responses from the API
    if ($response_code !== 200) {
        $error_message = isset($data['error']) ? $data['error'] : 'Unknown error';
        return new WP_Error('api_call_failed', "API call failed: $error_message", [
            'status' => $response_code,
            'response' => $data
        ]);
    }
    
    // Return the successfully decoded response data
    return $data;
}

/**
 * Example function to get secure data from the Vercel backend
 * 
 * This is a convenience wrapper around ananda_call_secure_api()
 * that demonstrates how to call the secure-data endpoint.
 * 
 * @return array|WP_Error Response data or error
 */
function ananda_get_secure_data() {
    return ananda_call_secure_api('secure-data');
}
