jest.mock("js-cookie", () => ({
  get: jest.fn(),
}));

import Cookies from "js-cookie";
import {
  isDemoModeEnabled,
  maskEmail,
  generateFakeName,
  maskUserPII,
} from "@/utils/client/demoMode";

const mockCookiesGet = Cookies.get as jest.MockedFunction<typeof Cookies.get>;

describe("demoMode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("isDemoModeEnabled", () => {
    it("returns true when demo cookie is set", () => {
      mockCookiesGet.mockReturnValue("true");
      expect(isDemoModeEnabled()).toBe(true);
    });

    it("returns false when demo cookie is absent", () => {
      mockCookiesGet.mockReturnValue(undefined);
      expect(isDemoModeEnabled()).toBe(false);
    });
  });

  describe("maskEmail", () => {
    it("masks local and domain parts", () => {
      expect(maskEmail("alice@example.com")).toBe("a***@e***.com");
    });

    it("returns invalid emails unchanged", () => {
      expect(maskEmail("not-an-email")).toBe("not-an-email");
      expect(maskEmail("")).toBe("");
    });
  });

  describe("generateFakeName", () => {
    it("returns deterministic names for the same identifier", () => {
      const first = generateFakeName("user-uuid-123");
      const second = generateFakeName("user-uuid-123");
      expect(first).toEqual(second);
      expect(first.fullName).toContain(" ");
    });

    it("returns first name only when requested", () => {
      const result = generateFakeName("abc", true, false);
      expect(result.firstName).toBeTruthy();
      expect(result.lastName).toBe("");
    });

    it("returns demo user for missing identifier", () => {
      expect(generateFakeName(null)).toEqual({
        firstName: "Demo",
        lastName: "User",
        fullName: "Demo User",
      });
    });
  });

  describe("maskUserPII", () => {
    it("returns user unchanged when demo mode is off", () => {
      mockCookiesGet.mockReturnValue(undefined);
      const user = { email: "alice@example.com", firstName: "Alice", lastName: "Smith" };
      expect(maskUserPII(user)).toEqual(user);
    });

    it("masks user fields when demo mode is on", () => {
      mockCookiesGet.mockReturnValue("true");
      const user = {
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Smith",
        uuid: "uuid-1",
        role: "user",
      };

      const masked = maskUserPII(user);
      expect(masked.email).toBe("a***@e***.com");
      expect(masked.firstName).not.toBe("Alice");
      expect(masked.role).toBe("user");
    });
  });
});
