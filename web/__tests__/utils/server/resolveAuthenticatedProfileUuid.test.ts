/** @jest-environment node */

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn((email: string) => ({ id: email })),
    })),
  },
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";

import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import {
  resolveAuthenticatedProfileUuid,
  resolvePersistUuidForRequest,
} from "@/utils/server/uuidUtils";
import { JwtPayload } from "@/utils/server/jwtUtils";

const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

describe("resolveAuthenticatedProfileUuid", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns uuid from JWT when present", async () => {
    const token: JwtPayload = {
      client: "web",
      uuid: "123e4567-e89b-12d3-a456-426614174000",
      iat: 1,
      exp: 9999999999,
    };

    const result = await resolveAuthenticatedProfileUuid(token);

    expect(result).toEqual({
      success: true,
      uuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(firestoreGet).not.toHaveBeenCalled();
  });

  it("loads uuid from Firestore profile when JWT omits it", async () => {
    const token: JwtPayload = {
      client: "web",
      email: "user@example.com",
      iat: 1,
      exp: 9999999999,
    };

    (firestoreGet as jest.Mock).mockResolvedValueOnce({
      exists: true,
      data: () => ({ uuid: "223e4567-e89b-42d3-a456-426614174000" }),
    });

    const result = await resolveAuthenticatedProfileUuid(token);

    expect(result).toEqual({
      success: true,
      uuid: "223e4567-e89b-42d3-a456-426614174000",
    });
    expect(firestoreGet).toHaveBeenCalled();
  });

  it("returns 400 when JWT and profile both lack uuid", async () => {
    const token: JwtPayload = {
      client: "web",
      email: "user@example.com",
      iat: 1,
      exp: 9999999999,
    };

    (firestoreGet as jest.Mock).mockResolvedValueOnce({
      exists: true,
      data: () => ({}),
    });

    const result = await resolveAuthenticatedProfileUuid(token);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(400);
      expect(result.error).toBe("User profile UUID not found");
    }
  });
});

describe("resolvePersistUuidForRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfigSync.mockReturnValue({ requireLogin: true } as any);
  });

  it("uses authenticated profile uuid on login-required sites", async () => {
    const token: JwtPayload = {
      client: "web",
      uuid: "323e4567-e89b-42d3-a456-426614174000",
      iat: 1,
      exp: 9999999999,
    };

    const result = await resolvePersistUuidForRequest(true, token, "423e4567-e89b-42d3-a456-426614174000");

    expect(result).toEqual({
      success: true,
      uuid: "323e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("uses body uuid on anonymous sites", async () => {
    const token: JwtPayload = {
      client: "web",
      iat: 1,
      exp: 9999999999,
    };

    const result = await resolvePersistUuidForRequest(
      false,
      token,
      "423e4567-e89b-42d3-a456-426614174000"
    );

    expect(result).toEqual({
      success: true,
      uuid: "423e4567-e89b-42d3-a456-426614174000",
    });
  });
});
