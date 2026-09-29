import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Login from "@/pages/login";
import { SiteConfig } from "@/types/siteConfig";
import { fetchWithAuth } from "@/utils/client/tokenManager";

jest.mock("next/router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    isReady: true,
    query: {},
    pathname: "/login",
  }),
}));

jest.mock("@/components/AuthLayout", () => ({
  __esModule: true,
  default: ({ children, belowCard }: { children: React.ReactNode; belowCard?: React.ReactNode }) => (
    <div data-testid="auth-layout">
      {children}
      {belowCard}
    </div>
  ),
}));

jest.mock("@/components/AdminApproverSelector", () => ({
  __esModule: true,
  default: () => <div data-testid="admin-approver-selector" />,
}));

jest.mock("@/components/FeedbackModal", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

const mockSiteConfig: SiteConfig = {
  siteId: "ananda",
  shortname: "Luca",
  name: "Luca, The Ananda Devotee Chatbot",
  tagline: "Explore, Discover, Learn",
  greeting: "Greetings! I'm Luca.",
  emailGreeting: "Greetings!",
  welcome_popup_heading: "Welcome, Gurubhai!",
  other_visitors_reference: "your Gurubhais",
  chatPlaceholder: "How can I meditate more deeply?",
  allowedFrontEndDomains: ["localhost:3000"],
  parent_site_url: "https://www.ananda.org",
  parent_site_name: "Ananda",
  help_url: "",
  help_text: "Help",
  collectionConfig: {},
  includedLibraries: ["Ananda Library"],
  libraryMappings: {},
  enableSuggestedQueries: true,
  enableMediaTypeSelection: true,
  enableAuthorSelection: true,
  requireLogin: true,
  allowTemporarySessions: true,
  allowAllAnswersPage: true,
  loginImage: null,
  header: { logo: "ananda-logo.png", navItems: [] },
  footer: { links: [] },
  queriesPerUserPerDay: 200,
  showSourceContent: true,
  showVoting: true,
};

describe("Login page Voice Control accessibility", () => {
  it("exposes a named email field that Voice Control can target", () => {
    render(<Login siteConfig={mockSiteConfig} contactEmail="support@example.com" />);

    const emailInput = screen.getByRole("textbox", { name: "Email Address" });
    expect(emailInput).toBeInTheDocument();
    expect(emailInput).toHaveAttribute("id", "email-input");
    expect(emailInput).toHaveAttribute("name", "email");
    expect(emailInput).toHaveAttribute("type", "email");
    expect(emailInput).toHaveAttribute("autocomplete", "username");
    expect(emailInput).toHaveAttribute("aria-labelledby", "email-input-label");
    expect(document.getElementById("email-input-label")).toHaveAttribute("for", "email-input");
  });

  it("hides the decorative mail icon from assistive technology", () => {
    render(<Login siteConfig={mockSiteConfig} contactEmail="support@example.com" />);

    const mailIcon = screen.getByText("mail");
    expect(mailIcon).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Login page iOS/password-manager autofill", () => {
  beforeEach(() => {
    jest.mocked(fetchWithAuth).mockReset();
  });

  it("uses username autocomplete on the email field while keeping type=email", () => {
    render(<Login siteConfig={mockSiteConfig} contactEmail="support@example.com" />);

    const emailInput = screen.getByRole("textbox", { name: "Email Address" });
    expect(emailInput).toHaveAttribute("id", "email-input");
    expect(emailInput).toHaveAttribute("autocomplete", "username");
    expect(emailInput).toHaveAttribute("type", "email");
  });

  it("pairs the password field with a username-autocomplete input carrying the entered email", async () => {
    jest.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({ hasPassword: true }),
    } as Response);

    render(<Login siteConfig={mockSiteConfig} contactEmail="support@example.com" />);

    const emailInput = screen.getByRole("textbox", { name: "Email Address" });
    fireEvent.change(emailInput, { target: { value: "user@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const passwordInput = await waitFor(() => screen.getByLabelText("Password"));
    expect(passwordInput).toHaveAttribute("autocomplete", "current-password");

    const usernameInput = document.querySelector('input[name="username"][autocomplete="username"]');
    expect(usernameInput).toBeInTheDocument();
    expect(usernameInput).toHaveAttribute("type", "email");
    expect(usernameInput).toHaveValue("user@example.com");
  });
});
