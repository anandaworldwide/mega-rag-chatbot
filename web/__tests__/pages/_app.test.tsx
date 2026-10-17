/**
 * App Component Tests
 *
 * Tests for the _app.tsx component which serves as the main wrapper for all pages
 */

import { render, act } from "@testing-library/react";
import MyApp, { reportWebVitals } from "@/pages/_app";
import { initializeTokenManager } from "@/utils/client/tokenManager";
import { toast } from "react-toastify";
import { NextWebVitalsMetric } from "next/app";
import { GoogleAnalytics } from "nextjs-google-analytics";

// Mock dependencies
jest.mock("next/font/google", () => ({
  Inter: jest.fn(() => ({
    className: "mocked-font",
  })),
}));

jest.mock("@/utils/client/tokenManager", () => ({
  initializeTokenManager: jest.fn(() => Promise.resolve("token")),
  fetchWithAuth: jest.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ sudoCookieValue: false }),
    })
  ),
}));

jest.mock("react-toastify", () => ({
  toast: {
    error: jest.fn(),
    warning: jest.fn(),
  },
  ToastContainer: jest.fn(() => null),
}));

jest.mock("@/components/SessionExpiredModal", () => ({
  __esModule: true,
  default: jest.fn(({ isOpen }) => (isOpen ? <div>Session Expired Modal</div> : null)),
}));

jest.mock("@/components/AuthGuard", () => ({
  __esModule: true,
  default: jest.fn(({ children }) => children),
}));

jest.mock("nextjs-google-analytics", () => ({
  GoogleAnalytics: jest.fn(() => null),
  event: jest.fn(),
}));

jest.mock("@tanstack/react-query", () => ({
  QueryClientProvider: jest.fn(({ children }) => children),
}));

jest.mock("@/utils/client/reactQueryConfig", () => ({
  queryClient: {},
}));

describe("MyApp component", () => {
  const mockComponent = jest.fn(() => <div>Test</div>);
  const pageProps = { siteConfig: { requireLogin: true, siteId: "test" } };

  // Store original window.location
  let originalLocation: Location;

  beforeAll(() => {
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      enumerable: true,
      value: { pathname: "/" },
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      enumerable: true,
      value: originalLocation,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the mock implementation before each test
    (initializeTokenManager as jest.Mock).mockImplementation(() => Promise.resolve("token"));
  });

  it("renders without crashing", () => {
    const { container } = render(
      <MyApp Component={mockComponent} pageProps={pageProps} router={{ pathname: "/" } as any} />
    );
    expect(container).toBeTruthy();
  });

  it("initializes token manager for background features on mount", () => {
    render(<MyApp Component={mockComponent} pageProps={pageProps} router={{ pathname: "/" } as any} />);

    expect(initializeTokenManager).toHaveBeenCalled();
  });

  it("suppresses error toast when token initialization fails for background features", async () => {
    // Set location to home page
    Object.defineProperty(window, "location", {
      configurable: true,
      enumerable: true,
      value: { pathname: "/" },
    });

    // Mock token manager to fail
    (initializeTokenManager as jest.Mock).mockImplementation(() => Promise.reject(new Error("Failed to initialize")));

    // Render component and wait for effects to run
    await act(async () => {
      render(<MyApp Component={mockComponent} pageProps={pageProps} router={{ pathname: "/" } as any} />);
    });

    // Error toast should NOT be called since we now suppress errors for background features
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("suppresses error toast when token initialization fails on login page", async () => {
    // Set location to login page
    Object.defineProperty(window, "location", {
      configurable: true,
      enumerable: true,
      value: { pathname: "/login" },
    });

    // Mock token manager to fail
    (initializeTokenManager as jest.Mock).mockImplementation(() => Promise.reject(new Error("Failed to initialize")));

    // Render component and wait for effects to run
    await act(async () => {
      render(<MyApp Component={mockComponent} pageProps={pageProps} router={{ pathname: "/login" } as any} />);
    });

    // Error toast should NOT be called
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("passes the page CSP nonce to GoogleAnalytics", () => {
    render(
      <MyApp
        Component={mockComponent}
        pageProps={{ ...pageProps, nonce: "ga-nonce-1" }}
        router={{ pathname: "/" } as any}
      />
    );
    expect((GoogleAnalytics as jest.Mock).mock.calls[0][0]).toEqual(
      expect.objectContaining({ nonce: "ga-nonce-1", trackPageViews: true })
    );
  });

  it("reads the csp-nonce meta tag when pageProps have no nonce", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "csp-nonce");
    meta.setAttribute("content", "from-meta");
    document.head.appendChild(meta);
    try {
      render(<MyApp Component={mockComponent} pageProps={pageProps} router={{ pathname: "/" } as any} />);
      expect((GoogleAnalytics as jest.Mock).mock.calls[0][0]).toEqual(
        expect.objectContaining({ nonce: "from-meta", trackPageViews: true })
      );
    } finally {
      meta.remove();
    }
  });

  it("handles web vitals reporting", () => {
    const mockEvent = jest.fn();
    (window as any).gtag = mockEvent;

    // Create a fake environment variable for testing
    const origNodeEnv = process.env.NODE_ENV;
    // @ts-expect-error - Modifying read-only property for testing purposes
    process.env.NODE_ENV = "development";

    // Create a NextWebVitalsMetric compatible object
    const metric: NextWebVitalsMetric = {
      id: "test-id",
      name: "FCP",
      startTime: 100,
      value: 100,
      label: "web-vital",
    };

    reportWebVitals(metric);
    expect(mockEvent).not.toHaveBeenCalled();

    // Restore original NODE_ENV value
    // @ts-expect-error - Modifying read-only property for testing purposes
    process.env.NODE_ENV = origNodeEnv;
  });
});
