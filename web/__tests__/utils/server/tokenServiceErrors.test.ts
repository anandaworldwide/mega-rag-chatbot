import {
  buildTokenServiceFailureResponse,
  isModuleInteropError,
  TOKEN_SERVICE_UNAVAILABLE_CODE,
} from "@/utils/server/tokenServiceErrors";

describe("tokenServiceErrors", () => {
  it("detects ERR_REQUIRE_ESM module interop failures", () => {
    const error = new Error(
      "require() of ES Module /var/task/node_modules/uuid/dist-node/index.js from gaxios.js not supported."
    );
    (error as NodeJS.ErrnoException).code = "ERR_REQUIRE_ESM";

    expect(isModuleInteropError(error)).toBe(true);
    const response = buildTokenServiceFailureResponse(error);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe(TOKEN_SERVICE_UNAVAILABLE_CODE);
    expect(response.body.error).toMatch(/temporarily unavailable/i);
  });

  it("maps generic failures to TOKEN_SERVICE_UNAVAILABLE", () => {
    const response = buildTokenServiceFailureResponse(new Error("boom"));
    expect(response.status).toBe(500);
    expect(response.body.code).toBe(TOKEN_SERVICE_UNAVAILABLE_CODE);
    expect(response.body.error).not.toMatch(/boom/);
  });
});
