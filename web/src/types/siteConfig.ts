export interface HeaderConfig {
  logo: string;
  navItems: Array<{ label: string; path: string }>;
}

export interface FooterConfig {
  links: Array<{
    label: string;
    url: string;
    icon?: string;
  }>;
}

export interface AccessControlLevelConfig {
  key: string;
  label: string;
  value: number;
}

export interface AccessControlConfig {
  enabled?: boolean;
  levels: AccessControlLevelConfig[];
  defaultLevel?: number;
  superuserLevel?: number;
  manualAssignmentCaps?: {
    userAdminMaxLevel?: number;
    superuserMaxLevel?: number;
  };
  salesforceOnlyLevels?: number[];
  originUrl?: string;
}

export interface SiteConfig {
  siteId: string;
  shortname: string;
  name: string;
  tagline: string;
  greeting: string;
  emailGreeting?: string;
  parent_site_url: string;
  parent_site_name: string;
  help_url: string;
  help_text: string;
  allowedFrontEndDomains?: string[]; // Array of allowed domains for CORS, supports * wildcards (e.g. "*.example.com")
  collectionConfig: {
    [key: string]: string;
  };
  libraryMappings: {
    [key: string]: {
      displayName: string;
      url: string;
    };
  };
  enableSuggestedQueries: boolean;
  enableMediaTypeSelection: boolean;
  enableAuthorSelection: boolean;
  enableTitleScopeSelection?: boolean;
  enableSearchPage?: boolean;
  welcome_popup_heading: string;
  other_visitors_reference: string;
  loginImage: string | null;
  chatPlaceholder?: string;
  header: HeaderConfig;
  footer: FooterConfig;
  requireLogin: boolean;
  allowTemporarySessions: boolean;
  allowAllAnswersPage: boolean;
  queriesPerUserPerDay: number;
  showSourceContent: boolean;
  showVoting: boolean;
  includedLibraries?: Array<string | { name: string; weight?: number }>; // Updated
  enabledMediaTypes?: ("text" | "audio" | "youtube")[];
  enableModelComparison?: boolean;
  showSourceCountSelector?: boolean;
  hideSources?: boolean;
  defaultNumSources?: number;
  temperature?: number; // Added for LLM temperature setting
  modelName?: string; // Added for LLM model selection
  showRelatedQuestions?: boolean; // Added to control visibility of related questions
  enableGeoAwareness?: boolean; // Added for geo-awareness functionality
  feedbackIcon?: string; // Site-specific feedback button icon
  redirectMappings?: {
    // Added for code-based redirect tracking
    [code: string]: {
      url: string;
      event: string;
      description: string;
    };
  };
  accessRequestNoteLabel?: string; // Label text for reference note field in access request form (deprecated, use accessRequestConfig.noteLabel)
  accessRequestConfig?: {
    noteLabel?: string; // Label text for reference note field
    showKnowsAdminQuestion?: boolean; // Show "Does this admin know you?" checkbox
    unknownAdminFields?: {
      nearestCenter?: {
        label: string;
        type: "select" | "text";
        options?: string[]; // For select type
        placeholder?: string; // For text type
        required?: boolean;
      };
      connectionHistory?: {
        label: string;
        placeholder?: string;
        required?: boolean;
      };
    };
  };
  adminAccessGuidelines?: string; // Site-specific guidelines for who can access the chatbot (shown in admin panel)
  enableNpsSurveyEmail?: boolean; // Whether to send NPS survey emails to users (requires requireLogin: true)
  enableOnboardingEmails?: boolean; // Whether to send onboarding drip emails (requires requireLogin: true)
  enableReengagementEmails?: boolean; // Whether to send re-engagement emails (requires requireLogin: true)
  enableSpecialDayEmails?: boolean; // Whether to send special day/holiday emails (requires requireLogin: true)
  enableEmailBlacklist?: boolean; // Whether login sites enforce/administer the S3-backed email blacklist
  enableWhatsNew?: boolean; // Whether this site has a whats-new.json data file
  enabledTasks?: string[]; // Array of task IDs enabled for this site (e.g., ["research", "class-planning"])
  enableSalesforceAccessNotice?: boolean; // Development-only notice for Salesforce access rollout status
  accessControl?: AccessControlConfig;
}
