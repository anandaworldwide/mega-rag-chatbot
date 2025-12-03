import React from "react";
import { render, screen, act } from "@testing-library/react";
import { SudoProvider, useSudo } from "@/contexts/SudoContext";

// Mock fetchWithAuth from tokenManager
jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

const TestConsumer: React.FC = () => {
  const { isSudoUser, errorMessage, checkSudoStatus } = useSudo();
  return (
    <div>
      <div data-testid="isSudoUser">{String(isSudoUser)}</div>
      <div data-testid="errorMessage">{errorMessage ?? ""}</div>
      <button onClick={() => void checkSudoStatus()}>check</button>
    </div>
  );
};

describe("SudoContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("skips sudo checks on /login and does not call fetchWithAuth", async () => {
    const { fetchWithAuth } = jest.requireMock("@/utils/client/tokenManager") as {
      fetchWithAuth: jest.Mock;
    };

    // Simulate running on /login
    Object.defineProperty(window, "location", {
      value: { pathname: "/login" },
      writable: true,
    });

    render(
      <SudoProvider>
        <TestConsumer />
      </SudoProvider>
    );

    // Trigger explicit check
    await act(async () => {
      screen.getByText("check").click();
    });

    // State should be reset and no network call performed
    expect(screen.getByTestId("isSudoUser").textContent).toBe("false");
    expect(screen.getByTestId("errorMessage").textContent).toBe("");
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test("sets isSudoUser from successful response and shows IP mismatch message", async () => {
    const { fetchWithAuth } = jest.requireMock("@/utils/client/tokenManager") as {
      fetchWithAuth: jest.Mock;
    };

    // Simulate normal page
    Object.defineProperty(window, "location", {
      value: { pathname: "/admin" },
      writable: true,
    });

    // Mock a successful response with sudoCookieValue and ipMismatch
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sudoCookieValue: true, ipMismatch: true }),
      status: 200,
      statusText: "OK",
    } as unknown as Response);

    render(
      <SudoProvider>
        <TestConsumer />
      </SudoProvider>
    );

    // Trigger explicit check
    await act(async () => {
      screen.getByText("check").click();
    });

    expect(fetchWithAuth).toHaveBeenCalledWith("/api/sudoCookie", {
      method: "GET",
      credentials: "include",
    });
    expect(screen.getByTestId("isSudoUser").textContent).toBe("true");
    expect(screen.getByTestId("errorMessage").textContent).toBe("Your IP has changed. Please re-authenticate.");
  });

  test("when disableChecks is true, skips API call and sets isSudoUser to false", async () => {
    const { fetchWithAuth } = jest.requireMock("@/utils/client/tokenManager") as {
      fetchWithAuth: jest.Mock;
    };

    // Simulate normal page (not /login)
    Object.defineProperty(window, "location", {
      value: { pathname: "/admin" },
      writable: true,
    });

    render(
      <SudoProvider disableChecks={true}>
        <TestConsumer />
      </SudoProvider>
    );

    // Trigger explicit check
    await act(async () => {
      screen.getByText("check").click();
    });

    // Should not call API and should set sudo to false
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByTestId("isSudoUser").textContent).toBe("false");
    expect(screen.getByTestId("errorMessage").textContent).toBe("");
  });

  test("handles 400 error from login-required site gracefully", async () => {
    const { fetchWithAuth } = jest.requireMock("@/utils/client/tokenManager") as {
      fetchWithAuth: jest.Mock;
    };

    // Simulate normal page
    Object.defineProperty(window, "location", {
      value: { pathname: "/admin" },
      writable: true,
    });

    // Mock a 400 response indicating login-required site
    fetchWithAuth.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({
        error: "Sudo API is not available on login-required sites. Use role-based authentication instead.",
      }),
    } as unknown as Response);

    render(
      <SudoProvider disableChecks={false}>
        <TestConsumer />
      </SudoProvider>
    );

    // Trigger explicit check
    await act(async () => {
      screen.getByText("check").click();
    });

    // Should handle 400 gracefully - set sudo to false, no error message
    expect(fetchWithAuth).toHaveBeenCalledWith("/api/sudoCookie", {
      method: "GET",
      credentials: "include",
    });
    expect(screen.getByTestId("isSudoUser").textContent).toBe("false");
    expect(screen.getByTestId("errorMessage").textContent).toBe("");
  });
});
