import { syncUserAccessLevelFromSalesforce } from "@/utils/server/salesforceAccessSync";

const mockUserDoc = {};
const mockFirestoreSet = jest.fn().mockResolvedValue(undefined);
const mockFirestoreGet = jest.fn();

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => mockUserDoc),
    })),
  },
}));

jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
    },
  },
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: (...args: unknown[]) => mockFirestoreGet(...args),
  firestoreSet: (...args: unknown[]) => mockFirestoreSet(...args),
}));

const siteConfig: any = {
  parent_site_url: "https://luca.ananda.org",
  accessControl: {
    enabled: true,
    originUrl: "https://luca.ananda.org",
    levels: [
      { key: "public", label: "Public", value: 0 },
      { key: "disciple", label: "Disciple", value: 100 },
      { key: "kriyaban", label: "Kriyaban", value: 200 },
      { key: "kriyaban_2", label: "Kriyaban 2", value: 300 },
      { key: "kriyaban_3_and_4", label: "Kriyaban 3 & 4", value: 400 },
      {
        key: "ananda_library_regular_access",
        label: "Ananda Library regular access",
        value: 500,
      },
      { key: "minister", label: "Minister", value: 600 },
      { key: "lightbearer", label: "Lightbearer", value: 700 },
      { key: "admin", label: "Superuser", value: 9999 },
    ],
  },
};

describe("syncUserAccessLevelFromSalesforce", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL: "https://example.com/webhook",
      SALESFORCE_API_KEY: "secret-api-key",
      SALESFORCE_API_FIELD_NAME: "api_key",
    };
    mockFirestoreGet.mockResolvedValue({
      exists: true,
      data: () => ({
        firstName: "Test",
        lastName: "User",
        salesforceId: "003Existing",
      }),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("adds the configured API key field to the webhook payload", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        salesforce_18_id: "0031I00000ILXk1QAH",
        luca_access_level: "300",
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await syncUserAccessLevelFromSalesforce("TEST@EXAMPLE.COM", siteConfig);

    expect(result).toMatchObject({
      matched: true,
      salesforceId: "0031I00000ILXk1QAH",
      salesforceAccessLevel: 300,
    });
    const [, requestInit] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(requestInit.body as string);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(requestBody).toEqual([
      expect.objectContaining({
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        salesforce_id: "003Existing",
        origin_url: "https://luca.ananda.org",
        api_key: "secret-api-key",
      }),
    ]);
  });

  it("fails without calling the webhook when API key configuration is missing", async () => {
    delete process.env.SALESFORCE_API_KEY;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncUserAccessLevelFromSalesforce("test@example.com", siteConfig);

    expect(result).toEqual({
      matched: false,
      error: "Salesforce API key or API field name is not configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      mockUserDoc,
      expect.objectContaining({
        salesforceMatchStatus: "error",
        salesforceLastLookupError: "Salesforce API key or API field name is not configured",
      }),
      { merge: true },
      "write Salesforce access sync failure",
      "test@example.com"
    );
    consoleSpy.mockRestore();
  });
});
