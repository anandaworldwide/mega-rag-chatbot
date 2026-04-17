import React from "react";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import NPSSurvey from "@/components/NPSSurvey";
import { SiteConfig } from "@/types/siteConfig";
// analyticsModule is mocked but not directly imported

// Mock dependencies
jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/utils/client/uuid", () => {
  const MOCK_UUID_V4 = "00000000-0000-4000-8000-000000000000";
  return {
    getOrCreateUUID: jest.fn().mockReturnValue(MOCK_UUID_V4),
  };
});

const mockFetchWithAuth = jest.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ message: "Survey submitted successfully" }),
});

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn((...args) => mockFetchWithAuth(...args)),
}));

// Mock window.location
const mockLocation = {
  href: "https://test.com",
};
Object.defineProperty(window, "location", {
  value: mockLocation,
  writable: true,
});

// Mock localStorage
const localStorageMock = (function () {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] || null),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    removeItem: jest.fn((key: string) => {
      delete store[key];
    }),
    clear: jest.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// Set up common test variables
const mockSiteConfig: SiteConfig = {
  siteId: "test",
  name: "Test Site",
  shortname: "Test",
  tagline: "Test Tagline",
  greeting: "Test Greeting",
  parent_site_url: "",
  parent_site_name: "",
  help_url: "",
  help_text: "",
  collectionConfig: {},
  libraryMappings: {},
  enableSuggestedQueries: false,
  enableMediaTypeSelection: false,
  enableAuthorSelection: false,
  welcome_popup_heading: "",
  other_visitors_reference: "test users",
  loginImage: null,
  header: { logo: "", navItems: [] },
  footer: { links: [] },
  requireLogin: true,
  allowTemporarySessions: false,
  allowAllAnswersPage: false,
  queriesPerUserPerDay: 100,
  showSourceContent: true,
  showVoting: true,
};

describe("NPSSurvey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    mockLocation.href = "https://test.com";
  });

  it("renders survey with all required elements", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("How likely are you to recommend Test to test users?")).toBeInTheDocument();
    });

    // Check score buttons (0-10)
    for (let i = 0; i <= 10; i++) {
      expect(screen.getByText(i.toString())).toBeInTheDocument();
    }

    expect(screen.getByText("What's the main reason for your score?")).toBeInTheDocument();
    expect(screen.getByText("What would make it even better? Or other comments (optional).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("displays initial score when provided from email link", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} initialScore={7} />);

    await waitFor(() => {
      // Score should be pre-selected - find the button specifically
      const scoreButtons = screen.getAllByText("7");
      const scoreButton = scoreButtons.find((btn) => btn.tagName === "BUTTON");
      expect(scoreButton).toBeDefined();
      expect(scoreButton).toHaveClass("bg-blue-500");
    });
  });

  it("allows user to change pre-selected score", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} initialScore={7} />);

    await waitFor(() => {
      // Verify initial score is selected
      const initialButtons = screen.getAllByText("7");
      const initialButton = initialButtons.find((btn) => btn.tagName === "BUTTON");
      expect(initialButton).toHaveClass("bg-blue-500");
    });

    // Click a different score - find the button specifically
    const scoreButtons = screen.getAllByText("9");
    const scoreButton = scoreButtons.find((btn) => btn.tagName === "BUTTON");
    expect(scoreButton).toBeDefined();
    fireEvent.click(scoreButton!);

    // New score should be selected
    expect(scoreButton).toHaveClass("bg-blue-500");
  });

  it("redirects when cancel button is clicked", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    const cancelButton = await waitFor(() => screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(cancelButton);

    expect(mockLocation.href).toBe("/");
  });

  it("validates form before submission - submit button disabled when no score selected", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    const submitButton = await waitFor(() => screen.getByRole("button", { name: "Submit" }));
    expect(submitButton).toBeDisabled();
  });

  it("enables submit button when score is selected", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    // Select a score
    const scoreButton = await waitFor(() => screen.getByText("8"));
    fireEvent.click(scoreButton);

    const submitButton = screen.getByRole("button", { name: "Submit" });
    expect(submitButton).not.toBeDisabled();
  });

  it("validates feedback length", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    // Select a score
    const scoreButton = await waitFor(() => screen.getByText("8"));
    fireEvent.click(scoreButton);

    // Enter feedback that's too long - find textarea by its label
    const textareas = screen.getAllByRole("textbox");
    const feedbackTextarea = textareas[0]; // First textarea is for feedback
    const longFeedback = "a".repeat(1001);
    fireEvent.change(feedbackTextarea, { target: { value: longFeedback } });

    const submitButton = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Feedback must be 1000 characters or less")).toBeInTheDocument();
    });
  });

  it("submits survey data successfully", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: "Survey submitted successfully" }),
    });

    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    // Select a score
    const scoreButton = await waitFor(() => screen.getByText("9"));
    fireEvent.click(scoreButton);

    // Enter feedback
    const feedbackTextarea = screen.getAllByRole("textbox")[0];
    fireEvent.change(feedbackTextarea, { target: { value: "Great service!" } });

    // Submit
    const submitButton = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/submitNpsSurvey",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining('"score":9'),
        })
      );
    });

    // Should show success message and redirect after delay
    await waitFor(
      () => {
        expect(screen.getByText("Thank you for your feedback!")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Check localStorage was updated
    expect(localStorageMock.setItem).toHaveBeenCalledWith("npsSurveyCompleted", expect.any(String));
  });

  it("handles API errors during submission", async () => {
    // Mock eligibility check (GET) - user can submit
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ canSubmit: true }),
    });

    // Mock submission (POST) - fails
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({}),
    });

    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    // Wait for eligibility check to complete
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    });

    // Select a score and submit
    const scoreButton = screen.getByText("5");
    fireEvent.click(scoreButton);

    const submitButton = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Error submitting survey. Please try again.")).toBeInTheDocument();
    });
  });

  it("handles network errors during submission", async () => {
    // Mock eligibility check (GET) - user can submit
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ canSubmit: true }),
    });

    // Mock submission (POST) - network error
    mockFetchWithAuth.mockRejectedValueOnce(new Error("Network error"));

    render(<NPSSurvey siteConfig={mockSiteConfig} />);

    // Wait for eligibility check to complete
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    });

    // Select a score and submit
    const scoreButton = screen.getByText("6");
    fireEvent.click(scoreButton);

    const submitButton = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submitButton);

    await waitFor(
      () => {
        expect(screen.getByText("Error submitting survey: An unexpected error occurred")).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it("displays survey form when initial score is provided", async () => {
    render(<NPSSurvey siteConfig={mockSiteConfig} initialScore={7} />);

    await waitFor(() => {
      expect(screen.getByText("How likely are you to recommend Test to test users?")).toBeInTheDocument();
    });

    // Score should be pre-selected
    const scoreButtons = screen.getAllByText("7");
    const scoreButton = scoreButtons.find((btn) => btn.tagName === "BUTTON");
    expect(scoreButton).toHaveClass("bg-blue-500");
  });
});
