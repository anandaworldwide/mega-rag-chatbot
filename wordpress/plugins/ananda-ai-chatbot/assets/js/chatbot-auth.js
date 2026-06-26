/**
 * Ananda AI Chatbot - Authentication Utilities
 *
 * This script provides JWT token management for the WordPress plugin frontend.
 * It handles:
 * - Token acquisition from the WordPress backend
 * - Token caching and refresh
 * - Helper functions for making authenticated API calls
 *
 * DEVELOPER NOTE:
 * This file includes testing utilities that are only active in development:
 * 1. The 'forceSessionExpired()' method for simulating auth errors
 * 2. A test button that appears when '?test=true' is added to the URL
 * These features help with debugging session expiration handling and should
 * remain in the codebase for future testing purposes.
 */

// Store token and expiration in memory (not localStorage for security)
let tokenData = null;

// Buffer time before expiration to refresh token (30 seconds)
const EXPIRATION_BUFFER = 30 * 1000;

const CHATBOT_UNAVAILABLE_MESSAGE =
  'The chatbot is temporarily unavailable. An alert email has been sent to operations about the issue. Please try again later.';

function createChatbotConfigurationError(code, opsMessage) {
  const error = new Error(CHATBOT_UNAVAILABLE_MESSAGE);
  error.name = 'ChatbotConfigurationError';
  error.code = code;
  error.errorType = 'WordPress Chatbot Configuration Error';
  error.opsMessage = opsMessage;
  return error;
}

function isRetryableNetworkError(error) {
  if (!error || error.name === 'AbortError') {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('Load failed') ||
    message.includes('Network request failed')
  );
}

function isPostRetryAllowed(method, idempotencyKey) {
  const normalizedMethod = (method || 'GET').toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
    return true;
  }
  return Boolean(idempotencyKey);
}

/**
 * Retry a function with exponential backoff for network errors
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Max retry attempts (default: 3)
 * @param {number} baseDelay - Base delay in ms (default: 1000)
 * @returns {Promise} - Result of successful fn call
 */
async function retryOnNetworkError(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // User-initiated cancel (e.g. Stop button) — never retry
      if (error.name === 'AbortError') {
        throw error;
      }
      if (!isRetryableNetworkError(error)) {
        throw error; // Non-network error: fail immediately
      }
      if (attempt === maxRetries - 1) {
        throw lastError; // All retries exhausted
      }
      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Parse a JWT token to extract the expiration time
 *
 * @param {string} token - The JWT token to parse
 * @returns {number} - Token expiration time in milliseconds
 */
function parseJwtExpiration(token) {
  try {
    // Extract payload from JWT (second part between dots)
    const payload = token.split('.')[1];
    // Decode base64
    const decoded = JSON.parse(atob(payload));
    // Get expiration timestamp in milliseconds
    return decoded.exp * 1000;
  } catch (error) {
    console.error('Error parsing JWT token:', error);
    // Default to 15 minutes from now if parsing fails
    return Date.now() + 15 * 60 * 1000;
  }
}

/**
 * Check if the current token is valid and not near expiration
 *
 * @returns {boolean} - True if token is valid and not near expiration
 */
function isTokenValid() {
  if (!tokenData) return false;
  return tokenData.expiresAt > Date.now() + EXPIRATION_BUFFER;
}

/**
 * Fetch a new token from the WordPress backend
 *
 * @returns {Promise<string>} - JWT token
 */
async function fetchNewToken() {
  // Check if aichatbotData exists, if not, handle the error gracefully
  if (typeof aichatbotData === 'undefined' || !aichatbotData.ajaxUrl) {
    console.error(
      'Error: aichatbotData is not defined. WordPress may not have loaded the data correctly.',
    );
    throw new Error('Configuration error: Missing WordPress data');
  }

  // We'll use wp_ajax to get a token from the WordPress backend
  const tokenUrl = aichatbotData.ajaxUrl + '?action=aichatbot_get_token';

  try {
    const response = await retryOnNetworkError(async () => {
      return fetch(tokenUrl, {
        method: 'GET',
        credentials: 'same-origin', // Include cookies for WordPress nonce validation
      });
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch token: HTTP ${response.status}`);
    }

    // Get the raw text first to check for issues
    const rawText = await response.text();

    // Check for HTTP Basic Auth error
    if (
      rawText.includes('permission to access this page') ||
      rawText.includes('HTTP authentication') ||
      rawText.includes('Authorization Required')
    ) {
      console.error('HTTP Basic Authentication error detected');
      throw new Error('SESSION_EXPIRED');
    }

    // Check if the response looks like valid JSON
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (jsonError) {
      console.error('Failed to parse JSON response:', jsonError);
      console.error('Raw response:', rawText);
      throw new Error(
        'Invalid JSON in response. Check WordPress PHP errors or warnings that might be included in the output.',
      );
    }

    // WordPress's wp_send_json_success wraps the data in a 'data' property
    // and sets 'success' to true
    if (!data.success) {
      // Extract detailed error information if available
      const errorMessage = data.data?.message || 'Unknown error';
      const errorCode = data.data?.code || 'unknown_error';
      const errorDetails = data.data?.details || '';

      console.error(
        `WordPress token API error (${errorCode}): ${errorMessage}`,
        errorDetails ? `\nDetails: ${errorDetails}` : '',
      );

      // Format a user-friendly error message based on error code
      let userMessage = errorMessage;

      if (errorCode === 'site_mismatch') {
        throw createChatbotConfigurationError(
          'site_mismatch',
          `The WordPress chatbot plugin is configured for the wrong backend site. Backend response: ${errorMessage}. Details: ${errorDetails || 'No extra details provided.'} Check the plugin API Base URL and Expected Site ID settings.`,
        );
      } else if (errorCode === 'token_fetch_failed') {
        throw createChatbotConfigurationError(
          'backend_token_auth_failed',
          `The WordPress chatbot plugin could not obtain a backend JWT. This is commonly caused by a mismatched CHATBOT_BACKEND_SECURE_TOKEN or WP_API_SECRET in wp-config.php after key rotation. Backend response: ${errorMessage}. Details: ${errorDetails || 'No extra details provided.'}`,
        );
      } else if (errorCode === 'configuration_error') {
        throw createChatbotConfigurationError(
          'wordpress_token_configuration_error',
          `The WordPress chatbot plugin is missing or has invalid backend authentication configuration. WordPress response: ${errorMessage}. Details: ${errorDetails || 'No extra details provided.'}`,
        );
      } else if (errorCode === 'internal_error') {
        throw createChatbotConfigurationError(
          'wordpress_token_internal_error',
          `The WordPress chatbot token endpoint hit an internal error while requesting a backend JWT. WordPress response: ${errorMessage}. Details: ${errorDetails || 'No extra details provided.'}`,
        );
      }

      throw new Error(userMessage);
    }

    // Access the token from the 'data' property where WordPress puts it
    if (!data.data || !data.data.token) {
      console.error(
        'WordPress token API returned invalid data structure:',
        JSON.stringify(data),
      );
      throw new Error('Invalid token response: Missing token in API response');
    }

    const token = data.data.token;

    // Validate token format (should be JWT with 3 parts)
    if (!token || token.split('.').length !== 3) {
      console.error('WordPress token API returned malformed token:', token);
      throw new Error('Invalid token format received from server');
    }

    // Store token with expiration time
    tokenData = {
      token,
      expiresAt: parseJwtExpiration(token),
    };

    return token;
  } catch (error) {
    // Add more context to the error message
    console.error('Token fetch error:', error);

    // Special handling for session expiration
    if (error.message === 'SESSION_EXPIRED') {
      throw new Error(
        'Your session has expired. Please reload the page to continue.',
      );
    }

    if (error.name === 'ChatbotConfigurationError') {
      throw error;
    }

    // Provide user-friendly error messages based on common error patterns
    let userFriendlyError = error;

    if (error.message.includes('HTTP 403')) {
      userFriendlyError = createChatbotConfigurationError(
        'wordpress_backend_token_rejected',
        `The WordPress chatbot backend token request was rejected with HTTP 403 while trying to get a backend JWT. This usually means CHATBOT_BACKEND_SECURE_TOKEN or WP_API_SECRET in wp-config.php does not match the backend SECURE_TOKEN after key rotation. Token URL: ${tokenUrl}. Browser error: ${error.message}.`,
      );
    } else if (error.message.includes('Failed to fetch')) {
      userFriendlyError = createChatbotConfigurationError(
        'wordpress_token_endpoint_unreachable',
        `The WordPress chatbot frontend could not reach the WordPress AJAX token endpoint while trying to get a backend JWT. Token URL: ${tokenUrl}. Browser error: ${error.message}. This can indicate a local WordPress routing/CORS issue, a blocked admin-ajax request, or stale copied plugin files.`,
      );
    } else if (error.message.includes('HTTP 404')) {
      userFriendlyError = new Error(
        'API not found: The token endpoint URL is incorrect or not accessible.',
      );
    } else if (error.message.includes('HTTP 500')) {
      userFriendlyError = new Error(
        'Server error: The WordPress backend encountered an internal error. Check your server logs.',
      );
    } else if (error.message.includes('Invalid JSON')) {
      userFriendlyError = new Error(
        'Invalid response: The server returned malformed data. Check for PHP errors or warnings in your WordPress installation.',
      );
    }

    // Preserve original error but with improved message
    throw userFriendlyError;
  }
}

/**
 * Get a valid token, fetching a new one if necessary
 *
 * @returns {Promise<string>} - Valid JWT token
 */
async function getToken() {
  if (isTokenValid()) {
    return tokenData.token;
  }

  return fetchNewToken();
}

/**
 * Make a fetch request with authorization header
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>} - Fetch response
 */
async function fetchWithAuth(url, options = {}) {
  const { idempotencyKey, ...fetchOptions } = options;
  const token = await getToken();

  // Ensure headers object exists
  const headers = {
    'Content-Type': 'application/json',
    ...fetchOptions.headers,
    Authorization: `Bearer ${token}`,
  };

  const requestOptions = {
    ...fetchOptions,
    headers,
    credentials: 'include', // Include cookies for CORS
  };

  const executeFetch = () => fetch(url, requestOptions);
  const method = fetchOptions.method || 'GET';

  // POST side effects are only retried when the caller supplies an idempotency key
  // that the backend deduplicates (see clientRequestId on /api/chat/v1).
  if (isPostRetryAllowed(method, idempotencyKey)) {
    return retryOnNetworkError(executeFetch);
  }

  return executeFetch();
}

// Export to global scope for WordPress frontend
// Make sure this runs immediately and doesn't depend on DOM content loaded
window.aichatbotAuth = {
  getToken,
  fetchWithAuth,
  __testing__: {
    isRetryableNetworkError,
    isPostRetryAllowed,
    retryOnNetworkError,
  },
  // For testing: Force session to expire
  forceSessionExpired: function () {
    // Create and throw the same error that would happen with a real HTTP auth expiration
    throw new Error(
      'Your session has expired. Please reload the page to continue.',
    );
  },
};

// Add a safety check that runs when the page loads
(function () {
  // This runs immediately when the script loads
  if (!window.aichatbotAuth) {
    console.error('Error: aichatbotAuth failed to initialize properly');
  } else {
    // For developers: Add test button if URL has test=true
    if (window.location.search.includes('test=true')) {
      setTimeout(() => {
        const testButton = document.createElement('button');
        testButton.textContent = 'Test Session Expiration';
        testButton.style.position = 'fixed';
        testButton.style.bottom = '120px';
        testButton.style.right = '20px';
        testButton.style.zIndex = '9999';
        testButton.style.padding = '10px';
        testButton.style.backgroundColor = '#ff6b6b';
        testButton.style.color = 'white';
        testButton.style.border = 'none';
        testButton.style.borderRadius = '4px';
        testButton.style.cursor = 'pointer';

        testButton.addEventListener('click', () => {
          try {
            window.aichatbotAuth.forceSessionExpired();
          } catch (error) {
            // In a real scenario, this error would be caught by the chatbot.js error handler
            // So let's simulate that happening
            const messages = document.getElementById('aichatbot-messages');
            if (messages) {
              const errorMessage = document.createElement('div');
              errorMessage.className = 'aichatbot-error-message';
              errorMessage.innerHTML = `
                <strong>Session Expired:</strong> Your authentication has expired.<br>
                <small>Please reload the page to continue using the chatbot.</small><br>
                <button id="aichatbot-reload-button" style="margin-top: 10px; padding: 5px 10px; background-color: #4a90e2; color: white; border: none; border-radius: 4px; cursor: pointer;">Reload Page</button>
              `;
              messages.appendChild(errorMessage);

              setTimeout(() => {
                const reloadButton = document.getElementById(
                  'aichatbot-reload-button',
                );
                if (reloadButton) {
                  reloadButton.addEventListener('click', () => {
                    window.location.reload();
                  });
                }
              }, 100);
            }
          }
        });

        document.body.appendChild(testButton);
      }, 1000);
    }
  }
})();
