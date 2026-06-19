/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SettingsPage from "@/pages/settings";
import type { SiteConfig } from "@/types/siteConfig";

jest.mock("next/head", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/components/layout", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/components/EmailChangeModal", () => ({
  EmailChangeModal: () => null,
}));

jest.mock("@/components/PasswordChangeModal", () => ({
  PasswordChangeModal: () => null,
}));

const siteConfig = {
  name: "Test Site",
  requireLogin: true,
} as SiteConfig;

describe("SettingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it("renders profile information after loading", async () => {
    jest
      .mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "jwt-token" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          email: "user@example.com",
          role: "user",
          firstName: "Test",
          lastName: "User",
          hasPassword: true,
          enabledEmailTypes: ["newsletters"],
          emailPreferences: {
            newsletters: true,
            onboarding: true,
            reengagement: true,
            specialDay: true,
            nps: true,
          },
        }),
      } as Response);

    render(<SettingsPage siteConfig={siteConfig} />);

    await waitFor(() => {
      expect(screen.getByText(/Email: user@example.com/)).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("Test")).toBeInTheDocument();
    expect(screen.getByDisplayValue("User")).toBeInTheDocument();
  });

  it("shows unavailable message when web token fetch fails", async () => {
    jest.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response);

    render(<SettingsPage siteConfig={siteConfig} />);

    await waitFor(() => {
      expect(screen.getByText("Settings are not available on this site")).toBeInTheDocument();
    });
  });
});
