import { getCachedSecureAudioUrl, clearAudioUrlCache } from "@/utils/client/getSecureAudioUrl";

jest.mock("@/utils/client/tokenManager", () => ({
  getToken: jest.fn().mockResolvedValue("valid-jwt-token"),
}));

jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn().mockReturnValue("12345678-1234-1234-1234-123456789abc"),
}));

function mockFetchResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: {
      get: () => null,
    },
  } as Response;
}

describe("getCachedSecureAudioUrl", () => {
  const originalFetch = global.fetch;
  const fixedNow = 1613753920000;

  beforeEach(() => {
    jest.clearAllMocks();
    clearAudioUrlCache();
    (Date.now as jest.Mock).mockReturnValue(fixedNow);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (Date.now as jest.Mock).mockReturnValue(fixedNow);
  });

  it("keeps a 404 result for 60 seconds and does not call fetch again", async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockFetchResponse(404, { message: "Audio file not found" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getCachedSecureAudioUrl("missing.mp3", "treasures")).rejects.toThrow("Audio file not found");
    await expect(getCachedSecureAudioUrl("missing.mp3", "treasures")).rejects.toThrow("Audio file not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    (Date.now as jest.Mock).mockReturnValue(fixedNow + 61 * 1000);
    await expect(getCachedSecureAudioUrl("missing.mp3", "treasures")).rejects.toThrow("Audio file not found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a signed URL after a successful fetch", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockFetchResponse(200, {
        signedUrl: "https://secure.example/audio.mp3",
        contentType: "audio",
        expiresIn: 14400,
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const url = await getCachedSecureAudioUrl("talk.mp3", "treasures");
    expect(url).toBe("https://secure.example/audio.mp3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
