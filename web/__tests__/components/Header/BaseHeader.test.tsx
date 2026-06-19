import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import BaseHeader from "@/components/Header/BaseHeader";
import type { HeaderConfig } from "@/types/siteConfig";

const mockRouter = {
  pathname: "/",
  events: { on: jest.fn(), off: jest.fn() },
};

jest.mock("next/router", () => ({
  useRouter: () => mockRouter,
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

jest.mock("@/utils/client/loadWhatsNew", () => ({
  isWhatsNewAvailable: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/components/WhatsNewDropdown", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/HelpDropdown", () => ({
  __esModule: true,
  default: () => <div data-testid="help-dropdown" />,
}));

const mockInitializeTokenManager = jest.fn().mockResolvedValue(undefined);
const mockIsAuthenticated = jest.fn().mockReturnValue(false);

jest.mock("@/utils/client/tokenManager", () => ({
  initializeTokenManager: (...args: unknown[]) => mockInitializeTokenManager(...args),
  isAuthenticated: (...args: unknown[]) => mockIsAuthenticated(...args),
}));

const baseConfig: HeaderConfig = {
  navItems: [{ path: "/", label: "Chat" }],
};

describe("BaseHeader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouter.pathname = "/";
    mockIsAuthenticated.mockReturnValue(false);
    mockInitializeTokenManager.mockResolvedValue(undefined);
    Object.defineProperty(document, "cookie", {
      configurable: true,
      writable: true,
      value: "",
    });
  });

  it("shows Login link when requireLogin and user is not authenticated", async () => {
    render(
      <BaseHeader config={baseConfig} requireLogin={true} onNewChat={jest.fn()} isChatEmpty={true} />
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Login" })).toBeInTheDocument();
    });
  });

  it("shows settings link when user is logged in", async () => {
    mockIsAuthenticated.mockReturnValue(true);
    Object.defineProperty(document, "cookie", { configurable: true, writable: true, value: "hasSession=1" });

    render(
      <BaseHeader config={baseConfig} requireLogin={true} onNewChat={jest.fn()} isChatEmpty={false} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText("User settings")).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "Login" })).not.toBeInTheDocument();
  });

  it("shows new chat button for logged-out users", async () => {
    const onNewChat = jest.fn();

    render(
      <BaseHeader config={baseConfig} requireLogin={true} onNewChat={onNewChat} isChatEmpty={true} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText("New Chat")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("New Chat"));
    expect(onNewChat).toHaveBeenCalled();
  });

  it("shows new chat button for logged-in users on non-home pages", async () => {
    mockRouter.pathname = "/settings";
    mockIsAuthenticated.mockReturnValue(true);
    Object.defineProperty(document, "cookie", { configurable: true, writable: true, value: "hasSession=1" });

    render(
      <BaseHeader config={baseConfig} requireLogin={true} onNewChat={jest.fn()} isChatEmpty={true} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText("New Chat")).toBeInTheDocument();
    });
  });

  it("shows search link when enableSearchPage is true", async () => {
    render(
      <BaseHeader config={baseConfig} requireLogin={false} enableSearchPage={true} isChatEmpty={true} />
    );

    await waitFor(() => {
      expect(screen.getByTitle("Search Passages")).toBeInTheDocument();
    });
  });

  it("initializes token manager on mount", async () => {
    render(<BaseHeader config={baseConfig} requireLogin={true} isChatEmpty={true} />);

    await waitFor(() => {
      expect(mockInitializeTokenManager).toHaveBeenCalled();
    });
  });
});
