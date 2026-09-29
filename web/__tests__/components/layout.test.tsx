import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import Layout from "@/components/layout";
import { SudoProvider } from "@/contexts/SudoContext";

jest.mock("next/router", () => ({
  useRouter: () => ({
    pathname: "/",
    route: "/",
    query: {},
    asPath: "/",
    push: jest.fn(),
    replace: jest.fn(),
    events: { on: jest.fn(), off: jest.fn() },
  }),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: { alt?: string }) => <span data-testid="mock-image">{props.alt}</span>,
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/utils/client/loadWhatsNew", () => ({
  isWhatsNewAvailable: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/utils/client/tokenManager", () => ({
  initializeTokenManager: jest.fn().mockResolvedValue(undefined),
  isAuthenticated: jest.fn().mockReturnValue(true),
  getToken: jest.fn().mockResolvedValue(null),
}));

const siteConfig = {
  siteId: "ananda",
  name: "Luca",
  shortname: "Luca",
  tagline: "tag",
  greeting: "Hi",
  parent_site_url: "https://www.ananda.org",
  parent_site_name: "Ananda",
  help_url: "https://example.com/help",
  help_text: "Help",
  collectionConfig: {},
  libraryMappings: {},
  requireLogin: true,
  allowTemporarySessions: false,
  allowAllAnswersPage: false,
  header: { logo: "ananda-logo.png", navItems: [] },
  footer: { links: [] },
  loginImage: "luca.png",
  feedbackIcon: "michael.jpeg",
} as any;

function renderLayout(hideMobileFooter = false) {
  return render(
    <SudoProvider disableChecks>
      <Layout siteConfig={siteConfig} hideMobileFooter={hideMobileFooter}>
        <div>Chat body</div>
      </Layout>
    </SudoProvider>
  );
}

describe("Layout mobile chat chrome", () => {
  beforeEach(() => {
    Object.defineProperty(document, "cookie", { configurable: true, writable: true, value: "hasSession=1" });
  });

  it("hides the footer on small screens and keeps Feedback in the header", async () => {
    renderLayout(true);

    const footer = await screen.findByRole("contentinfo");
    expect(footer.parentElement).toHaveClass("max-md:hidden");
    expect(footer.parentElement?.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);

    const header = screen.getByRole("banner");
    const feedback = within(header).getByRole("button", { name: "Feedback" });
    expect(feedback).toHaveClass("md:hidden");
    expect(feedback.querySelector(".material-icons")).toHaveTextContent("feedback");
    expect(feedback.textContent).not.toMatch(/^\s*Feedback\s*$/);

    const floating = document.querySelector(".fixed.bottom-6");
    expect(floating).toHaveClass("hidden", "md:block");

    fireEvent.click(feedback);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feedback" })).toBeInTheDocument();
  });

  it("keeps the footer and omits the header Feedback control when not on the mobile chat treatment", async () => {
    renderLayout(false);

    const footer = await screen.findByRole("contentinfo");
    await waitFor(() => {
      expect(screen.getByRole("banner")).toBeInTheDocument();
    });
    expect(footer.parentElement).not.toHaveClass("max-md:hidden");
    expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Feedback" })).not.toBeInTheDocument();
    expect(document.querySelector(".fixed.bottom-6")).toHaveClass("hidden", "md:block");
  });
});
