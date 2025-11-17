import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRouter } from "next/router";
import EditUserPage from "@/pages/admin/users/[userId]";
import type { SiteConfig } from "@/types/siteConfig";
import { getToken, fetchWithAuth } from "@/utils/client/tokenManager";

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

// At top after other mocks
jest.mock("@/utils/client/tokenManager", () => {
  const actual = jest.requireActual("@/utils/client/tokenManager");
  return {
    ...actual,
    getToken: jest.fn(),
    fetchWithAuth: jest.fn(),
  };
});

describe("Admin UI · Edit User page", () => {
  const mockRouter = {
    query: { userId: "user@example.com" },
    push: jest.fn(),
    replace: jest.fn(),
  } as any;

  const mockGetToken = getToken as jest.MockedFunction<typeof getToken>;
  const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

  const MOCK_UUID_V4 = "00000000-0000-4000-8000-000000000000";

  const defaultUser = {
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
  };

  const createJsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: {} as Headers,
      redirected: false,
      type: "basic",
      url: "",
      clone: () => createJsonResponse(body, init),
      body: null,
      bodyUsed: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => ({}) as Blob,
      formData: async () => ({}) as FormData,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  };

  const mockProfileResponse = () => createJsonResponse({ role: "superuser" });

  const buildUserResponse = (overrides: Partial<typeof defaultUser> = {}, init?: ResponseInit) =>
    createJsonResponse(
      {
        user: {
          ...defaultUser,
          ...overrides,
        },
      },
      init
    );

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
    mockGetToken.mockReset();
    mockFetchWithAuth.mockReset();
    mockGetToken.mockResolvedValue("test-jwt");
  });

  afterEach(() => {
    // global.fetch = originalFetch as any; // Removed global.fetch mock
  });

  it("shows role selector regardless of requester role (visibility by role)", async () => {
    mockFetchWithAuth.mockResolvedValueOnce(mockProfileResponse()).mockResolvedValueOnce(buildUserResponse());

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    // Wait for form to render after async fetches
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();
    const roleSelect = screen.getByText("Role").parentElement!.querySelector("select")!;
    expect(roleSelect).toBeInTheDocument();
    expect((roleSelect as HTMLSelectElement).value).toBe("user");
  });

  it("submits form successfully without email change", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(mockProfileResponse()) // profile
      .mockResolvedValueOnce(buildUserResponse()) // GET
      .mockResolvedValueOnce(buildUserResponse({ role: "admin" })); // PATCH

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    // Wait for load
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();

    // Change role and save
    const roleSelect = screen.getByText("Role").parentElement!.querySelector("select")!;
    fireEvent.change(roleSelect, { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    await waitFor(() => {
      expect(fetchWithAuth as jest.Mock).toHaveBeenCalledWith(
        "/api/admin/users/user%40example.com",
        expect.objectContaining({ method: "PATCH" })
      );
    });

    // Should not navigate when id unchanged
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("navigates to new route after email change", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(mockProfileResponse()) // profile
      .mockResolvedValueOnce(buildUserResponse()) // initial GET
      .mockResolvedValueOnce(buildUserResponse({ id: "new@example.com", email: "new@example.com" })); // PATCH response

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith("/admin/users/new%40example.com");
    });
  });

  it("renders load error state", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(mockProfileResponse()) // profile
      .mockResolvedValueOnce(createJsonResponse({ error: "Forbidden" }, { status: 403 })); // GET user fails

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    // Error banner shows the API error message
    expect(await screen.findByText(/Forbidden/)).toBeInTheDocument();
  });

  it("shows error on save failure", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(mockProfileResponse()) // profile
      .mockResolvedValueOnce(buildUserResponse()) // GET user
      .mockResolvedValueOnce(createJsonResponse({ error: "Only superuser may change role" }, { status: 403 })); // PATCH fails

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();

    const selectEl = screen.getByText("Role").parentElement!.querySelector("select")!;
    fireEvent.change(selectEl as Element, { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    expect(await screen.findByText(/Only superuser may change role/)).toBeInTheDocument();
  });

  it("Back button navigates to users list", async () => {
    mockFetchWithAuth.mockResolvedValueOnce(mockProfileResponse()).mockResolvedValueOnce(buildUserResponse());

    render(<EditUserPage siteConfig={{ siteId: "test" } as any} />);
    expect(await screen.findByDisplayValue("user@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(mockRouter.push).toHaveBeenCalledWith("/admin");
  });
});
