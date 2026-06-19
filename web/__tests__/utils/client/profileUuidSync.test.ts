import {
  ensureProfileUuidSynced,
  ensureVisitorUuidReady,
  initializeProfileUuidSync,
  resetProfileUuidSyncForTests,
} from "@/utils/client/profileUuidSync";
import { syncProfileUuid } from "@/utils/client/uuid";

jest.mock("@/utils/client/tokenManager", () => ({
  ensureAnonymousUuidSynced: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/client/uuid", () => ({
  syncProfileUuid: jest.fn(),
  syncUuidFromSignedCookie: jest.fn(),
}));

describe("profileUuidSync", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    resetProfileUuidSyncForTests();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it("skips profile fetch when login is not required", async () => {
    await initializeProfileUuidSync(false);

    expect(mockFetch).not.toHaveBeenCalled();
    await expect(ensureProfileUuidSynced()).resolves.toBeUndefined();
  });

  it("syncs profile uuid on login-required sites", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ uuid: "profile-uuid-123" }),
    });

    await initializeProfileUuidSync(true);

    expect(mockFetch).toHaveBeenCalledWith("/api/profile", { credentials: "include" });
    expect(syncProfileUuid).toHaveBeenCalledWith("profile-uuid-123");
  });

  it("dedupes concurrent initialize calls", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const first = initializeProfileUuidSync(true);
    const second = initializeProfileUuidSync(true);

    resolveFetch({
      ok: true,
      json: async () => ({ uuid: "profile-uuid-123" }),
    });

    await Promise.all([first, second]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("ensureProfileUuidSynced waits for in-flight sync", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const initPromise = initializeProfileUuidSync(true);
    const ensurePromise = ensureProfileUuidSynced();

    resolveFetch({
      ok: true,
      json: async () => ({ uuid: "profile-uuid-456" }),
    });

    await Promise.all([initPromise, ensurePromise]);

    expect(syncProfileUuid).toHaveBeenCalledWith("profile-uuid-456");
  });

  it("ensureVisitorUuidReady bootstraps anonymous uuid then profile sync on login-required sites", async () => {
    const { ensureAnonymousUuidSynced } = jest.requireMock("@/utils/client/tokenManager");

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ uuid: "profile-uuid-789" }),
    });

    await initializeProfileUuidSync(true);
    await ensureVisitorUuidReady(true);

    expect(ensureAnonymousUuidSynced).toHaveBeenCalled();
    expect(syncProfileUuid).toHaveBeenCalledWith("profile-uuid-789");
  });

  it("ensureVisitorUuidReady only bootstraps anonymous uuid on public sites", async () => {
    const { ensureAnonymousUuidSynced } = jest.requireMock("@/utils/client/tokenManager");

    await ensureVisitorUuidReady(false);

    expect(ensureAnonymousUuidSynced).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
