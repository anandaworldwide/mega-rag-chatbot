import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/router";
import { AdminLayout } from "@/components/AdminLayout";
import AddUsersPage from "@/pages/admin/users/add";
import type { SiteConfig } from "@/types/siteConfig";

jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock("@/contexts/SudoContext", () => ({
  SudoProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/components/Header/AnandaHeader", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/Header/AnandaPublicHeader", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/Header/JairamHeader", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/Header/CrystalHeader", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/Header/PhotoHeader", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/Footer", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/AdminAccessGuidelines", () => ({
  AdminAccessGuidelines: () => null,
}));

jest.mock("@/components/AdminAccessGuidelinesModal", () => ({
  AdminAccessGuidelinesModal: () => null,
}));

const mockSiteConfig: SiteConfig = {
  siteId: "ananda",
  shortname: "ananda",
  name: "Ananda Library",
  tagline: "Test",
  greeting: "Hi",
  parent_site_url: "https://example.com",
  parent_site_name: "Parent",
  help_url: "https://example.com/help",
  help_text: "Help",
  collectionConfig: {},
  libraryMappings: {},
  enableSuggestedQueries: false,
  enableMediaTypeSelection: false,
  enableAuthorSelection: false,
  welcome_popup_heading: "Welcome",
  other_visitors_reference: "others",
  loginImage: null,
  header: { logo: "x.png", navItems: [] },
  footer: { links: [] },
  requireLogin: false,
  allowTemporarySessions: false,
  allowAllAnswersPage: false,
  queriesPerUserPerDay: 100,
  showSourceContent: true,
  showVoting: true,
};

const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>;

describe("AdminLayout superuserOnly affordance", () => {
  beforeEach(() => {
    mockUseRouter.mockReturnValue({
      pathname: "/admin/blacklist",
      query: {},
      asPath: "/admin/blacklist",
      push: jest.fn(),
      replace: jest.fn(),
      events: { on: jest.fn(), off: jest.fn() },
    } as any);
  });

  it("shows Superuser only badge when superuserOnly is true", () => {
    render(
      <AdminLayout siteConfig={mockSiteConfig} pageTitle="Email blacklist" superuserOnly>
        <p>Page body</p>
      </AdminLayout>
    );

    expect(screen.getByRole("status", { name: "Superuser-only page" })).toBeInTheDocument();
    expect(screen.getByText("Superuser only")).toBeInTheDocument();
    expect(screen.getByText("Page body")).toBeInTheDocument();
  });

  it("does not show Superuser only badge when superuserOnly is false", () => {
    render(
      <AdminLayout siteConfig={mockSiteConfig} pageTitle="Add Users">
        <p>Page body</p>
      </AdminLayout>
    );

    expect(screen.queryByRole("status", { name: "Superuser-only page" })).not.toBeInTheDocument();
    expect(screen.queryByText("Superuser only")).not.toBeInTheDocument();
    expect(screen.getByText("Page body")).toBeInTheDocument();
  });
});

describe("AddUsersPage (admin-only layout)", () => {
  const loginSiteConfig: SiteConfig = { ...mockSiteConfig, requireLogin: true };

  beforeEach(() => {
    mockUseRouter.mockReturnValue({
      pathname: "/admin/users/add",
      query: {},
      asPath: "/admin/users/add",
      push: jest.fn(),
      replace: jest.fn(),
      events: { on: jest.fn(), off: jest.fn() },
    } as any);

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/profile")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ firstName: "Admin", role: "admin" }),
        } as Response);
      }
      if (url.includes("/api/web-token")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: "mock-token" }),
        } as Response);
      }
      if (url.includes("/api/admin/pendingRequests")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ requests: [] }),
        } as Response);
      }
      if (url.includes("/api/admin/pendingUsersCount")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ count: 0 }),
        } as Response);
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    }) as jest.Mock;
  });

  it("does not show superuser-only affordance", async () => {
    render(<AddUsersPage siteConfig={loginSiteConfig} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email addresses/i)).toBeInTheDocument();
    });

    expect(screen.queryByRole("status", { name: "Superuser-only page" })).not.toBeInTheDocument();
    expect(screen.queryByText("Superuser only")).not.toBeInTheDocument();
  });
});
