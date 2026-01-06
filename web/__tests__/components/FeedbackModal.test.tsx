import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import FeedbackModal from "@/components/FeedbackModal";
import { SiteConfig } from "@/types/siteConfig";
import * as tokenManager from "@/utils/client/tokenManager";

// Mock token manager
jest.mock("@/utils/client/tokenManager", () => ({
  getToken: jest.fn(),
}));

// Mock fetch for profile API
global.fetch = jest.fn();

// Mock Modal component to avoid provider issues
jest.mock("@/components/ui/Modal", () => ({
  Modal: ({ isOpen, onClose, title, children }: any) =>
    isOpen ? (
      <div data-testid="modal">
        <div data-testid="modal-title">{title}</div>
        <button onClick={onClose} data-testid="modal-close">
          Close
        </button>
        {children}
      </div>
    ) : null,
}));

describe("FeedbackModal", () => {
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
    parent_site_url: "https://www.ananda.org",
    parent_site_name: "Ananda",
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
    showSourceContent: true,
    showVoting: true,
    enableModelComparison: true,
    showSourceCountSelector: true,
    temperature: 0.4,
    modelName: "gpt-4o",
    enableGeoAwareness: true,
    feedbackIcon: "mascot.png",
  };

  const mockSiteConfigNoLogin: SiteConfig = {
    ...mockSiteConfig,
    requireLogin: false,
  };

  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockClear();
    (global.fetch as jest.Mock).mockReset();
    (tokenManager.getToken as jest.Mock).mockReset();
  });

  it("renders modal when open", () => {
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    expect(screen.getByTestId("modal")).toBeInTheDocument();
    expect(screen.getByTestId("modal-title")).toHaveTextContent("Feedback");
    expect(screen.getByText(/constantly striving to improve/i)).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(<FeedbackModal isOpen={false} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    expect(screen.queryByTestId("modal")).not.toBeInTheDocument();
  });

  it("displays form fields with correct labels", () => {
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Your Feedback")).toBeInTheDocument();
  });

  it("shows character counter for message field", () => {
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    const textarea = screen.getByLabelText("Your Feedback");
    fireEvent.change(textarea, { target: { value: "Test message" } });

    expect(screen.getByText("12/1000 characters")).toBeInTheDocument();
  });

  it("validates required fields", async () => {
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    // Try to submit with empty name
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Your Feedback"), { target: { value: "Test feedback" } });

    // Submit the form
    fireEvent.submit(screen.getByTestId("feedback-form"));

    await waitFor(() => {
      expect(screen.getByText("Name must be between 1 and 100 characters")).toBeInTheDocument();
    });
  });

  it("validates email format", async () => {
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "invalid-email" } });
    fireEvent.change(screen.getByLabelText("Your Feedback"), { target: { value: "Test feedback" } });

    fireEvent.submit(screen.getByTestId("feedback-form"));

    await waitFor(() => {
      expect(screen.getByText("Invalid email address")).toBeInTheDocument();
    });
  });

  it("submits feedback successfully", async () => {
    // Mock token manager to return a valid token
    (tokenManager.getToken as jest.Mock).mockResolvedValue("mock-token");

    // Mock successful API response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: "Feedback sent successfully" }),
    });

    // Use site config without login requirement to avoid auto-fill complications
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfigNoLogin} />);

    // Fill out form
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Your Feedback"), { target: { value: "Test feedback" } });

    // Submit form
    fireEvent.submit(screen.getByTestId("feedback-form"));

    // Wait for success message
    await waitFor(
      () => {
        expect(screen.getByText("Thanks for your feedback!")).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // Check API call was made correctly
    expect(global.fetch).toHaveBeenCalledWith("/api/contact?mode=feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-token",
      },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Test feedback",
      }),
    });
  });

  it("auto-fills user data for logged-in users on login-required sites", async () => {
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

    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      const nameInput = screen.getByLabelText("Name");
      const emailInput = screen.getByLabelText("Email");

      expect(nameInput).toHaveValue("John Doe");
      expect(emailInput).toHaveValue("john@example.com");
      expect(nameInput).toHaveAttribute("readOnly");
      expect(emailInput).toHaveAttribute("readOnly");
    });
  });

  it("does not auto-fill on sites without login requirement", async () => {
    (tokenManager.getToken as jest.Mock).mockResolvedValue(null);

    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfigNoLogin} />);

    await waitFor(() => {
      const nameInput = screen.getByLabelText("Name");
      const emailInput = screen.getByLabelText("Email");

      expect(nameInput).toHaveValue("");
      expect(emailInput).toHaveValue("");
      expect(nameInput).not.toHaveAttribute("readOnly");
      expect(emailInput).not.toHaveAttribute("readOnly");
    });
  });

  it("resets form when modal closes", () => {
    const { rerender } = render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    // Fill out form
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText("Your Feedback"), { target: { value: "Test feedback" } });

    // Close modal
    rerender(<FeedbackModal isOpen={false} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    // Reopen modal
    rerender(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    // Form should be reset (except auto-filled fields)
    expect(screen.getByLabelText("Your Feedback")).toHaveValue("");
  });

  it("handles API errors gracefully", async () => {
    // Mock token manager to return a valid token
    (tokenManager.getToken as jest.Mock).mockResolvedValue("mock-token");

    // Mock API error response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: "Server error" }),
    });

    // Use site config without login requirement to avoid auto-fill complications
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfigNoLogin} />);

    // Fill out and submit form
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Your Feedback"), { target: { value: "Test feedback" } });

    fireEvent.submit(screen.getByTestId("feedback-form"));

    // Wait for error message
    await waitFor(
      () => {
        expect(screen.getByText("Server error")).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it("prevents closing modal while submitting", () => {
    render(<FeedbackModal isOpen={true} onClose={mockOnClose} siteConfig={mockSiteConfig} />);

    // Mock a slow API call
    (tokenManager.getToken as jest.Mock).mockResolvedValue("mock-token");
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: () => ({}) }), 1000))
    );

    // Fill out and submit form
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Your Feedback"), { target: { value: "Test feedback" } });

    fireEvent.click(screen.getByText("Send Feedback"));

    // Try to close modal while submitting
    fireEvent.click(screen.getByText("Cancel"));

    // onClose should not be called while submitting
    expect(mockOnClose).not.toHaveBeenCalled();
  });
});
