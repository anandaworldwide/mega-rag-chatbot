import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SalesforceAccessNoticeGate from "@/components/SalesforceAccessNoticeGate";
import SalesforceAccessNoticeModal from "@/components/SalesforceAccessNoticeModal";
import { SiteConfig } from "@/types/siteConfig";

let mockAsPath = "/";

jest.mock("next/router", () => ({
  useRouter: () => ({
    isReady: true,
    asPath: mockAsPath,
  }),
}));

jest.mock("@/utils/client/siteConfig", () => ({
  getEnableSalesforceAccessNotice: jest.fn(() => true),
}));

const siteConfig = {
  siteId: "ananda",
  shortname: "Luca",
  name: "Luca",
  tagline: "Test",
  greeting: "Hello",
  parent_site_url: "https://ananda.org",
  parent_site_name: "Ananda",
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
  header: { logo: "", navItems: [] },
  footer: { links: [] },
  requireLogin: true,
  allowTemporarySessions: false,
  allowAllAnswersPage: false,
  queriesPerUserPerDay: 100,
  showSourceContent: true,
  showVoting: false,
  enableSalesforceAccessNotice: true,
  accessControl: {
    enabled: true,
    levels: [{ key: "public", label: "Public", value: 0 }],
  },
} satisfies SiteConfig;

describe("SalesforceAccessNoticeModal", () => {
  it("shows Salesforce-connected copy and the progressive content tagging explanation", () => {
    render(
      <SalesforceAccessNoticeModal
        isOpen
        profile={{
          accessLevelLabel: "Minister",
          accessLevelSource: "salesforce",
          salesforceAccessLevelLabel: "Minister",
          salesforceId: "0031I00000ILXk1QAH",
          salesforceMatchStatus: "matched",
          salesforceContactEmail: "salesforce-help@example.com",
        }}
        adminRegions={[]}
        isLoadingAdmins={false}
        adminLoadError={null}
        onClose={jest.fn()}
      />
    );

    expect(screen.getByText("Current access level")).toBeInTheDocument();
    expect(screen.getAllByText("Minister").length).toBeGreaterThan(0);
    expect(screen.getByText(/Salesforce connection: connected/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "salesforce-help@example.com" })).toHaveAttribute(
      "href",
      "mailto:salesforce-help@example.com"
    );
    expect(screen.getByText(/gradually start seeing more of that restricted material/i)).toBeInTheDocument();
  });

  it("shows manual-level instructions and admin email addresses when Salesforce is not connected", () => {
    render(
      <SalesforceAccessNoticeModal
        isOpen
        profile={{
          accessLevelLabel: "Kriyaban",
          accessLevelSource: "manual",
          manualAccessLevelLabel: "Kriyaban",
          salesforceId: null,
          salesforceMatchStatus: "not_found",
        }}
        adminRegions={[
          {
            name: "Americas",
            admins: [
              {
                name: "Admin User",
                email: "admin@example.com",
                location: "Test City, CA",
              },
            ],
          },
        ]}
        isLoadingAdmins={false}
        adminLoadError={null}
        onClose={jest.fn()}
      />
    );

    expect(screen.getByText(/Salesforce connection: not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/manually assigned Luca access level is: Kriyaban/i)).toBeInTheDocument();
    expect(screen.getByText("Admin User")).toBeInTheDocument();
    expect(screen.getByText("Test City, CA")).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
});

describe("SalesforceAccessNoticeGate", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    mockAsPath = "/";
    jest.clearAllMocks();
  });

  it("opens the notice for an undismissed profile, loads admin emails, and patches dismissal", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessLevelLabel: "Public",
          accessLevelSource: "default",
          manualAccessLevelLabel: "Public",
          salesforceMatchStatus: "not_found",
          salesforceId: null,
          dismissedSalesforceAccessNotice: false,
          dismissedSalesforceAccessNoticeVersion: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          regions: [
            {
              name: "Global",
              admins: [
                {
                  name: "Luca Admin",
                  email: "luca-admin@example.com",
                  location: "Global",
                },
              ],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SalesforceAccessNoticeGate siteConfig={siteConfig} />);

    expect(await screen.findByText("Your Luca access level")).toBeInTheDocument();
    expect(await screen.findByText("luca-admin@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /got it/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          dismissedSalesforceAccessNoticeVersion: 1,
        }),
      });
    });
  });

  it("checks for the notice on a normal public page when the user is already logged in", async () => {
    mockAsPath = "/contact";
    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        accessLevelLabel: "Kriyaban",
        accessLevelSource: "salesforce",
        salesforceAccessLevelLabel: "Kriyaban",
        salesforceMatchStatus: "matched",
        salesforceId: "0031I00000ILXk1QAH",
        dismissedSalesforceAccessNotice: false,
        dismissedSalesforceAccessNoticeVersion: null,
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SalesforceAccessNoticeGate siteConfig={siteConfig} />);

    expect(await screen.findByText("Your Luca access level")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/profile", { credentials: "include" });
  });

  it("fires non-blocking Salesforce access verification when the profile is stale", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessLevelLabel: "Public",
          accessLevelSource: "default",
          salesforceMatchStatus: "not_found",
          salesforceId: null,
          dismissedSalesforceAccessNotice: true,
          dismissedSalesforceAccessNoticeVersion: 1,
          salesforceAccessVerificationDue: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SalesforceAccessNoticeGate siteConfig={siteConfig} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/salesforce/verifyAccess", {
        method: "POST",
        credentials: "include",
      });
    });
  });

  it("does not check for the notice on auth pages", async () => {
    mockAsPath = "/login";
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SalesforceAccessNoticeGate siteConfig={siteConfig} />);

    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
