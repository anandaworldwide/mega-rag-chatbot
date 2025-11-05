import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRouter } from "next/router";
import EditUserPage from "@/pages/admin/users/[userId]";
import type { SiteConfig } from "@/types/siteConfig";
import { MOCK_UUID_V4 } from "uuid";

// Mock next/router
jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

// Mock Layout to simplify rendering
jest.mock("@/components/layout", () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

// Mock AdminLayout to simplify rendering
jest.mock("@/components/AdminLayout", () => ({
  AdminLayout: ({ children }: any) => <div data-testid="admin-layout">{children}</div>,
}));

// Mock site config loader used by Layout props (SSR not exercised here)
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(async () => ({ name: "Test Site", siteId: "test" }) as Partial<SiteConfig>),
}));

describe("Admin UI · Edit User page", () => {
  const mockRouter = {
    query: { userId: "user@example.com" },
    push: jest.fn(),
    replace: jest.fn(),
  } as any;

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
    // Default fetch mocks: web-token, profile (for current user role), and GET user
    global.fetch = jest
      .fn()
      // /api/web-token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-jwt" }) } as any)
      // /api/profile (current user's role)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ role: "superuser" }) } as any)
      // GET /api/admin/users/:id (now includes conversationCount for admin users)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: "user@example.com",
            email: "user@example.com",
            role: "user",
            uuid: MOCK_UUID_V4,
            verifiedAt: null,
            lastLoginAt: null,
            entitlements: {},
            firstName: null,
            lastName: null,
            conversationCount: 0,
          },
        }),
      } as any) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch as any;
  });

  it("shows role selector regardless of requester role (visibility by role)", async () => {
    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    // Wait for form to render after async fetches
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();
    const roleSelect = screen.getByText("Role").parentElement!.querySelector("select")!;
    expect(roleSelect).toBeInTheDocument();
    expect((roleSelect as HTMLSelectElement).value).toBe("user");
  });

  it("submits form successfully without email change", async () => {
    // Setup PATCH success with same user id
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-jwt" }) }) // web-token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ role: "superuser" }) }) // profile
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: "user@example.com",
            email: "user@example.com",
            role: "user",
            uuid: MOCK_UUID_V4,
            verifiedAt: null,
            lastLoginAt: null,
            entitlements: {},
            firstName: null,
            lastName: null,
            conversationCount: 0,
          },
        }),
      }) // GET
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: "user@example.com",
            email: "user@example.com",
            role: "admin",
            uuid: MOCK_UUID_V4,
            verifiedAt: null,
            lastLoginAt: null,
            entitlements: {},
            firstName: null,
            lastName: null,
            conversationCount: 0,
          },
        }),
      }); // PATCH

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    // Wait for load
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();

    // Change role and save
    const roleSelect = screen.getByText("Role").parentElement!.querySelector("select")!;
    fireEvent.change(roleSelect, { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/users/user%40example.com",
        expect.objectContaining({ method: "PATCH" })
      );
    });

    // Should not navigate when id unchanged
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("navigates to new route after email change", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-jwt" }) }) // web-token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ role: "superuser" }) }) // profile

      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: "user@example.com",
            email: "user@example.com",
            role: "user",
            uuid: MOCK_UUID_V4,
            verifiedAt: null,
            lastLoginAt: null,
            entitlements: {},
            firstName: null,
            lastName: null,
            conversationCount: 0,
          },
        }),
      }) // GET initial
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: "new@example.com",
            email: "new@example.com",
            role: "user",
            uuid: MOCK_UUID_V4,
            verifiedAt: null,
            lastLoginAt: null,
            entitlements: {},
            firstName: null,
            lastName: null,
            conversationCount: 0,
          },
        }),
      }) // PATCH response
      // Simulate subsequent GET after navigation (optional defensive)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: "new@example.com",
            email: "new@example.com",
            role: "user",
            uuid: MOCK_UUID_V4,
            verifiedAt: null,
            lastLoginAt: null,
            entitlements: {},
            firstName: null,
            lastName: null,
            conversationCount: 0,
          },
        }),
      });

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith("/admin/users/new%40example.com");
    });
  });

  it("renders load error state", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-jwt" }) }) // web-token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ role: "superuser" }) }) // profile
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Forbidden" }) }); // GET user fails

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    // Error banner shows the API error message
    expect(await screen.findByText(/Forbidden/)).toBeInTheDocument();
  });

  it("shows error on save failure", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-jwt" }) }) // web-token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ role: "superuser" }) }) // profile
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: "user@example.com",
            email: "user@example.com",
            role: "user",
            uuid: MOCK_UUID_V4,
            verifiedAt: null,
            lastLoginAt: null,
            entitlements: {},
            firstName: null,
            lastName: null,
            conversationCount: 0,
          },
        }),
      }) // GET user
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Only superuser may change role" }) }); // PATCH fails

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();

    const selectEl = screen.getByText("Role").parentElement!.querySelector("select")!;
    fireEvent.change(selectEl as Element, { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    expect(await screen.findByText(/Only superuser may change role/)).toBeInTheDocument();
  });

  it("Back button navigates to users list", async () => {
    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(mockRouter.push).toHaveBeenCalledWith("/admin");
  });
});
