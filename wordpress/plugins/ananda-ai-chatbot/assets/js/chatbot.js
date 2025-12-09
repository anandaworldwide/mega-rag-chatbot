/**
 * Ananda AI Chatbot - Frontend JavaScript
 *
 * This script handles the frontend functionality of the Ananda AI chatbot WordPress plugin.
 *
 * Key features:
 * - Chat interface with floating bubble and expandable window
 * - Streaming response support for real-time token display
 * - Abort controller for canceling ongoing requests
 * - Source document display for reference materials
 * - Error handling with user-friendly messages
 * - Automatic scrolling to keep latest messages visible
 * - Fallback support for non-streaming API responses
 * - Markdown rendering for bot responses
 * - Session persistence across page navigation
 * - Auto-focus on input field when chat opens
 * - Close on Escape key or clicking outside
 * - Full page chat option for expanded experience
 * - Dynamic Intercom integration via special [any text](GETHUMAN) links
 * - AI suggestion chips for follow-up questions
 */

document.addEventListener("DOMContentLoaded", () => {
  // API endpoint paths
  const API_PATHS = {
    CHAT: "/api/chat/v1",
    VOTE: "/api/vote",
    NPS: "/api/submitNpsSurvey",
  };

  // Default base URL
  const DEFAULT_BASE_URL = "https://vivek.ananda.org";

  // Store user votes (docId -> 1 | -1)
  let votes = {};

  // Clean the base URL by removing trailing slashes
  function getBaseUrl() {
    const configuredUrl = aichatbotData.vercelUrl || DEFAULT_BASE_URL;
    return configuredUrl.replace(/\/+$/, "");
  }

  // Simple UUID generator (needed by original script and NPS)
  function generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0,
        v = c == "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // --- NPS Survey Logic Start ---

  // Helper to get item from localStorage with default value
  function getLocalStorageItem(key, defaultValue) {
    try {
      const item = localStorage.getItem(key);
      // Handle explicit null/undefined storage vs. missing key
      if (item === null) return defaultValue;
      // Attempt to parse if it looks like JSON, otherwise return raw
      try {
        // Be careful with primitive strings that are valid JSON ('"string"')
        if (typeof defaultValue !== "string" || item.startsWith("{") || item.startsWith("[")) {
          return JSON.parse(item);
        }
      } catch (e) {
        /* Ignore parse error, return raw string */
      }
      return item;
    } catch (error) {
      console.error(`Error reading localStorage key \u201C${key}\u201D:`, error);
      return defaultValue;
    }
  }

  // Helper to set item in localStorage
  function setLocalStorageItem(key, value) {
    try {
      const stringValue = typeof value === "string" ? value : JSON.stringify(value);
      localStorage.setItem(key, stringValue);
    } catch (error) {
      console.error(`Error setting localStorage key \u201C${key}\u201D:`, error);
    }
  }

  // Initialize NPS state variables from localStorage
  let npsQueryCount = getLocalStorageItem("npsQueryCount", 0);
  let npsLastSurveyTimestamp = getLocalStorageItem("npsLastSurveyTimestamp", null);
  let npsLastSurveyQueryCount = getLocalStorageItem("npsLastSurveyQueryCount", 0);
  let npsUserUuid = getLocalStorageItem("npsUserUuid", null);
  let npsDismissReason = getLocalStorageItem("npsDismissReason", null);

  // Generate and save UUID if it doesn't exist
  if (!npsUserUuid) {
    npsUserUuid = generateUUID(); // Use the globally available function
    setLocalStorageItem("npsUserUuid", npsUserUuid);
  }

  // Function to increment query count and check NPS trigger conditions
  function handleNpsSurveyCheck() {
    npsQueryCount++;
    setLocalStorageItem("npsQueryCount", npsQueryCount);

    // --- Trigger Logic Start ---
    const NPS_QUERY_THRESHOLD = 5;
    const THREE_MONTHS_IN_MS = 3 * 30 * 24 * 60 * 60 * 1000; // Approximate
    const THREE_DAYS_IN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
    const now = Date.now();

    // Track current session exchanges - using chatHistory length
    // This variable needs to be incremented only once we've completed a full Q&A exchange
    const currentSessionExchanges = chatHistory.filter((item) => {
      if (Array.isArray(item)) return item[0] && item[1];
      return item.userMessage && item.botMessage;
    }).length;

    // Don't show NPS survey if there are no completed exchanges in the current session
    if (currentSessionExchanges < 1) {
      return;
    }

    // Determine the required delay based on the dismiss reason
    let requiredDelay = THREE_MONTHS_IN_MS; // Default to 3 months
    if (npsDismissReason === "later" || npsDismissReason === "no_thanks") {
      requiredDelay = THREE_DAYS_IN_MS;
    }

    let shouldShow = false;

    // Condition 1: Initial trigger (no previous survey interaction recorded)
    if (!npsLastSurveyTimestamp && npsQueryCount >= NPS_QUERY_THRESHOLD) {
      shouldShow = true;
    }
    // Condition 2: Recurrence trigger
    else if (npsLastSurveyTimestamp) {
      const timeSinceLastInteraction = now - npsLastSurveyTimestamp;
      const queriesSinceLastSubmission = npsQueryCount - npsLastSurveyQueryCount;

      // Check if enough time has passed based on the reason
      if (timeSinceLastInteraction >= requiredDelay) {
        // If it was dismissed ('later' or 'no_thanks'), show immediately after 3 days (ignore query threshold)
        if (npsDismissReason === "later" || npsDismissReason === "no_thanks") {
          shouldShow = true;
        }
        // If it was submitted, also check the query threshold
        else if (npsDismissReason === "submitted" && queriesSinceLastSubmission >= NPS_QUERY_THRESHOLD) {
          shouldShow = true;
        }
        // Handle cases where dismissReason might be null/unexpected (treat as submitted/default)
        else if (!npsDismissReason && queriesSinceLastSubmission >= NPS_QUERY_THRESHOLD) {
          console.warn("NPS check: dismissReason missing, applying default 3-month/5-query rule.");
          shouldShow = true;
        }
      }
    }

    if (shouldShow) {
      showNpsSurveyModal();
    }
    // --- Trigger Logic End ---
  }
  // --- NPS Survey Logic End ---

  // Initialize variables
  let isStreaming = false;
  let currentAbortController = null;
  let defaultCollection = "whole_library";
  let temporarySession = false;
  let mediaTypes = { text: true, audio: false, youtube: false };
  let sourceCount = 6;
  let intercomEnabled = false;
  let googleAnalyticsId = "";
  let sessionQuestionCount = 0; // Track questions in current session
  let searchBubbleVisible = false; // Track search bubble visibility

  // Get DOM elements
  const bubble = document.getElementById("aichatbot-bubble");
  const chatWindow = document.getElementById("aichatbot-window");
  const input = document.getElementById("aichatbot-input");
  const sendButton = document.getElementById("aichatbot-send");
  const messages = document.getElementById("aichatbot-messages");

  // Initialize language hint functionality
  const hint = document.querySelector(".aichatbot-language-hint");
  const modal = document.querySelector(".aichatbot-language-modal");

  if (hint && modal) {
    hint.addEventListener("click", () => {
      trackLanguageButtonClick();
      modal.style.display = "flex";
    });

    const closeButton = modal.querySelector(".modal-close");
    if (closeButton) {
      closeButton.addEventListener("click", () => {
        modal.style.display = "none";
      });
    }

    // Close modal when clicking outside
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
      }
    });
  }

  // Create controls container (to hold both buttons)
  const controlsContainer = document.createElement("div");
  controlsContainer.id = "aichatbot-controls";
  chatWindow.appendChild(controlsContainer);

  // Add full page chat button
  const fullPageButton = document.createElement("div");
  fullPageButton.id = "aichatbot-fullpage";
  fullPageButton.innerHTML = `<i class="fas fa-expand-alt"></i>Full page chat`;

  // Initialize chat history - now stores objects with metadata
  let chatHistory = [];

  // --- Google Analytics Integration Start ---

  // Initialize Google Analytics settings from WordPress
  if (typeof aichatbotData !== "undefined" && aichatbotData.googleAnalyticsId) {
    googleAnalyticsId = aichatbotData.googleAnalyticsId;
  }

  /**
   * Create and display follow-up suggestion chips
   * @param {Array} suggestions - Array of TypedSuggestion objects with {id, text, type}
   * @param {Element} botMessage - The bot message element to append chips to
   */
  function createSuggestionChips(suggestions, botMessage) {
    if (!suggestions || suggestions.length === 0) {
      return;
    }

    if (!botMessage) {
      return;
    }

    // Remove any existing chips
    const existingChips = botMessage.querySelector(".aichatbot-suggestion-chips");
    if (existingChips) {
      existingChips.remove();
    }

    // Validate suggestions are TypedSuggestion objects
    const validSuggestions = suggestions.filter(
      (suggestion) => suggestion && typeof suggestion === "object" && suggestion.text && suggestion.type
    );

    if (validSuggestions.length === 0) {
      return;
    }

    // Separate suggestions by type
    const deeperSuggestions = validSuggestions.filter((s) => s.type === "deeper");
    const broaderSuggestions = validSuggestions.filter((s) => s.type === "broader");

    // Create main container
    const chipsContainer = document.createElement("div");
    chipsContainer.className = "aichatbot-suggestion-chips";

    // Helper function to create a chip button
    const createChip = (suggestion, index) => {
      const chip = document.createElement("button");
      chip.className = "aichatbot-suggestion-chip";
      chip.textContent = suggestion.text;
      chip.title = suggestion.text; // Full text on hover
      chip.setAttribute("data-suggestion-id", suggestion.id);

      // Add click handler
      chip.addEventListener("click", () => {
        handleSuggestionClick(suggestion.text, index, suggestion);
      });

      return chip;
    };

    // Create "Go deeper" section if we have deeper suggestions
    if (deeperSuggestions.length > 0) {
      const deeperSection = document.createElement("div");
      deeperSection.className = "aichatbot-suggestion-section";

      const deeperHeader = document.createElement("h4");
      deeperHeader.className = "aichatbot-suggestion-header";
      deeperHeader.textContent = "Go deeper";
      deeperSection.appendChild(deeperHeader);

      const deeperChipsContainer = document.createElement("div");
      deeperChipsContainer.className = "aichatbot-suggestion-chips-row";
      deeperSuggestions.forEach((suggestion, index) => {
        deeperChipsContainer.appendChild(createChip(suggestion, index));
      });
      deeperSection.appendChild(deeperChipsContainer);

      chipsContainer.appendChild(deeperSection);
    }

    // Create "Go broader" section if we have broader suggestions
    if (broaderSuggestions.length > 0) {
      const broaderSection = document.createElement("div");
      broaderSection.className = "aichatbot-suggestion-section";

      const broaderHeader = document.createElement("h4");
      broaderHeader.className = "aichatbot-suggestion-header";
      broaderHeader.textContent = "Go broader";
      broaderSection.appendChild(broaderHeader);

      const broaderChipsContainer = document.createElement("div");
      broaderChipsContainer.className = "aichatbot-suggestion-chips-row";
      broaderSuggestions.forEach((suggestion, index) => {
        broaderChipsContainer.appendChild(createChip(suggestion, index));
      });
      broaderSection.appendChild(broaderChipsContainer);

      chipsContainer.appendChild(broaderSection);
    }

    // Only add container if we have chips
    if (chipsContainer.children.length > 0) {
      botMessage.appendChild(chipsContainer);
    }
  }

  /**
   * Handle suggestion chip click
   * @param {string} suggestionText - The suggestion text
   * @param {number} index - The index of the clicked suggestion
   * @param {Object} suggestion - The full TypedSuggestion object (optional)
   */
  function handleSuggestionClick(suggestionText, index, suggestion = null) {
    // Track analytics
    sendGoogleAnalyticsEvent("chatbot_vivek_suggestion_click", {
      event_category: "chatbot_engagement",
      suggestion_text: suggestionText.substring(0, 100), // First 100 chars for analysis
      suggestion_index: index,
      suggestion_type: suggestion?.type || "unknown",
      suggestion_id: suggestion?.id || `suggestion-${index}`,
      session_questions_total: sessionQuestionCount,
    });

    // Set the suggestion as input value
    input.value = suggestionText;

    // Auto-resize textarea to fit the suggestion
    autoResizeTextarea();

    // Auto-submit the suggestion
    sendMessage();
  }

  /**
   * Send Google Analytics event
   * Supports both Google Analytics 4 (gtag) and Google Tag Manager (dataLayer)
   *
   * @param {string} action - The action being tracked (e.g., 'open_popup', 'submit_question')
   * @param {Object} parameters - Additional event parameters
   */
  function sendGoogleAnalyticsEvent(action, parameters = {}) {
    if (!googleAnalyticsId) {
      return; // Analytics not configured
    }

    // Default event parameters
    const eventData = {
      event_category: "chatbot",
      event_label: "ananda_ai_chatbot",
      ...parameters,
    };

    try {
      // Try Google Analytics 4 (gtag) first
      if (typeof gtag !== "undefined") {
        gtag("event", action, eventData);
        console.log(`GA4 Event: ${action}`, eventData);
      }
      // Fallback to Google Tag Manager dataLayer
      else if (typeof dataLayer !== "undefined") {
        dataLayer.push({
          event: action,
          event_category: eventData.event_category,
          event_label: eventData.event_label,
          ...parameters,
        });
        console.log(`GTM Event: ${action}`, eventData);
      }
      // Manual gtag initialization if neither is available but ID is GTM
      else if (googleAnalyticsId.startsWith("GTM-")) {
        // Initialize dataLayer if it doesn't exist
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
          event: action,
          event_category: eventData.event_category,
          event_label: eventData.event_label,
          ...parameters,
        });
        console.log(`GTM Event (manual): ${action}`, eventData);
      } else {
        console.warn("Google Analytics not initialized, but tracking ID provided:", googleAnalyticsId);
      }
    } catch (error) {
      console.error("Error sending Google Analytics event:", error);
    }
  }

  /**
   * Track chatbot popup open event
   */
  function trackPopupOpen() {
    sendGoogleAnalyticsEvent("chatbot_vivek_popup_open", {
      event_category: "chatbot_interaction",
      method: "bubble_click",
    });
  }

  /**
   * Track chatbot popup close event
   * @param {string} method - How the popup was closed ('close_button', 'click_away', 'escape_key')
   */
  function trackPopupClose(method) {
    sendGoogleAnalyticsEvent("chatbot_vivek_popup_close", {
      event_category: "chatbot_interaction",
      method: method,
      session_questions_total: sessionQuestionCount, // ← add this
    });
  }

  /**
   * Track question submission
   * @param {number} questionNumber - The sequence number of the question in the session
   * @param {string} question - The question text (first 100 chars for privacy)
   */
  function trackQuestionSubmit(questionNumber, question) {
    sendGoogleAnalyticsEvent("chatbot_vivek_question_submit", {
      event_category: "chatbot_engagement",
      question_number: questionNumber,
      question_preview: question.substring(0, 100), // First 100 chars for analysis
      session_questions_total: questionNumber,
    });
  }

  /**
   * Track full page chat link click
   */
  function trackFullPageChatClick() {
    sendGoogleAnalyticsEvent("chatbot_vivek_fullpage_click", {
      event_category: "chatbot_navigation",
      destination: "fullpage_chat",
    });
  }

  /**
   * Track contact human link click
   */
  function trackContactHumanClick() {
    sendGoogleAnalyticsEvent("chatbot_vivek_contact_human", {
      event_category: "chatbot_support",
      method: "intercom_trigger",
      session_questions_total: sessionQuestionCount, // ← add this
    });
  }

  /**
   * Track language button click
   */
  function trackLanguageButtonClick() {
    sendGoogleAnalyticsEvent("chatbot_vivek_language_click", {
      event_category: "chatbot_utility",
      feature: "language_help",
    });
  }

  /**
   * Track NPS survey completion
   * @param {number} score - The NPS score (0-10)
   * @param {string} feedback - Whether feedback was provided
   */
  function trackNPSSurveySubmit(score, feedback) {
    sendGoogleAnalyticsEvent("chatbot_vivek_nps_submit", {
      event_category: "chatbot_feedback",
      nps_score: score,
      has_feedback: feedback && feedback.trim().length > 0 ? "yes" : "no",
      value: score,
    });
  }

  /**
   * Track NPS survey dismissal
   * @param {string} reason - 'later' or 'no_thanks'
   */
  function trackNPSSurveyDismiss(reason) {
    sendGoogleAnalyticsEvent("chatbot_vivek_nps_dismiss", {
      event_category: "chatbot_feedback",
      dismiss_reason: reason,
    });
  }

  /**
   * Track clear chat history button click
   */
  function trackClearChatHistory() {
    sendGoogleAnalyticsEvent("chatbot_vivek_clear_history", {
      event_category: "chatbot_interaction",
      chat_messages_cleared: chatHistory.length,
    });
  }

  /**
   * Track source link click
   * @param {string} linkText - The text of the clicked link
   * @param {string} linkUrl - The URL of the clicked link
   */
  function trackSourceLinkClick(linkText, linkUrl) {
    sendGoogleAnalyticsEvent("chatbot_vivek_source_link_click", {
      event_category: "chatbot_view_sources",
      link_text: linkText.substring(0, 100), // First 100 chars for analysis
      link_url: linkUrl,
    });
  }

  /**
   * Track ask the experts link click
   * @param {string} linkText - The text of the clicked link
   * @param {string} linkUrl - The URL of the clicked link
   * @param {number} questionNumber - The sequence number of the question in the session
   */
  function trackAskTheExpertsLinkClick(linkText, linkUrl, questionNumber) {
    sendGoogleAnalyticsEvent("chatbot_vivek_ask_experts_link_click", {
      event_category: "chatbot_ask_experts",
      link_text: linkText.substring(0, 100), // First 100 chars for analysis
      link_url: linkUrl,
      question_number: questionNumber,
      session_questions_total: sessionQuestionCount,
    });
  }

  /**
   * Track popup open via keyboard shortcut
   */
  function trackKeyboardShortcutOpen() {
    sendGoogleAnalyticsEvent("chatbot_vivek_popup_open", {
      event_category: "chatbot_interaction",
      method: "keyboard_shortcut",
      shortcut_key: "slash",
    });
  }

  // --- Google Analytics Integration End ---

  // Add event listeners after all elements are created
  // Close button functionality
  document.getElementById("aichatbot-close").addEventListener("click", () => {
    chatWindow.style.display = "none";
    document.body.classList.remove("aichatbot-window-open");
    trackPopupClose("close_button");
    saveChatState();
  });

  // Full page chat button functionality
  fullPageButton.addEventListener("click", () => {
    let fullPageUrl = "/chat";
    if (typeof aichatbotData !== "undefined" && aichatbotData.fullPageUrl) {
      fullPageUrl = aichatbotData.fullPageUrl;
    }
    trackFullPageChatClick();
    window.open(fullPageUrl, "_blank");
  });

  // Bubble click functionality
  bubble.addEventListener("click", (e) => {
    const wasOpen = chatWindow.style.display === "flex";
    chatWindow.style.display = chatWindow.style.display === "none" ? "flex" : "none";

    if (chatWindow.style.display === "flex") {
      document.body.classList.add("aichatbot-window-open");
      setTimeout(() => input.focus(), 0);
      setTimeout(() => {
        messages.scrollTop = messages.scrollHeight;
      }, 0);
      addWelcomeMessage();
      if (chatHistory.length > 0) {
        input.placeholder = "";
      } else {
        input.placeholder = getRandomPlaceholder();
      }
      if (!wasOpen) {
        trackPopupOpen();
      }
    } else {
      document.body.classList.remove("aichatbot-window-open");
      trackPopupClose("bubble_click");
    }
    saveChatState();
    e.stopPropagation();
  });

  // Send button functionality
  sendButton.addEventListener("click", sendMessage);

  // Enter key functionality
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Add click event delegation for Intercom trigger text
  messages.addEventListener("click", (e) => {
    const trigger = e.target.closest(".aichatbot-intercom-trigger");
    if (trigger) {
      e.preventDefault();
      showIntercom();
    }
  });

  // Add click event delegation for source links
  messages.addEventListener("click", (e) => {
    const sourceLink = e.target.closest(".aichatbot-source-link");
    if (sourceLink) {
      const linkText = sourceLink.textContent;
      const linkUrl = sourceLink.href;

      // Track the source link click
      trackSourceLinkClick(linkText, linkUrl);

      // The link will open in a new tab due to target="_blank"
      // No need to prevent default or handle navigation manually
    }
  });

  // Add click event delegation for ask the experts links
  messages.addEventListener("click", (e) => {
    const askExpertsLink = e.target.closest(".aichatbot-ask-the-experts-link");
    if (askExpertsLink) {
      const linkText = askExpertsLink.textContent;
      const linkUrl = askExpertsLink.href;

      // Track the ask the experts link click
      trackAskTheExpertsLinkClick(linkText, linkUrl, sessionQuestionCount);

      // The link will open in a new tab due to target="_blank"
      // No need to prevent default or handle navigation manually
    }
  });

  // Now load chat state and initialize UI
  loadChatState();
  addWelcomeMessage();
  updatePlaceholder();
  updateClearHistoryButton();

  // Check if the wand-magic-sparkles icon is available, use fallback if not
  setTimeout(() => {
    const wandIcon = document.querySelector(".fa-wand-magic-sparkles");
    if (wandIcon) {
      // Check if the icon is rendered properly
      const computedStyle = window.getComputedStyle(wandIcon, ":before");
      const contentValue = computedStyle.getPropertyValue("content");

      // If the icon isn't rendering properly (empty or "none"), show the fallback
      if (contentValue === "none" || contentValue === "") {
        wandIcon.style.display = "none";
        const fallbackIcon = document.querySelector(".fa-magic");
        if (fallbackIcon) {
          fallbackIcon.style.display = "inline-block";
        }
      }
    }
  }, 500);

  // Define initial height constant
  const INITIAL_HEIGHT = "40px";

  // Initialize textarea to exact height
  input.style.height = INITIAL_HEIGHT;
  input.style.overflowY = "hidden";

  // Set up textarea auto-expand functionality
  function autoResizeTextarea() {
    // For empty content, always reset to initial height
    if (!input.value.trim()) {
      resetTextareaHeight();
      return;
    }

    // Reset height to auto to properly calculate the new height
    input.style.height = "auto";

    // Set the height to scrollHeight to fit all content (up to max-height in CSS)
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;

    // If content is longer than max height, keep the scrollbar
    if (input.scrollHeight > window.innerHeight * 0.4) {
      input.style.overflowY = "auto";
    } else {
      input.style.overflowY = "hidden";
    }
  }

  // Function to completely reset textarea height
  function resetTextareaHeight() {
    input.style.height = "auto"; // First reset to auto
    input.style.overflowY = "hidden";
    input.style.height = INITIAL_HEIGHT; // Then set to initial height

    // Force a reflow to ensure the height is applied
    void input.offsetHeight;
  }

  // Initialize textarea height
  autoResizeTextarea();

  // Auto-resize when typing
  input.addEventListener("input", autoResizeTextarea);

  // Reset height when window is resized
  window.addEventListener("resize", autoResizeTextarea);

  // Handle Intercom integration if enabled
  if (typeof aichatbotData !== "undefined") {
    intercomEnabled = aichatbotData.enableIntercom === "1";

    // If the intercom integration is enabled, we need to wait for the Intercom object to be available
    // So we check every 500ms if the Intercom object is available
    if (intercomEnabled) {
      let attempts = 0;
      const maxAttempts = 10; // 5 seconds total (10 attempts * 500ms)
      const checkInterval = 500; // 500ms = half second

      const setupIntercom = () => {
        if (typeof window.Intercom !== "undefined") {
          // Add a class to the body for CSS targeting when Intercom is active
          document.body.classList.add("intercom-enabled");
          document.body.classList.add("hide-intercom");

          // Add listener for when Intercom messenger is hidden by the user
          window.Intercom("onHide", function () {
            console.log("Intercom messenger hidden (onHide event).");

            // Re-hide the Intercom container/launcher using our CSS rule
            if (!document.body.classList.contains("hide-intercom")) {
              document.body.classList.add("hide-intercom");
            }

            // Show the chatbot bubble (if it exists)
            const bubble = document.getElementById("aichatbot-bubble");
            if (bubble) {
              bubble.style.display = "flex"; // Assuming flex is the default visible state
              console.log("Chatbot bubble shown.");
            }
          });
          return true; // Successfully set up Intercom
        }
        return false; // Intercom not ready yet
      };

      // Try immediately first
      if (!setupIntercom()) {
        // If not ready, start polling
        const pollInterval = setInterval(() => {
          attempts++;
          if (setupIntercom() || attempts >= maxAttempts) {
            clearInterval(pollInterval);
          }
        }, checkInterval);
      }
    }
  }

  // Function to show Intercom and hide chatbot
  function showIntercom() {
    if (intercomEnabled && typeof window.Intercom !== "undefined") {
      // Remove the 'hide-intercom' class from the body to show Intercom
      if (document.body.classList.contains("hide-intercom")) {
        document.body.classList.remove("hide-intercom");
        console.log("Removed CSS class from body to show Intercom container.");
      } else {
        console.log("hide-intercom class not found on body, proceeding anyway.");
      }

      // Hide chatbot window
      chatWindow.style.display = "none";
      document.body.classList.remove("aichatbot-window-open"); // Ensure body class is removed
      saveChatState(); // Save closed state

      // Show Intercom - use the proper method to both show and open the messenger
      try {
        // Explicitly show and open the messenger
        window.Intercom("show");
        window.Intercom("showNewMessage"); // Optionally opens composer directly

        console.log("Intercom triggered successfully via show/showNewMessage");
        return true;
      } catch (e) {
        console.error("Error showing Intercom:", e);
        return false;
      }
    }
    // Log if Intercom isn't enabled or ready
    console.log("Intercom not enabled or not ready.");
    return false;
  }

  // Default placeholder questions in case WordPress settings are not available
  let placeholderQuestions = ["Ask me anything about this website"];

  // Override with questions from WordPress if available
  if (
    typeof aichatbotData !== "undefined" &&
    aichatbotData.placeholderQuestionsText &&
    aichatbotData.placeholderQuestionsText.trim() !== ""
  ) {
    // Split the text into lines and filter out empty lines
    const questions = aichatbotData.placeholderQuestionsText
      .split("\n")
      .map((question) => question.trim())
      .filter((question) => question !== "");

    if (questions.length > 0) {
      placeholderQuestions = questions;
    }
  }

  // Function to get a random placeholder question
  function getRandomPlaceholder() {
    const randomIndex = Math.floor(Math.random() * placeholderQuestions.length);
    return placeholderQuestions[randomIndex];
  }

  // Apply customization settings from WordPress if available
  if (typeof aichatbotData !== "undefined") {
    // Apply font size setting if provided
    if (aichatbotData.fontSizePx) {
      const fontSize = parseInt(aichatbotData.fontSizePx);
      if (fontSize >= 12 && fontSize <= 24) {
        // CSS is already applied via inline styles, but we can enhance dynamic elements here if needed
      }
    }

    // Apply window dimensions if provided and not on mobile
    if (window.innerWidth > 480) {
      // Only apply custom dimensions on non-mobile
      if (aichatbotData.windowWidthPx) {
        const windowWidth = parseInt(aichatbotData.windowWidthPx);
        if (windowWidth >= 300 && windowWidth <= 600) {
          // CSS is already applied via inline styles
        }
      }

      if (aichatbotData.windowHeightPx) {
        const windowHeight = parseInt(aichatbotData.windowHeightPx);
        if (windowHeight >= 400 && windowHeight <= 800) {
          // CSS is already applied via inline styles
        }
      }
    }
  }

  // Track accumulated response for streaming
  let accumulatedResponse = "";
  let currentBotMessage = null;
  let currentSuggestions = []; // Store current follow-up suggestions

  /**
   * Renders markdown text into HTML with support for:
   * - Paragraphs (separated by double newlines)
   * - Unordered lists (using * or - as markers)
   * - Bold text (**text** or __text__)
   * - Italic text (*text* or _text_)
   * - Inline code (`code`)
   * - Links ([text](url))
   * - Special GETHUMAN links for Intercom integration
   *
   * @param {string} text - The markdown text to convert to HTML
   * @returns {string} The rendered HTML
   */
  function renderMarkdown(text) {
    if (!text) return "";

    // Normalize line endings and clean up excessive whitespace:
    // - Convert Windows line endings to Unix
    // - Collapse 3+ newlines into 2 (standard markdown paragraph break)
    // - Ensure consistent spacing before lists (add extra newline if needed)
    text = text
      .trim()
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      // Add extra newline before first list item if there isn't already a blank line
      .replace(/([^\n])\n([*-] .*\n)(?!\n[*-] )/g, "$1\n\n$2")
      .replace(/([^\n])\n([*-] .*)$/g, "$1\n\n$2")
      // Add extra newline before first ordered list item
      .replace(/([^\n])\n(\d+\. .*\n)(?!\n\d+\. )/g, "$1\n\n$2")
      .replace(/([^\n])\n(\d+\. .*)$/g, "$1\n\n$2");

    // Process headings first
    text = text.replace(/^(#{1,6})\s+(.+)$/gm, (match, hashes, content) => {
      const level = hashes.length;
      return `<h${level}>${content}</h${level}>`;
    });

    // Split text into logical blocks (paragraphs and lists)
    const blocks = text.split("\n\n");
    let html = "";
    let inList = false; // Tracks whether we're currently processing a list
    let inOrderedList = false; // Track whether we're in an ordered list

    for (let i = 0; i < blocks.length; i++) {
      let block = blocks[i].trim();
      let nextBlock = i < blocks.length - 1 ? blocks[i + 1].trim() : "";

      // Check if this block starts with a list marker
      if (block.match(/^[*-]\s/m)) {
        // Start a new unordered list if we're not already in one
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        // Close ordered list if we were in one
        if (inOrderedList) {
          html += "</ol>";
          inOrderedList = false;
        }
        // Process unordered list items
        const items = block.split("\n");
        for (let item of items) {
          if (item.trim()) {
            if (item.match(/^[*-]\s/)) {
              const listContent = item
                .replace(/^[*-]\s+/, "")
                .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                .replace(/__(.*?)__/g, "<strong>$1</strong>")
                .replace(/\*(.*?)\*/g, "<em>$1</em>")
                .replace(/_(.*?)_/g, "<em>$1</em>")
                .replace(/`(.*?)`/g, "<code>$1</code>")
                .replace(
                  /\[(.*?)\]\(GETHUMAN\)/g,
                  '<span class="aichatbot-intercom-trigger" style="color:#4a90e2; text-decoration:underline; cursor:pointer;">$1</span>'
                )
                .replace(
                  /\[(.*?)\]\((https?:\/\/www\.ananda\.org\/ask\/?)\)/g,
                  '<a href="$2" target="_blank" class="aichatbot-ask-the-experts-link">$1</a>'
                )
                .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="aichatbot-source-link">$1</a>');

              html += `<li>${listContent}</li>`;
            } else {
              if (inList) {
                html += "</ul>";
                inList = false;
              }
              let paragraph = item
                .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                .replace(/__(.*?)__/g, "<strong>$1</strong>")
                .replace(/\*(.*?)\*/g, "<em>$1</em>")
                .replace(/_(.*?)_/g, "<em>$1</em>")
                .replace(/`(.*?)`/g, "<code>$1</code>")
                .replace(
                  /\[(.*?)\]\(GETHUMAN\)/g,
                  '<span class="aichatbot-intercom-trigger" style="color:#4a90e2; text-decoration:underline; cursor:pointer;">$1</span>'
                )
                .replace(
                  /\[(.*?)\]\((https?:\/\/www\.ananda\.org\/ask\/?)\)/g,
                  '<a href="$2" target="_blank" class="aichatbot-ask-the-experts-link">$1</a>'
                )
                .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="aichatbot-source-link">$1</a>');

              html += `<p>${paragraph}</p>`;
            }
          }
        }
      } else if (block.match(/^\d+\.\s/m)) {
        // Start a new ordered list if we're not already in one
        if (!inOrderedList) {
          html += "<ol>";
          inOrderedList = true;
        }
        // Close unordered list if we were in one
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        // Process ordered list items
        const items = block.split("\n");
        for (let item of items) {
          if (item.trim()) {
            if (item.match(/^\d+\.\s/)) {
              const listContent = item
                .replace(/^\d+\.\s+/, "")
                .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                .replace(/__(.*?)__/g, "<strong>$1</strong>")
                .replace(/\*(.*?)\*/g, "<em>$1</em>")
                .replace(/_(.*?)_/g, "<em>$1</em>")
                .replace(/`(.*?)`/g, "<code>$1</code>")
                .replace(
                  /\[(.*?)\]\(GETHUMAN\)/g,
                  '<span class="aichatbot-intercom-trigger" style="color:#4a90e2; text-decoration:underline; cursor:pointer;">$1</span>'
                )
                .replace(
                  /\[(.*?)\]\((https?:\/\/www\.ananda\.org\/ask\/?)\)/g,
                  '<a href="$2" target="_blank" class="aichatbot-ask-the-experts-link">$1</a>'
                )
                .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="aichatbot-source-link">$1</a>');

              html += `<li>${listContent}</li>`;
            } else {
              if (inOrderedList) {
                html += "</ol>";
                inOrderedList = false;
              }
              let paragraph = item
                .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                .replace(/__(.*?)__/g, "<strong>$1</strong>")
                .replace(/\*(.*?)\*/g, "<em>$1</em>")
                .replace(/_(.*?)_/g, "<em>$1</em>")
                .replace(/`(.*?)`/g, "<code>$1</code>")
                .replace(
                  /\[(.*?)\]\(GETHUMAN\)/g,
                  '<span class="aichatbot-intercom-trigger" style="color:#4a90e2; text-decoration:underline; cursor:pointer;">$1</span>'
                )
                .replace(
                  /\[(.*?)\]\((https?:\/\/www\.ananda\.org\/ask\/?)\)/g,
                  '<a href="$2" target="_blank" class="aichatbot-ask-the-experts-link">$1</a>'
                )
                .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="aichatbot-source-link">$1</a>');

              html += `<p>${paragraph}</p>`;
            }
          }
        }
      } else {
        // This is a regular paragraph block
        // Close any open lists
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        if (inOrderedList) {
          html += "</ol>";
          inOrderedList = false;
        }

        // Process the paragraph block
        let paragraph = block
          .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
          .replace(/__(.*?)__/g, "<strong>$1</strong>")
          .replace(/\*(.*?)\*/g, "<em>$1</em>")
          .replace(/_(.*?)_/g, "<em>$1</em>")
          .replace(/`(.*?)`/g, "<code>$1</code>")
          .replace(
            /\[(.*?)\]\(GETHUMAN\)/g,
            '<span class="aichatbot-intercom-trigger" style="color:#4a90e2; text-decoration:underline; cursor:pointer;">$1</span>'
          )
          .replace(
            /\[(.*?)\]\((https?:\/\/www\.ananda\.org\/ask\/?)\)/g,
            '<a href="$2" target="_blank" class="aichatbot-ask-the-experts-link">$1</a>'
          )
          .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="aichatbot-source-link">$1</a>')
          .replace(/\n/g, "<br />");

        html += `<p>${paragraph}</p>`;
      }
    }

    // Ensure any open lists are properly closed
    if (inList) {
      html += "</ul>";
    }
    if (inOrderedList) {
      html += "</ol>";
    }

    return html;
  }

  /**
   * Helper function to format error messages with Intercom support link
   * @param {string} errorHtml - HTML content for the error message
   * @returns {string} - Formatted error HTML with Intercom support link
   */
  function formatErrorWithIntercomSupport(errorHtml) {
    return `
      ${errorHtml}
      <small style="display: block; margin-top: 10px;">
        Need help? <span class="aichatbot-intercom-trigger" style="color:#4a90e2; text-decoration:underline; cursor:pointer;">Click here for support</span>.
      </small>
    `;
  }

  /**
   * Handle error display in the chat interface
   * @param {Error} error - The error object
   * @param {HTMLElement} messagesContainer - The messages container element
   * @param {HTMLElement} typingIndicator - The typing indicator element
   */
  function handleChatError(error, messagesContainer, typingIndicator) {
    // Remove typing indicator if it exists
    if (messagesContainer.contains(typingIndicator)) {
      messagesContainer.removeChild(typingIndicator);
    }

    // Show error message
    const errorMessage = document.createElement("div");
    errorMessage.className = "aichatbot-error-message";

    if (error.name === "AbortError") {
      errorMessage.textContent = "Request was canceled.";
    } else if (error.name === "TypeError" && error.message.includes("Failed to fetch")) {
      errorMessage.innerHTML = formatErrorWithIntercomSupport("Chatbot server is unavailable. Please try again later.");
    } else if (error.message.includes("NetworkError") || error.message.includes("CORS")) {
      errorMessage.innerHTML = formatErrorWithIntercomSupport(
        "Connection to chatbot server failed. Please try again later."
      );
    } else if (error.message.includes("Site mismatch")) {
      errorMessage.innerHTML = formatErrorWithIntercomSupport(`
        <strong>Configuration Error:</strong> ${error.message}<br>
        <small>Please contact the site administrator to update the chatbot settings.</small>
      `);
    } else if (error.message.includes("Invalid token")) {
      errorMessage.innerHTML = formatErrorWithIntercomSupport(`
        <strong>Authentication Error:</strong> Unable to connect to the chat backend.<br>
        <small>Please check your internet connection and try again.</small>
      `);
      console.error("Token error details:", error.message);
    } else if (error.message.includes("session has expired")) {
      // Session expiration is special - has reload button, no Intercom link
      errorMessage.innerHTML = `
        <strong>Session Expired:</strong> Your authentication has expired.<br>
        <small>Please reload the page to continue using the chatbot.</small><br>
        <button id="aichatbot-reload-button" style="margin-top: 10px; padding: 5px 10px; background-color: #4a90e2; color: white; border: none; border-radius: 4px; cursor: pointer;">Reload Page</button>
      `;

      // Add reload functionality after the message is added to DOM
      setTimeout(() => {
        const reloadButton = document.getElementById("aichatbot-reload-button");
        if (reloadButton) {
          reloadButton.addEventListener("click", () => {
            window.location.reload();
          });
        }
      }, 100);
    } else {
      // Format other errors to be more readable
      const cleanErrorMessage = error.message.replace(/Server error \((.*)\)/, "$1").replace(/Error: /, "");

      errorMessage.innerHTML = formatErrorWithIntercomSupport(`
        <strong>Error:</strong> ${cleanErrorMessage}<br>
        <small>If this problem persists, please contact support.</small>
      `);
    }

    messagesContainer.appendChild(errorMessage);
  }

  async function sendMessage() {
    const message = input.value.trim();
    if (!message) return;

    // Test functionality: if message is exactly "hi, this is michel sampil vaitikaitis", trigger error and send email
    if (message === "hi, this is michel sampil vaitikaitis") {
      console.log("Test message detected - triggering error and sending email");
      const testError = new Error("Test error triggered by Michel Sampil Vaitikaitis");
      await sendErrorEmail(testError, "Test error from chatbot", message);
      throw testError;
    }

    // Always clear placeholder immediately on sending a message
    input.placeholder = "";

    // If already streaming, stop it
    if (stopStreaming()) {
      return;
    }

    // Don't check for NPS survey yet - we'll check after receiving an answer
    // (NPS Survey check moved to the completion handler below)

    // Increment question count and track analytics
    sessionQuestionCount++;
    trackQuestionSubmit(sessionQuestionCount, message);

    // Reset accumulated response and suggestions
    accumulatedResponse = "";
    currentSuggestions = [];

    // Show user message
    const userMessage = document.createElement("div");
    userMessage.className = "aichatbot-user-message";
    userMessage.textContent = message;
    messages.appendChild(userMessage);

    // Clear input and completely reset height
    input.value = "";
    resetTextareaHeight();

    // Create bot message container but don't add to DOM yet
    currentBotMessage = createBotMessage(message);

    // Show typing indicator
    const typingIndicator = document.createElement("div");
    typingIndicator.className = "aichatbot-typing";
    const typingSpan = document.createElement("span");
    typingSpan.className = "typing-dots";
    typingSpan.textContent = ".";
    typingIndicator.appendChild(typingSpan);
    messages.appendChild(typingIndicator);
    messages.scrollTop = messages.scrollHeight;

    // Toggle buttons
    sendButton.style.display = "none";
    stopButton.style.display = "inline-block";

    isStreaming = true;

    // Update chat history with user message - store as object with metadata
    chatHistory.push({
      userMessage: message,
      botMessage: "",
      suggestions: [],
      docId: null,
    });

    try {
      // Get token for API call
      const token = await getToken();
      if (!token) {
        throw new Error("Failed to get authentication token");
      }

      // Create new abort controller for this request
      currentAbortController = new AbortController();

      // Make API call
      const response = await window.aichatbotAuth.fetchWithAuth(`${getBaseUrl()}${API_PATHS.CHAT}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: message,
          history: chatHistory
            .slice(0, -1)
            .map((item) => {
              // Handle both old array format and new object format
              const userMsg = Array.isArray(item) ? item[0] : item.userMessage;
              const botMsg = Array.isArray(item) ? item[1] : item.botMessage;
              return [
                { role: "user", content: userMsg },
                { role: "assistant", content: botMsg },
              ];
            })
            .flat(),
          collection: defaultCollection,
          temporarySession: temporarySession,
          mediaTypes: mediaTypes,
          sourceCount: sourceCount,
          uuid: npsUserUuid, // Add UUID for backend validation
        }),
        signal: currentAbortController.signal,
      });

      if (!response.ok) {
        try {
          const errorData = await response.json();
          console.error("API Error:", errorData);
          const errorMessage = errorData.error || JSON.stringify(errorData);

          // Send error email to administrators
          await sendErrorEmail(new Error(errorMessage), "API Error", message);

          throw new Error(`${errorMessage}`); // This will show the actual API error
        } catch (e) {
          throw new Error(`Server error (${response.status}): ${e.message}`);
        }
      }

      // Check if the response is a stream
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const messageContent = currentBotMessage.querySelector(".aichatbot-message-content");
        let firstTokenReceived = false;
        let hasContent = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          // Check if user is near the bottom BEFORE adding the new chunk
          const wasScrolledToBottom = messages.scrollHeight - messages.clientHeight <= messages.scrollTop + 10;

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const jsonData = JSON.parse(line.slice(5));

                // Check site ID and source count
                if (jsonData.siteId && jsonData.siteId !== "ananda-public") {
                  console.error(
                    "[Ananda-AI-Chatbot]: Backend is using incorrect site ID:",
                    jsonData.siteId,
                    "Expected: ananda-public"
                  );
                }

                // Handle token updates
                if (jsonData.token) {
                  accumulatedResponse += jsonData.token;

                  // Check if we have actual visible content (not just whitespace)
                  hasContent = accumulatedResponse.trim().length > 0;

                  // Only add bot message to DOM and remove typing indicator if we have actual visible content
                  if (hasContent && !firstTokenReceived) {
                    // Make sure we're not just receiving metadata or whitespace
                    const actualContent = accumulatedResponse.replace(/\s+/g, "").length > 0;
                    if (actualContent) {
                      // Add the bot message to DOM now that we have content
                      messages.appendChild(currentBotMessage);

                      if (messages.contains(typingIndicator)) {
                        messages.removeChild(typingIndicator);
                      }
                      firstTokenReceived = true;
                    }
                  }

                  // Render markdown for the accumulated response
                  messageContent.innerHTML = renderMarkdown(accumulatedResponse);

                  // Update the last history item with the current accumulated response
                  const lastItem = chatHistory[chatHistory.length - 1];
                  if (Array.isArray(lastItem)) {
                    // Back-compat: old array format [userMsg, botMsg]
                    lastItem[1] = accumulatedResponse;
                    if (lastItem[1].length % 100 === 0) saveChatState();
                  } else {
                    // New object format { userMessage, botMessage, … }
                    lastItem.botMessage = accumulatedResponse;
                    if (lastItem.botMessage.length % 100 === 0) saveChatState();
                  }
                }

                // Handle suggestions
                if (jsonData.suggestions && Array.isArray(jsonData.suggestions)) {
                  currentSuggestions = jsonData.suggestions;

                  // Store suggestions in chat history
                  if (chatHistory.length > 0) {
                    chatHistory[chatHistory.length - 1].suggestions = currentSuggestions;
                  }

                  // Ensure bot message is in DOM when we receive suggestions
                  if (!messages.contains(currentBotMessage)) {
                    messages.appendChild(currentBotMessage);
                    if (messages.contains(typingIndicator)) {
                      messages.removeChild(typingIndicator);
                    }
                    firstTokenReceived = true;
                  }

                  // Display suggestion chips immediately when received (like main web frontend)
                  createSuggestionChips(currentSuggestions, currentBotMessage);
                }

                // Handle completion
                if (jsonData.done) {
                  // Make sure typing indicator is removed when done
                  if (messages.contains(typingIndicator)) {
                    messages.removeChild(typingIndicator);
                  }
                  currentAbortController = null;
                  sendButton.style.display = "inline-block";
                  stopButton.style.display = "none";

                  // A complete Q&A exchange has happened
                  // Only check if we received a non-empty response
                  if (accumulatedResponse.trim().length > 0) {
                    // Always wait 20 seconds after any completed exchange
                    // before checking for NPS survey to give user time to read
                    setTimeout(() => {
                      handleNpsSurveyCheck();
                    }, 20000); // 20 seconds delay
                  }

                  // Set streaming flag to false
                  isStreaming = false;

                  // Save final state when streaming is complete
                  saveChatState();

                  // Update clear history button
                  updateClearHistoryButton();

                  // Ensure bot message is in DOM before adding chips/buttons
                  if (!messages.contains(currentBotMessage)) {
                    messages.appendChild(currentBotMessage);
                  }
                }

                // Handle errors
                if (jsonData.error) {
                  if (messages.contains(typingIndicator)) {
                    messages.removeChild(typingIndicator);
                  }
                  throw new Error(jsonData.error);
                }

                // Handle docId - Store it and make vote buttons visible immediately
                if (jsonData.docId) {
                  currentBotMessage.setAttribute("data-doc-id", jsonData.docId);

                  // Store docId in chat history
                  if (chatHistory.length > 0) {
                    chatHistory[chatHistory.length - 1].docId = jsonData.docId;
                  }

                  // Check if vote buttons already exist (from preemptive creation)
                  let voteButtons = currentBotMessage.querySelector(".aichatbot-vote-buttons");

                  if (voteButtons) {
                    // Make existing hidden buttons visible
                    voteButtons.style.visibility = "visible";
                  } else {
                    // Create and add vote buttons immediately
                    const docId = jsonData.docId;
                    addVoteButtons(currentBotMessage, docId, false); // false = visible immediately
                  }
                }
              } catch (parseError) {
                console.error("Error parsing JSON:", parseError);
              }
            }
          }

          // Scroll to bottom AFTER potentially adding content, ONLY if user WAS at the bottom before
          if (wasScrolledToBottom) {
            messages.scrollTop = messages.scrollHeight;
          }
        }
      } else {
        // Handle non-streaming response
        const data = await response.json();
        const messageContent = currentBotMessage.querySelector(".aichatbot-message-content");

        // Log the raw response before markdown rendering
        console.log("Non-streaming response before markdown:", data.reply || "No response received.");

        // Render markdown for the response
        const renderedContent = renderMarkdown(data.reply || "No response received.");
        messageContent.innerHTML = renderedContent;

        // Add the bot message to DOM now that we have content
        messages.appendChild(currentBotMessage);

        // Now that we have content rendered, remove the typing indicator
        if (messages.contains(typingIndicator)) {
          messages.removeChild(typingIndicator);
        }

        // Update chat history with the complete response
        if (chatHistory.length > 0) {
          const lastItem = chatHistory[chatHistory.length - 1];
          if (Array.isArray(lastItem)) {
            lastItem[1] = data.reply || "";
          } else {
            lastItem.botMessage = data.reply || "";
          }
          // Save state after receiving complete response
          saveChatState();

          // Update clear history button
          updateClearHistoryButton();
        }

        // Set docId if provided
        if (data.docId) {
          console.log(`Received valid docId from server: ${data.docId}`);
          currentBotMessage.setAttribute("data-doc-id", data.docId);
        } else {
          console.warn("No docId received from server - vote functionality will be disabled for this message");
        }

        // Non-streaming processing is complete, now we can add vote buttons
        if (currentBotMessage.hasAttribute("data-doc-id")) {
          const docId = currentBotMessage.getAttribute("data-doc-id");
          console.log(`Adding vote buttons for non-streaming response with docId: ${docId}`);
          addVoteButtons(currentBotMessage, docId);
        }
      }
    } catch (error) {
      // Use helper function to handle error display
      handleChatError(error, messages, typingIndicator);

      // Send error email to administrators for all errors except AbortError (user clicked stop button)
      if (error.name !== "AbortError") {
        try {
          await sendErrorEmail(
            error,
            "Chatbot Error",
            chatHistory.length > 0 ? (chatHistory[chatHistory.length - 1]?.userMessage || "No user message") : "No user message"
          );
        } catch (emailError) {
          console.error("Failed to send error email:", emailError);
        }
      }

      // Additional error logging for site administrators (exclude AbortError - user clicked stop button)
      if (error.name !== "AbortError") {
        console.error("Chatbot error details:", {
          message: error.message,
          name: error.name,
          stack: error.stack,
          chatHistory: chatHistory.length, // Just the count for privacy
          vercelUrl: aichatbotData.vercelUrl,
        });
      }
    } finally {
      // Reset UI state
      sendButton.style.display = "inline-block";
      stopButton.style.display = "none";
      currentAbortController = null;

      // Set streaming flag to false in finally block to ensure it's reset
      isStreaming = false;

      // Update clear history button state
      updateClearHistoryButton();

      // Check if user WAS near the bottom before the final processing
      const wasScrolledToBottomFinal = messages.scrollHeight - messages.clientHeight <= messages.scrollTop + 10; // 10px tolerance
      // Scroll to bottom AFTER final processing ONLY if user WAS near the bottom before
      if (wasScrolledToBottomFinal) {
        messages.scrollTop = messages.scrollHeight;
      }
    }
  }

  /* @TODO Commenting this out for now. After some testing, if the chat window works well
           on mobile and desktop, we can delete the code altogether. 

  // Handle window resize events for responsive behavior
  window.addEventListener('resize', () => {
    const windowVisible = sessionStorage.getItem('aichatbot_window_visible');
    const isLargeScreen = window.innerWidth >= 768;

    // If window was visible and we're on a small screen, hide it
    if (
      windowVisible === 'true' &&
      !isLargeScreen &&
      chatWindow.style.display === 'flex'
    ) {
      chatWindow.style.display = 'none';
      // Don't update sessionStorage here since we still want to remember it was open
    }
    // If window was visible and we transition to large screen, show it
    else if (
      windowVisible === 'true' &&
      isLargeScreen &&
      chatWindow.style.display === 'none'
    ) {
      chatWindow.style.display = 'flex';
      // Focus the input when we open
      setTimeout(() => input.focus(), 0);
    }
  }); */

  // Save chat state when user leaves the page
  window.addEventListener("beforeunload", saveChatState);

  // Function to update the clear history button visibility
  function updateClearHistoryButton() {
    // Get the controls container
    const controlsContainer = document.getElementById("aichatbot-controls");

    // Clear the controls container
    if (controlsContainer) {
      controlsContainer.innerHTML = "";
    }

    // Create clear history button only if there's chat history
    if (chatHistory.length > 0) {
      const clearButton = document.createElement("div");
      clearButton.id = "aichatbot-clear-history";
      clearButton.innerHTML = '<i class="fas fa-trash-alt"></i> Clear chat history';

      // Disable the button visually and functionally during streaming
      if (isStreaming) {
        clearButton.classList.add("disabled");
        clearButton.style.opacity = "0.5";
        clearButton.style.cursor = "not-allowed";
      } else {
        clearButton.addEventListener("click", clearChatHistory);
      }

      // Add to the controls container
      controlsContainer.appendChild(clearButton);
    }

    // Always add the full page button to the controls - it should always be visible
    controlsContainer.appendChild(fullPageButton);

    // Add Contact a Human button
    const contactHumanButton = document.createElement("div");
    contactHumanButton.id = "aichatbot-contact-human";
    contactHumanButton.innerHTML = `<i class="fas fa-user"></i> Contact a human`;
    contactHumanButton.addEventListener("click", () => {
      trackContactHumanClick();
      showIntercom();
    });

    // Add to the controls container
    controlsContainer.appendChild(contactHumanButton);
  }

  // Function to clear chat history
  function clearChatHistory() {
    // Track the clear history action before clearing
    trackClearChatHistory();

    // Store current window state
    const wasWindowOpen = chatWindow.style.display === "flex";

    // Clear history array - reset to new object format
    chatHistory = [];

    // Clear the UI
    messages.innerHTML = "";

    // Add welcome message back
    addWelcomeMessage();

    // Restore placeholder text
    updatePlaceholder();

    // Save empty state
    saveChatState();

    // Make sure window remains open - force this to happen AFTER all other operations
    if (wasWindowOpen) {
      // Use setTimeout to ensure this happens after any other operations
      setTimeout(() => {
        chatWindow.style.display = "flex";
        // Extra safety - explicitly set the session storage value
        sessionStorage.setItem("aichatbot_window_visible", "true");
        // Set focus back to the input field
        input.focus();
      }, 0);
    }

    // Update button visibility
    updateClearHistoryButton();
  }

  // Load chat history and UI state from sessionStorage
  function loadChatState() {
    try {
      // Load chat history
      const savedHistory = sessionStorage.getItem("aichatbot_history");
      if (savedHistory) {
        const rawHistory = JSON.parse(savedHistory);

        // Convert any legacy array items to the new object format
        const normalizeHistory = (historyArr) =>
          historyArr.map((item) =>
            Array.isArray(item)
              ? {
                  userMessage: item[0] || "",
                  botMessage: item[1] || "",
                  suggestions: [],
                  docId: null,
                }
              : item
          );

        chatHistory = normalizeHistory(rawHistory);

        // If we transformed anything, write back the clean version so future loads are uniform
        if (JSON.stringify(chatHistory) !== JSON.stringify(rawHistory)) {
          sessionStorage.setItem("aichatbot_history", JSON.stringify(chatHistory));
        }

        // Rebuild chat messages from history - handle both old array format and new object format
        chatHistory.forEach((item) => {
          let userMsg, botMsg, suggestions, docId;

          // Handle backward compatibility with old array format
          if (Array.isArray(item)) {
            [userMsg, botMsg] = item;
            suggestions = [];
            docId = null;
          } else {
            // New object format
            userMsg = item.userMessage || item[0] || item["0"] || "";
            botMsg = item.botMessage || item[1] || item["1"] || "";
            suggestions = item.suggestions || [];
            docId = item.docId || null;
          }

          // Add user message
          if (userMsg) {
            const userMessage = document.createElement("div");
            userMessage.className = "aichatbot-user-message";
            userMessage.textContent = userMsg;
            messages.appendChild(userMessage);
          }

          // Add bot message
          if (botMsg) {
            const botMessage = createBotMessage(botMsg);

            // Restore suggestions if available
            if (suggestions && suggestions.length > 0) {
              createSuggestionChips(suggestions, botMessage);
            }

            // Restore vote buttons if docId available
            if (docId) {
              botMessage.setAttribute("data-doc-id", docId);
              addVoteButtons(botMessage, docId, false); // false = visible immediately
            }

            messages.appendChild(botMessage);
          }
        });

        // Scroll to the bottom of the chat after loading history
        setTimeout(() => {
          messages.scrollTop = messages.scrollHeight;
        }, 0);
      }

      // Load UI state (window open/closed)
      const windowVisible = sessionStorage.getItem("aichatbot_window_visible");

      // Check screen width - only auto-open on larger screens
      const isLargeScreen = window.innerWidth >= 768; // Typical tablet/desktop breakpoint

      if (windowVisible === "true") {
        // If it was visible and screen is large enough, show it
        // Otherwise leave it minimized on mobile
        chatWindow.style.display = isLargeScreen ? "flex" : "none";
      } else {
        // Default to hiding chat window if it was previously closed
        chatWindow.style.display = "none";
      }
    } catch (e) {
      console.error("Error loading chat state:", e);
      // Default to hiding chat window
      chatWindow.style.display = "none";
    }

    // Focus on input field when chat window is shown
    if (chatWindow.style.display === "flex") {
      setTimeout(() => input.focus(), 0);
    }

    // Show/hide clear history button based on chat history
    updateClearHistoryButton();
  }

  // Save chat history and UI state to sessionStorage
  function saveChatState() {
    try {
      sessionStorage.setItem("aichatbot_history", JSON.stringify(chatHistory));
      sessionStorage.setItem("aichatbot_window_visible", chatWindow.style.display === "flex");

      // Update placeholder whenever chat history is saved
      if (chatHistory.length > 0) {
        input.placeholder = "";
      }
    } catch (e) {
      console.error("Error saving chat state:", e);
    }
  }

  // Add initial welcome message if chat is empty
  function addWelcomeMessage() {
    if (chatHistory.length === 0 && messages.children.length === 0) {
      const welcomeMessage = document.createElement("div");
      welcomeMessage.className = "aichatbot-bot-message";

      const messageContent = document.createElement("div");
      messageContent.className = "aichatbot-message-content";
      messageContent.innerHTML = `<p>Hi, I'm Vivek!</p><p>I can help you with spiritual questions, finding Ananda resources, or locating centers and meditation groups near you.</p>
<p>What would you like to know?</p>`;

      welcomeMessage.appendChild(messageContent);
      messages.appendChild(welcomeMessage);
    }
  }

  // Call once on page load
  addWelcomeMessage();

  // Set placeholder text for the input field - only when no chat history exists
  function updatePlaceholder() {
    if (chatHistory.length === 0 && messages.children.length === 0) {
      input.placeholder = getRandomPlaceholder();
    }
  }

  // Stop the current streaming response
  function stopStreaming() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;

      // Reset streaming flag when manually stopped
      isStreaming = false;

      // Update clear history button state
      updateClearHistoryButton();

      return true;
    }
    return false;
  }

  // Add stop button to UI
  const stopButton = document.createElement("button");
  stopButton.id = "aichatbot-stop";
  stopButton.innerHTML = '<i class="fas fa-stop"></i>';
  stopButton.style.backgroundColor = "#FFF9C4"; // Pale yellow background
  stopButton.style.color = "#555"; // Darker text for better contrast
  stopButton.style.display = "none";
  stopButton.addEventListener("click", () => {
    stopStreaming();
    stopButton.style.display = "none";
    sendButton.style.display = "inline-block";
  });
  sendButton.parentNode.insertBefore(stopButton, sendButton.nextSibling);

  // --- NPS Survey Logic: Modal UI Start ---
  let npsModalElement = null; // Reference to the modal DOM element

  function createNpsModalHtml() {
    if (document.getElementById("nps-survey-modal")) return; // Avoid creating duplicates

    const chatWindowElement = document.getElementById("aichatbot-window");
    if (!chatWindowElement) {
      console.error("Chat window element #aichatbot-window not found. Cannot create NPS modal.");
      return;
    }

    npsModalElement = document.createElement("div");
    npsModalElement.id = "nps-survey-modal";
    npsModalElement.style.display = "none"; // Initially hidden
    npsModalElement.style.position = "absolute"; // Position relative to chat window
    npsModalElement.style.left = "50%";
    npsModalElement.style.top = "50%";
    npsModalElement.style.transform = "translate(-50%, -50%)";
    npsModalElement.style.zIndex = "10"; // Needs to be above content *within* chat window
    npsModalElement.style.backgroundColor = "white";
    npsModalElement.style.padding = "25px";
    npsModalElement.style.border = "1px solid #ccc";
    npsModalElement.style.borderRadius = "8px";
    npsModalElement.style.boxShadow = "0 4px 15px rgba(0,0,0,0.2)";
    npsModalElement.style.maxWidth = "450px";
    npsModalElement.style.width = "90%";
    npsModalElement.style.textAlign = "center";

    npsModalElement.innerHTML = `
      <h3 style="margin-top: 0; margin-bottom: 15px; font-size: 1.1em; color: #333;">Feedback Request</h3>
      <p style="margin-bottom: 15px; font-size: 0.95em; color: #555;">
        On a scale of 0-10, how likely are you to recommend this chatbot to a friend or colleague?
      </p>
      <div id="nps-score-options" style="display: flex; justify-content: center; flex-wrap: wrap; gap: 5px; margin-bottom: 20px;">
        ${[...Array(11).keys()]
          .map(
            (score) =>
              `<button class="nps-score-btn" data-score="${score}" style="border: 1px solid #ccc; background: #f9f9f9; padding: 8px 12px; border-radius: 4px; cursor: pointer; min-width: 40px; transition: background-color 0.2s, border-color 0.2s;">${score}</button>`
          )
          .join("")}
      </div>
      <p style="margin-top: 5px; margin-bottom: 15px; font-size: 0.8em; color: #999;">0 = Not at all likely, 10 = Extremely likely</p>
      <p style="margin-bottom: 5px; font-size: 0.9em; color: #555; text-align: left;">Optional: What's the main reason for your score?</p>
      <textarea id="nps-feedback" placeholder="Your feedback helps us improve..." style="width: 100%; height: 80px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9em; margin-bottom: 20px; box-sizing: border-box;"></textarea>
      <div id="nps-buttons" style="display: flex; justify-content: space-between; gap: 10px;">
        <button id="nps-submit" style="background-color: #4CAF50; color: white; padding: 10px 15px; border: none; border-radius: 4px; cursor: pointer; flex-grow: 1; opacity: 0.5; pointer-events: none;">Submit</button>
        <button id="nps-ask-later" style="background-color: #f0f0f0; color: #333; padding: 10px 15px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;">Ask Me Later</button>
        <button id="nps-no-thanks" style="background-color: #f0f0f0; color: #333; padding: 10px 15px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;">No Thanks</button>
      </div>
      <div id="nps-message-area" style="margin-top: 15px; padding: 10px; border-radius: 4px; display: none; font-weight: bold;"></div>
    `;

    // Append inside chat window
    chatWindowElement.appendChild(npsModalElement);

    // Add event listeners (we'll define these functions later)
    setupNpsModalEventListeners();
  }

  function setupNpsModalEventListeners() {
    if (!npsModalElement) return;

    let selectedScore = -1;

    const scoreButtons = npsModalElement.querySelectorAll(".nps-score-btn");
    const submitButton = npsModalElement.querySelector("#nps-submit");
    const askLaterButton = npsModalElement.querySelector("#nps-ask-later");
    const noThanksButton = npsModalElement.querySelector("#nps-no-thanks");
    const feedbackInput = npsModalElement.querySelector("#nps-feedback");

    scoreButtons.forEach((button) => {
      button.addEventListener("click", () => {
        selectedScore = parseInt(button.dataset.score, 10);
        scoreButtons.forEach((btn) => {
          btn.style.backgroundColor = "#f9f9f9";
          btn.style.borderColor = "#ccc";
          btn.style.fontWeight = "normal";
        });
        button.style.backgroundColor = "#e0e0e0";
        button.style.borderColor = "#aaa";
        button.style.fontWeight = "bold";
        submitButton.style.opacity = "1";
        submitButton.style.pointerEvents = "auto";
      });
    });

    submitButton.addEventListener("click", async () => {
      if (selectedScore >= 0) {
        await handleNpsSubmit(selectedScore, feedbackInput.value);
      }
    });

    askLaterButton.addEventListener("click", () => {
      handleNpsDismiss("later");
      hideNpsSurveyModal();
    });

    noThanksButton.addEventListener("click", () => {
      handleNpsDismiss("no_thanks");
      hideNpsSurveyModal();
    });
  }

  function showNpsSurveyModal() {
    if (npsModalElement) {
      // Reset state before showing
      const formContent = npsModalElement.querySelectorAll("h3, p, #nps-score-options, #nps-feedback, #nps-buttons");
      const scoreButtons = npsModalElement.querySelectorAll(".nps-score-btn");
      const submitButton = npsModalElement.querySelector("#nps-submit");
      const feedbackInput = npsModalElement.querySelector("#nps-feedback");
      const messageArea = npsModalElement.querySelector("#nps-message-area");

      // Ensure form content is visible and message area is hidden
      formContent.forEach((el) => (el.style.display = "")); // Reset display
      messageArea.style.display = "none";
      messageArea.textContent = "";

      scoreButtons.forEach((btn) => {
        btn.style.backgroundColor = "#f9f9f9";
        btn.style.borderColor = "#ccc";
        btn.style.fontWeight = "normal";
      });
      submitButton.style.opacity = "0.5";
      submitButton.style.pointerEvents = "none";
      feedbackInput.value = "";

      npsModalElement.style.display = "block";
    }
  }

  function hideNpsSurveyModal() {
    if (npsModalElement) {
      npsModalElement.style.display = "none";
    }
  }

  // Placeholder functions for submit/dismiss actions (to be implemented later)
  async function handleNpsSubmit(score, feedback) {
    const timestamp = new Date().toISOString();
    const payload = {
      uuid: npsUserUuid,
      score: score,
      feedback: feedback || "", // Ensure feedback is at least an empty string
      additionalComments: "", // Add if needed later
      timestamp: timestamp,
    };

    const messageArea = npsModalElement?.querySelector("#nps-message-area");
    const formContent = npsModalElement?.querySelectorAll("h3, p, #nps-score-options, #nps-feedback, #nps-buttons");

    // Disable buttons during submission
    const buttons = npsModalElement?.querySelectorAll("button");
    if (buttons) buttons.forEach((btn) => (btn.disabled = true));

    try {
      // Ensure aichatbotData and vercelUrl are available
      if (!window.aichatbotData || !window.aichatbotData.vercelUrl) {
        throw new Error("Chatbot configuration (vercelUrl) is missing.");
      }
      // Construct the full API endpoint URL for NPS
      // Assumes NPS API route is at the same origin as the main chat URL
      let npsApiUrl;
      try {
        const baseUrl = new URL(window.aichatbotData.vercelUrl).origin;
        npsApiUrl = `${baseUrl}${API_PATHS.NPS}`;
      } catch (urlError) {
        console.error("Invalid vercelUrl format:", window.aichatbotData.vercelUrl);
        throw new Error("Could not construct API URL from configuration.");
      }

      const response = await window.aichatbotAuth.fetchWithAuth(
        npsApiUrl, // Use the constructed full URL for NPS submission
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})); // Try to get JSON error
        throw new Error(`API Error (${response.status}): ${errorData.message || response.statusText}`);
      }

      // Success: Update state and localStorage
      const now = Date.now();
      npsLastSurveyTimestamp = now;
      npsLastSurveyQueryCount = npsQueryCount; // Record count *at time of submission*
      setLocalStorageItem("npsLastSurveyTimestamp", npsLastSurveyTimestamp);
      setLocalStorageItem("npsLastSurveyQueryCount", npsLastSurveyQueryCount);
      // Set dismiss reason to 'submitted'
      npsDismissReason = "submitted";
      setLocalStorageItem("npsDismissReason", npsDismissReason);

      // Track the NPS survey submission
      trackNPSSurveySubmit(score, feedback);

      // Show success message and hide form
      if (messageArea && formContent) {
        messageArea.textContent = "Thank you for your feedback!";
        messageArea.style.backgroundColor = "#d4edda"; // Light green
        messageArea.style.color = "#155724"; // Dark green
        messageArea.style.display = "block";
        formContent.forEach((el) => (el.style.display = "none"));
        // Automatically hide modal after a delay
        setTimeout(() => {
          hideNpsSurveyModal();
          // Re-enable buttons when hiding
          if (buttons) buttons.forEach((btn) => (btn.disabled = false));
        }, 2500); // Hide after 2.5 seconds
      }
    } catch (error) {
      console.error("Error submitting NPS survey:", error);
      // Show error message
      if (messageArea) {
        // Check for the specific "one survey per month" rate limit error
        if (error.message && error.message.includes("You can only submit one survey per month")) {
          messageArea.textContent = "You can only submit one survey per month.";

          // Treat this rate limit error as a completed survey for tracking purposes
          const now = Date.now();
          npsLastSurveyTimestamp = now;
          npsLastSurveyQueryCount = npsQueryCount;
          setLocalStorageItem("npsLastSurveyTimestamp", npsLastSurveyTimestamp);
          setLocalStorageItem("npsLastSurveyQueryCount", npsLastSurveyQueryCount);
          // Also mark as 'submitted' if rate limited
          npsDismissReason = "submitted";
          setLocalStorageItem("npsDismissReason", npsDismissReason);
        } else {
          messageArea.textContent = "Error submitting survey. Please try again later.";
        }
        messageArea.style.backgroundColor = "#f8d7da"; // Light red
        messageArea.style.color = "#721c24"; // Dark red
        messageArea.style.display = "block";

        // Add acknowledge button
        const acknowledgeButton = document.createElement("button");
        acknowledgeButton.textContent = "OK";
        acknowledgeButton.style.marginTop = "10px";
        acknowledgeButton.style.padding = "5px 15px";
        acknowledgeButton.style.backgroundColor = "#f0f0f0";
        acknowledgeButton.style.border = "1px solid #ccc";
        acknowledgeButton.style.borderRadius = "4px";
        acknowledgeButton.style.cursor = "pointer";

        // Add click handler to close modal when button is clicked
        acknowledgeButton.addEventListener("click", () => {
          hideNpsSurveyModal();
        });

        // Append button to message area
        messageArea.appendChild(document.createElement("br"));
        messageArea.appendChild(acknowledgeButton);
      }

      // Re-enable form buttons
      if (buttons) {
        buttons.forEach((btn) => {
          // Keep submit button disabled to prevent multiple submissions
          if (btn.id !== "nps-submit") {
            btn.disabled = false;
          }
        });
      }
    }
  }

  function handleNpsDismiss(reason) {
    console.log(`NPS Dismissed: Reason=${reason}`);
    if (reason === "later" || reason === "no_thanks") {
      // Set timestamp to now for the 3-day cooldown start
      const now = Date.now();
      npsLastSurveyTimestamp = now;
      setLocalStorageItem("npsLastSurveyTimestamp", npsLastSurveyTimestamp);

      // Set the dismiss reason
      npsDismissReason = reason;
      setLocalStorageItem("npsDismissReason", npsDismissReason);

      // IMPORTANT: Do NOT update npsLastSurveyQueryCount here.
      // This ensures the 5-query threshold only applies after a 'submitted' event.

      // Track the NPS survey dismissal
      trackNPSSurveyDismiss(reason);
    }
    // Hide modal (already handled by listener calling this).
  }

  // --- NPS Survey Logic: Modal UI End ---

  // --- NPS Survey Logic: Modal Creation Call ---
  createNpsModalHtml();
  // --- NPS Survey Logic: Modal Creation Call End ---

  // Track votes
  // let votes = {}; // moved to top of file

  // Add vote buttons to bot message
  function addVoteButtons(botMessage, messageId, hidden = false) {
    const voteButtons = document.createElement("div");
    voteButtons.className = "aichatbot-vote-buttons";

    // If hidden is true, hide buttons until streaming is complete
    if (hidden) {
      voteButtons.style.visibility = "hidden";
    }

    const upvoteButton = document.createElement("button");
    upvoteButton.className = "aichatbot-vote-button";
    upvoteButton.innerHTML = '<i class="fas fa-thumbs-up"></i>';

    const downvoteButton = document.createElement("button");
    downvoteButton.className = "aichatbot-vote-button";
    downvoteButton.innerHTML = '<i class="fas fa-thumbs-down"></i>';

    // Add event listeners
    upvoteButton.addEventListener("click", () => handleVote(messageId, true));
    downvoteButton.addEventListener("click", () => handleVote(messageId, false));

    voteButtons.appendChild(upvoteButton);
    voteButtons.appendChild(downvoteButton);
    botMessage.appendChild(voteButtons);

    // Update button states based on current vote
    updateVoteButtonStates(messageId, upvoteButton, downvoteButton);
  }

  // Handle voting
  async function handleVote(messageId, isUpvote) {
    try {
      // If messageId is empty, the message is still being generated
      if (!messageId) {
        console.log("Can't vote yet - message is still being generated");
        return;
      }

      const currentVote = votes[messageId] || 0;
      let newVote;
      let isUpvoteAction = false; // Flag to track if this is an upvote action

      if (isUpvote) {
        // Toggle between 1 and 0
        newVote = currentVote === 1 ? 0 : 1;
        isUpvoteAction = newVote === 1; // Only animate when voting *up*
      } else {
        if (currentVote === -1) {
          // If already downvoted, clear the vote
          newVote = 0;
        } else {
          // Show feedback modal for downvote
          showFeedbackModal(messageId);
          return; // Exit early, feedback modal handles the rest
        }
      }

      // Find the specific bot message UI element
      const botMessage = document.querySelector(`[data-doc-id="${messageId}"]`);
      const upvoteButton = botMessage?.querySelector(".aichatbot-vote-button:first-child");
      const downvoteButton = botMessage?.querySelector(".aichatbot-vote-button:last-child");

      // Make API call to record vote using the auth helper
      const response = await window.aichatbotAuth.fetchWithAuth(`${getBaseUrl()}${API_PATHS.VOTE}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          docId: messageId,
          vote: newVote,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to record vote");
      }

      // Update local state
      votes[messageId] = newVote;

      // Update UI (button states)
      if (upvoteButton && downvoteButton) {
        updateVoteButtonStates(messageId, upvoteButton, downvoteButton);
      }

      // Trigger animation ONLY on successful upvote (transition to voted state)
      if (isUpvoteAction && upvoteButton) {
        upvoteButton.classList.add("upvote-success-animation");
        // Remove the class after the animation duration (500ms)
        setTimeout(() => {
          upvoteButton.classList.remove("upvote-success-animation");
        }, 500);
      }
    } catch (error) {
      console.error("Error handling vote:", error);
      // Show error message to user
      const errorMessage = document.createElement("div");
      errorMessage.className = "aichatbot-error-message";
      errorMessage.textContent = "Failed to record vote. Please try again.";
      messages.appendChild(errorMessage);
      setTimeout(() => {
        if (messages.contains(errorMessage)) {
          messages.removeChild(errorMessage);
        }
      }, 3000);
    }
  }

  // Update vote button states
  function updateVoteButtonStates(messageId, upvoteButton, downvoteButton) {
    const currentVote = votes[messageId] || 0;

    upvoteButton.classList.toggle("voted", currentVote === 1);
    downvoteButton.classList.toggle("downvoted", currentVote === -1);
  }

  // Show feedback modal
  function showFeedbackModal(messageId) {
    // Create modal if it doesn't exist
    let modal = document.querySelector(".aichatbot-feedback-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.className = "aichatbot-feedback-modal";
      modal.innerHTML = `
        <div class="modal-content">
          <h3>Help us improve</h3>
          <form class="feedback-form">
            <div class="feedback-reason">
              <label>
                <input type="radio" name="reason" value="Incorrect Information">
                Incorrect Information
              </label>
              <label>
                <input type="radio" name="reason" value="Off-Topic Response">
                Off-Topic Response
              </label>
              <label>
                <input type="radio" name="reason" value="Bad Links">
                Bad Links
              </label>
              <label>
                <input type="radio" name="reason" value="Vague or Unhelpful">
                Vague or Unhelpful
              </label>
              <label>
                <input type="radio" name="reason" value="Technical Issue">
                Technical Issue
              </label>
              <label>
                <input type="radio" name="reason" value="Poor Style or Tone">
                Poor Style or Tone
              </label>
              <label>
                <input type="radio" name="reason" value="Other">
                Other
              </label>
            </div>
            <textarea placeholder="Additional comments (optional)"></textarea>
            <div class="error-message"></div>
            <div class="feedback-buttons">
              <button type="button" class="cancel-button">Cancel</button>
              <button type="submit" class="submit-button">Submit</button>
            </div>
          </form>
        </div>
      `;
      const chatWindowElement = document.getElementById("aichatbot-window");
      if (chatWindowElement) {
        chatWindowElement.appendChild(modal);
      } else {
        console.error("Chat window element #aichatbot-window not found. Cannot append feedback modal.");
        return;
      }

      // Add event listeners
      const form = modal.querySelector(".feedback-form");
      const cancelButton = modal.querySelector(".cancel-button");

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        await submitFeedback(messageId, modal);
      });

      cancelButton.addEventListener("click", () => {
        modal.style.display = "none";
      });
    }

    // Reset form
    const form = modal.querySelector(".feedback-form");
    form.reset();
    modal.querySelector(".error-message").style.display = "none";

    // Show modal
    modal.style.display = "flex";
  }

  // Submit feedback
  async function submitFeedback(messageId, modal) {
    const form = modal.querySelector(".feedback-form");
    const errorMessage = modal.querySelector(".error-message");
    const selectedReason = form.querySelector('input[name="reason"]:checked');
    const comment = form.querySelector("textarea").value.trim();
    const submitButton = form.querySelector(".submit-button");
    const cancelButton = form.querySelector(".cancel-button");
    const formElements = modal.querySelectorAll(".feedback-reason, textarea, .feedback-buttons");
    const modalTitle = modal.querySelector("h3"); // Get the title element

    // Disable buttons during submission
    submitButton.disabled = true;
    cancelButton.disabled = true;
    errorMessage.style.display = "none"; // Clear previous error messages
    errorMessage.classList.remove("success"); // Ensure success class is removed initially

    try {
      if (!selectedReason) {
        throw new Error("Please select a reason for your feedback");
      }

      // Make API call to submit feedback using the auth helper
      const response = await window.aichatbotAuth.fetchWithAuth(`${getBaseUrl()}${API_PATHS.VOTE}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          docId: messageId,
          vote: -1, // Downvote
          reason: selectedReason.value,
          comment: comment,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: "Failed to submit feedback" }));
        throw new Error(errorData.message || "Failed to submit feedback");
      }

      // Update local state
      votes[messageId] = -1;

      // Update UI (vote buttons)
      const botMessage = document.querySelector(`[data-doc-id="${messageId}"]`);
      if (botMessage) {
        const upvoteButton = botMessage.querySelector(".aichatbot-vote-button:first-child");
        const downvoteButton = botMessage.querySelector(".aichatbot-vote-button:last-child");
        updateVoteButtonStates(messageId, upvoteButton, downvoteButton);
      }

      // Show success message and hide form
      errorMessage.textContent = "Thanks for your feedback!";
      errorMessage.classList.add("success");
      errorMessage.style.display = "block";
      formElements.forEach((el) => (el.style.display = "none"));
      if (modalTitle) modalTitle.style.display = "none"; // Hide the title on success

      // Close modal automatically after 2 seconds
      setTimeout(() => {
        modal.style.display = "none";
        // Reset modal for next use (show form, hide message, re-enable buttons)
        formElements.forEach((el) => (el.style.display = "")); // Use empty string to reset to default display
        errorMessage.style.display = "none";
        errorMessage.classList.remove("success");
        if (modalTitle) modalTitle.style.display = ""; // Restore the title display
        submitButton.disabled = false;
        cancelButton.disabled = false;
      }, 2000);
    } catch (error) {
      console.error("Error submitting feedback:", error);
      errorMessage.textContent = error.message;
      errorMessage.classList.remove("success"); // Ensure no success style on error
      errorMessage.style.display = "block";
      // Re-enable buttons on error
      if (modalTitle) modalTitle.style.display = ""; // Ensure title is visible on error too
      submitButton.disabled = false;
      cancelButton.disabled = false;
    }
  }

  // Modify the bot message creation to include vote buttons with the right ID
  function createBotMessage(message) {
    const botMessage = document.createElement("div");
    botMessage.className = "aichatbot-bot-message";

    // We'll use a message-id attribute for local tracking
    const localMessageId = generateUUID();
    botMessage.setAttribute("data-message-id", localMessageId);

    // But we don't set data-doc-id yet - that will come from the server response
    // botMessage.setAttribute('data-doc-id', ''); // Don't set this yet

    const messageContent = document.createElement("div");
    messageContent.className = "aichatbot-message-content";
    messageContent.innerHTML = renderMarkdown(message);

    botMessage.appendChild(messageContent);

    // We'll add vote buttons when the stream is complete
    return botMessage;
  }

  // Add global keyboard listeners
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const isInputFocused = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    // Handle '/' key to open chat
    if (e.key === "/" && !isInputFocused) {
      if (chatWindow.style.display === "none") {
        e.preventDefault(); // Prevent default browser behavior (e.g., quick find)
        trackKeyboardShortcutOpen(); // Track the keyboard shortcut usage

        // Open the chatbot window directly (don't simulate bubble click to avoid double tracking)
        chatWindow.style.display = "flex";
        document.body.classList.add("aichatbot-window-open");
        setTimeout(() => input.focus(), 0);
        setTimeout(() => {
          messages.scrollTop = messages.scrollHeight;
        }, 0);
        addWelcomeMessage();
        if (chatHistory.length > 0) {
          input.placeholder = "";
        } else {
          input.placeholder = getRandomPlaceholder();
        }
        saveChatState();
      }
    }

    // Handle 'Escape' key to close chat
    if (e.key === "Escape") {
      if (chatWindow.style.display === "flex") {
        // Check if any modal is open within the chat window
        const feedbackModal = chatWindow.querySelector(".aichatbot-feedback-modal");
        const npsModal = chatWindow.querySelector("#nps-survey-modal");
        const languageModal = chatWindow.querySelector(".aichatbot-language-modal");

        // Close modals first if they are open
        if (feedbackModal && feedbackModal.style.display === "flex") {
          feedbackModal.style.display = "none";
        } else if (npsModal && npsModal.style.display === "block") {
          hideNpsSurveyModal(); // Use existing function for NPS modal
        } else if (languageModal && languageModal.style.display === "flex") {
          languageModal.style.display = "none";
        } else {
          // If no modals are open, close the chat window
          chatWindow.style.display = "none";
          document.body.classList.remove("aichatbot-window-open");
          trackPopupClose("escape_key");
          saveChatState();
        }
      }
    }
  });

  // Function to trigger recurring attention animation
  function startAttentionAnimation() {
    const bubble = document.getElementById("aichatbot-bubble");
    if (!bubble) return;

    // Be sure that at least 10 seconds have passed (might be a bit more, it depends on page load time)
    setTimeout(() => {
      // Disable initial animations by adding a class
      bubble.classList.add("initial-animations-complete");
    }, 10000);

    // Start the recurring animation after initial animations complete (roughly 12 seconds)
    setTimeout(() => {
      // Function to play animation
      const playAnimation = () => {
        // Only play if window is not visible
        if (
          !document.getElementById("aichatbot-window") ||
          document.getElementById("aichatbot-window").style.display === "none"
        ) {
          bubble.classList.add("pulse-animation");
          // Remove the class after animation completes to allow replay
          setTimeout(() => {
            bubble.classList.remove("pulse-animation");
          }, 8000); // 4 iterations of the animation
        }
      };

      // Play first instance
      playAnimation();
      // Set interval for every 60 seconds (production)
      const animationInterval = setInterval(playAnimation, 60000);

      // Store the interval ID on the bubble element so we can clear it later if needed
      bubble.dataset.animationIntervalId = animationInterval;
    }, 60000); // First animation after 60 seconds (production)
  }

  // Function to stop the attention animation if needed
  function stopAttentionAnimation() {
    const bubble = document.getElementById("aichatbot-bubble");
    if (!bubble) return;

    const intervalId = bubble.dataset.animationIntervalId;
    if (intervalId) {
      clearInterval(parseInt(intervalId));
      delete bubble.dataset.animationIntervalId;
    }
    // Also remove the animation class in case it's currently running
    bubble.classList.remove("magnetic-ripple-animation-big");
  }

  // Call startAttentionAnimation when the page loads, after bubble is created
  window.addEventListener("load", () => {
    setTimeout(startAttentionAnimation, 1000); // Small delay to ensure bubble is rendered
  });

  // Stop animation when window is opened, restart when closed
  function setupAnimationToggle() {
    const bubble = document.getElementById("aichatbot-bubble");
    const chatbotWindow = document.getElementById("aichatbot-window");
    if (!bubble || !chatbotWindow) return;

    // Stop animation when window opens
    chatbotWindow.addEventListener("transitionstart", () => {
      if (chatbotWindow.style.display !== "none" && !chatbotWindow.classList.contains("hidden")) {
        stopAttentionAnimation();
      }
    });

    // Restart animation when window closes
    chatbotWindow.addEventListener("transitionend", () => {
      if (chatbotWindow.classList.contains("hidden")) {
        startAttentionAnimation();
      }
    });
  }

  // Call setup function after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupAnimationToggle);
  } else {
    setupAnimationToggle();
  }

  // Search Results Bubble Functionality
  function createSearchBubble() {
    const existingBubble = document.getElementById("aichatbot-search-bubble");
    if (existingBubble) {
      return existingBubble;
    }

    const searchBubble = document.createElement("div");
    searchBubble.id = "aichatbot-search-bubble";
    searchBubble.className = "aichatbot-search-bubble";
    searchBubble.innerHTML = `
      <div class="aichatbot-search-bubble-content">
        <div class="aichatbot-search-bubble-text">
          You can also talk to Vivek to get your question answered!
        </div>
        <div class="aichatbot-search-bubble-arrow"></div>
      </div>
    `;

    // Add click handler to open chatbot
    searchBubble.addEventListener("click", () => {
      if (chatWindow.style.display === "none") {
        bubble.click(); // Trigger the existing bubble click handler
      }
      hideSearchBubble();
    });

    document.body.appendChild(searchBubble);
    return searchBubble;
  }

  function showSearchBubble() {
    if (searchBubbleVisible) return;

    const searchBubble = createSearchBubble();
    searchBubble.classList.add("visible");
    searchBubbleVisible = true;

    // Auto-hide after 10 seconds
    setTimeout(() => {
      hideSearchBubble();
    }, 10000);
  }

  function hideSearchBubble() {
    const searchBubble = document.getElementById("aichatbot-search-bubble");
    if (searchBubble) {
      searchBubble.classList.remove("visible");
      searchBubbleVisible = false;
    }
  }

  function checkScrollPosition() {
    // Check if we're 50% down the page (to account for large footer)
    const scrollPosition = window.scrollY;
    const windowHeight = window.innerHeight;
    const documentHeight = document.body.scrollHeight;
    const scrollPercentage = (scrollPosition + windowHeight) / documentHeight;

    if (scrollPercentage >= 0.5) {
      // 50% of the way down
      if (!searchBubbleVisible) {
        showSearchBubble();
      }
    } else {
      if (searchBubbleVisible) {
        hideSearchBubble();
      }
    }
  }

  // Enhanced search page detection
  function isSearchPage() {
    // Check server-side detection first
    if (aichatbotData.isSearchPage === "1") {
      return true;
    }

    // Client-side detection for hash-based search pages
    const currentUrl = window.location.href;
    const currentPath = window.location.pathname;
    const currentHash = window.location.hash;

    // Check for /search/ in path
    if (currentPath.includes("/search")) {
      return true;
    }

    // Check for search parameters in hash (like #stq=searchterm)
    if (currentHash.includes("stq=") || currentHash.includes("search")) {
      return true;
    }

    return false;
  }

  // Initialize search results bubble functionality
  function initSearchBubble() {
    // Only run on search pages (enhanced detection)
    if (!isSearchPage()) {
      return;
    }

    // Add scroll listener with throttling
    let scrollTimeout;
    window.addEventListener("scroll", () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(checkScrollPosition, 100);
    });

    // Check initial position
    setTimeout(checkScrollPosition, 1000); // Wait for page to fully load
  }

  /**
   * Send error email to administrators via AJAX
   * @param {Error} error - The error object
   * @param {string} errorType - Type of error (e.g., "API Error", "Test error")
   * @param {string} userMessage - The user's message that triggered the error
   */
  async function sendErrorEmail(error, errorType, userMessage) {
    try {
      // Check if we have the AJAX URL available
      if (!aichatbotData || !aichatbotData.ajaxUrl) {
        console.error("AJAX URL not available for sending error email");
        return;
      }

      const errorData = {
        action: "aichatbot_send_error_email",
        error_type: errorType,
        error_message: error.message,
        error_stack: error.stack || "",
        user_message: userMessage,
        user_agent: navigator.userAgent,
        current_url: window.location.href,
        timestamp: new Date().toISOString(),
        chat_history_count: chatHistory.length,
      };

      const response = await fetch(aichatbotData.ajaxUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(errorData),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          console.log("Error email sent successfully to administrators");
        } else {
          console.error("Failed to send error email:", result.data?.message || "Unknown error");
        }
      } else {
        console.error("Failed to send error email - HTTP error:", response.status);
      }
    } catch (emailError) {
      console.error("Error sending error email:", emailError);
    }
  }

  // Initialize search bubble functionality
  initSearchBubble();
});
