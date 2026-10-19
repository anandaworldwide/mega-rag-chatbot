/** @jest-environment node */

import { resolveQueryRateLimitMax, resetQueryRateLimitDevMaxLogForTests } from "@/utils/server/queryRateLimit";

describe("resolveQueryRateLimitMax", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercel = process.env.VERCEL;
  const originalOverride = process.env.QUERY_RATE_LIMIT_DEV_MAX;
  const queriesPerUserPerDay = 50;
  const developmentDefault = queriesPerUserPerDay * 10;

  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetQueryRateLimitDevMaxLogForTests();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = originalVercel;
    }
    if (originalOverride === undefined) {
      delete process.env.QUERY_RATE_LIMIT_DEV_MAX;
    } else {
      process.env.QUERY_RATE_LIMIT_DEV_MAX = originalOverride;
    }
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  function setLocalDevelopment(): void {
    process.env.NODE_ENV = "development";
    delete process.env.VERCEL;
  }

  test("uses QUERY_RATE_LIMIT_DEV_MAX in local development", () => {
    setLocalDevelopment();
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "1000";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(1000);
  });

  test("ignores QUERY_RATE_LIMIT_DEV_MAX when VERCEL is set", () => {
    process.env.NODE_ENV = "development";
    process.env.VERCEL = "1";
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "1000";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(developmentDefault);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test("ignores QUERY_RATE_LIMIT_DEV_MAX in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VERCEL;
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "1000";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(queriesPerUserPerDay);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test("ignores QUERY_RATE_LIMIT_DEV_MAX in test", () => {
    process.env.NODE_ENV = "test";
    delete process.env.VERCEL;
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "1000";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(queriesPerUserPerDay);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test("ignores QUERY_RATE_LIMIT_DEV_MAX value 0", () => {
    setLocalDevelopment();
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "0";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(developmentDefault);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  test("ignores a negative QUERY_RATE_LIMIT_DEV_MAX value", () => {
    setLocalDevelopment();
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "-5";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(developmentDefault);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  test("ignores a non-numeric QUERY_RATE_LIMIT_DEV_MAX value", () => {
    setLocalDevelopment();
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "unlimited";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(developmentDefault);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  test("logs the override one time per process", () => {
    setLocalDevelopment();
    process.env.QUERY_RATE_LIMIT_DEV_MAX = "1000";

    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(1000);
    expect(resolveQueryRateLimitMax(queriesPerUserPerDay)).toBe(1000);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith("[rateLimit] QUERY_RATE_LIMIT_DEV_MAX override active: 1000");
  });
});
