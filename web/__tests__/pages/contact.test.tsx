import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Contact from "@/pages/contact";
import { SiteConfig } from "@/types/siteConfig";
import * as tokenManager from "@/utils/client/tokenManager";

// Mock Next.js router
const mockPush = jest.fn();
const mockQuery: { mode?: string } = {};
jest.mock("next/router", () => ({
  useRouter: () => ({
    push: mockPush,
    query: mockQuery,
    pathname: "/contact",
  }),
}));

// Mock SudoContext
const SudoProviderMock = ({ children }: { children: React.ReactNode }) => (
  <div data-testid="sudo-provider">{children}</div>
);
jest.mock("@/contexts/SudoContext", () => ({
  SudoProvider: SudoProviderMock,
  useSudo: () => ({
    errorMessage: null,
    setErrorMessage: jest.fn(),
  }),
}));

// Mock token manager
jest.mock("@/utils/client/tokenManager", () => ({
  getToken: jest.fn(),
}));

// Mock fetch for profile API
global.fetch = jest.fn();

// Mock Layout component to avoid provider issues
jest.mock("@/components/layout", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

const mockSiteConfig: SiteConfig = {
  siteId: "ananda",
  shortname: "Luca",
  name: "Luca, The Ananda Devotee Chatbot",
  tagline: "Explore, Discover, Learn",
  greeting: "Hi GuruBuddy! I'm Luca.",
  emailGreeting: "Hi GuruBuddy!",
  welcome_popup_heading: "Welcome, Gurubhai!",
  other_visitors_reference: "your Gurubhais",
  chatPlaceholder: "How can I meditate more deeply?",
  allowedFrontEndDomains: ["localhost:3000"],
  help_url: "",
  help_text: "Help",
  collectionConfig: {
    master_swami: "Master and Swami",
    whole_library: "All authors",
  },
  includedLibraries: ["Ananda Library"],
  libraryMappings: {},
  enableSuggestedQueries: true,
  enableMediaTypeSelection: true,
  enableAuthorSelection: true,
  requireLogin: true,
  allowTemporarySessions: true,
  allowAllAnswersPage: true,
  loginImage: "mascot.png",
  header: { logo: "ananda-logo.png", navItems: [] },
  footer: { links: [] },
  queriesPerUserPerDay: 200,
  enableModelComparison: true,
  showSourceCountSelector: true,
  temperature: 0.4,
  modelName: "gpt-4o",
  enableGeoAwareness: true,
  feedbackIcon: "mascot.png",
  parent_site_url: "https://www.ananda.org",
  parent_site_name: "Ananda",
  showSourceContent: true,
  showVoting: true,
};

const mockSiteConfigNoLogin: SiteConfig = {
  ...mockSiteConfig,
  requireLogin: false,
};

describe("Contact Page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockClear();
    (global.fetch as jest.Mock).mockReset();
    (tokenManager.getToken as jest.Mock).mockReset();
  });

  describe("Contact Mode", () => {
    beforeEach(() => {
      // Set router to contact mode (default)
      mockQuery.mode = undefined;
    });

    it("renders contact form with correct title", () => {
      render(<Contact siteConfig={mockSiteConfig} />);

      expect(screen.getByText("Contact Us")).toBeInTheDocument();
      expect(screen.queryByText(/constantly striving to improve/i)).not.toBeInTheDocument();
    });

    it("shows correct form labels for contact mode", () => {
      render(<Contact siteConfig={mockSiteConfig} />);

      expect(screen.getByText("Message")).toBeInTheDocument();
      expect(screen.getByText("Send")).toBeInTheDocument();
    });

    it("shows success message for contact mode", async () => {
      // Mock successful form submission
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ message: "Message sent successfully" }),
      });

      render(<Contact siteConfig={mockSiteConfig} />);

      // Fill out form
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Test message" } });

      // Submit form
      fireEvent.click(screen.getByText("Send"));

      await waitFor(() => {
        expect(screen.getByText("Thanks, message sent!")).toBeInTheDocument();
      });
    });
  });

  describe("Auto-fill functionality", () => {
    beforeEach(() => {
      mockQuery.mode = undefined;
    });

    it("auto-fills user data for logged-in users on login-required sites", async () => {
      // Mock token and profile response
      (tokenManager.getToken as jest.Mock).mockResolvedValue("mock-token");

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            firstName: "John",
            lastName: "Doe",
            email: "john@example.com",
          }),
      });

      render(<Contact siteConfig={mockSiteConfig} />);

      await waitFor(() => {
        const nameInput = screen.getByLabelText("Name");
        const emailInput = screen.getByLabelText("Email");

        expect(nameInput).toHaveValue("John Doe");
        expect(emailInput).toHaveValue("john@example.com");

        // Check that fields are read-only (not disabled) to prevent password manager interference
        expect(nameInput).toHaveAttribute("readOnly");
        expect(emailInput).toHaveAttribute("readOnly");

        // Check that fields have grayed-out styling
        expect(nameInput).toHaveClass("bg-gray-100", "text-gray-500", "cursor-not-allowed");
        expect(emailInput).toHaveClass("bg-gray-100", "text-gray-500", "cursor-not-allowed");
      });
    });

    it("does not auto-fill on sites without login requirement", async () => {
      (tokenManager.getToken as jest.Mock).mockResolvedValue(null);

      render(<Contact siteConfig={mockSiteConfigNoLogin} />);

      await waitFor(() => {
        const nameInput = screen.getByLabelText("Name");
        const emailInput = screen.getByLabelText("Email");

        expect(nameInput).toHaveValue("");
        expect(emailInput).toHaveValue("");
        expect(nameInput).not.toBeDisabled();
        expect(emailInput).not.toBeDisabled();
      });
    });

    it("handles name concatenation correctly without double spaces", async () => {
      // Mock token and profile response with only first name
      (tokenManager.getToken as jest.Mock).mockResolvedValue("mock-token");

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            firstName: "John",
            lastName: "", // Empty last name
            email: "john@example.com",
          }),
      });

      render(<Contact siteConfig={mockSiteConfig} />);

      await waitFor(() => {
        const nameInput = screen.getByLabelText("Name");
        expect(nameInput).toHaveValue("John"); // Should not have trailing space
      });
    });
  });

  describe("Form validation", () => {
    beforeEach(() => {
      mockQuery.mode = undefined;
      // Mock getToken to return null for validation tests
      (tokenManager.getToken as jest.Mock).mockResolvedValue(null);
    });

    it("validates required fields", async () => {
      render(<Contact siteConfig={mockSiteConfig} />);

      // Try to submit form with empty name
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Test message" } });

      fireEvent.submit(screen.getByTestId("contact-form"));

      await waitFor(() => {
        expect(screen.getByText("Name must be between 1 and 100 characters")).toBeInTheDocument();
      });
    });

    it("validates email format", async () => {
      render(<Contact siteConfig={mockSiteConfig} />);

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "invalid-email" } });
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Test message" } });

      fireEvent.submit(screen.getByTestId("contact-form"));

      await waitFor(() => {
        expect(screen.getByText("Invalid email address")).toBeInTheDocument();
      });
    });
  });
});
