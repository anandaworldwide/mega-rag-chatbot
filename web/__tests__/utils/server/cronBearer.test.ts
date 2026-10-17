import { bearerMatchesCronSecret } from "../../../src/utils/server/cronBearer";

describe("bearerMatchesCronSecret", () => {
  const secret = "cron-secret-value-32-chars!!!!";

  it("accepts a matching Bearer token", () => {
    expect(bearerMatchesCronSecret(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("rejects a mismatched Bearer, missing header, or missing secret", () => {
    expect(bearerMatchesCronSecret(`Bearer ${secret}x`, secret)).toBe(false);
    expect(bearerMatchesCronSecret(`Bearer wrong`, secret)).toBe(false);
    expect(bearerMatchesCronSecret(secret, secret)).toBe(false);
    expect(bearerMatchesCronSecret(`Bearer ${secret}`, undefined)).toBe(false);
    expect(bearerMatchesCronSecret(null, secret)).toBe(false);
    expect(bearerMatchesCronSecret(`Bearer ${secret}`, "")).toBe(false);
  });
});
