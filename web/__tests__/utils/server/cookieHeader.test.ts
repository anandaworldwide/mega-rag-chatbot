/** @jest-environment node */

import { NextRequest } from "next/server";
import {
  APP_COOKIE_NAMES,
  cookieValuesNamed,
  countAppCookiesInHeader,
} from "@/utils/server/cookieHeader";

/** Pages Router `cookie.parse` keeps the first value for a name. */
function parseFirstWins(header: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (!key || Object.prototype.hasOwnProperty.call(parsed, key)) {
      continue;
    }
    parsed[key] = part.slice(separator + 1).trim();
  }
  return parsed;
}

const PARENT_UUID = "11111111-1111-4111-8111-111111111111";
const HOST_UUID = "22222222-2222-4222-8222-222222222222--hostsig";
const PARENT_AUTH = "parent-auth-token";
const HOST_AUTH = "host-auth-token";

function thirdPartyCookies(count: number): string {
  return Array.from({ length: count }, (_, index) => `_ga_extra_${index}=val${index}`).join("; ");
}

function shadowedCookieHeader(): string {
  return [
    thirdPartyCookies(31),
    `uuid=${PARENT_UUID}`,
    `authToken=${PARENT_AUTH}`,
    `uuid=${HOST_UUID}`,
    `authToken=${HOST_AUTH}`,
  ].join("; ");
}

describe("parent-domain Cookie header parsing", () => {
  const header = shadowedCookieHeader();

  it("keeps the parent uuid and authToken when Pages cookie.parse sees duplicates", () => {
    const parsed = parseFirstWins(header);
    expect(parsed.uuid).toBe(PARENT_UUID);
    expect(parsed.authToken).toBe(PARENT_AUTH);
  });

  it("keeps the host uuid and authToken when Next.js RequestCookies sees duplicates", () => {
    const req = new NextRequest("https://vivek.ananda.org/api/clone-conversation", {
      method: "POST",
      headers: {
        cookie: header,
        origin: "https://vivek.ananda.org",
        "content-type": "application/json",
      },
    });

    expect(req.headers.get("referer")).toBeNull();
    expect(req.headers.get("origin")).toBe("https://vivek.ananda.org");
    // Next.js RequestCookies first-vs-last is environment-dependent.
    // cookieValuesNamed must still return both host and parent values.
    expect([PARENT_UUID, HOST_UUID]).toContain(req.cookies.get("uuid")?.value);
    expect([PARENT_AUTH, HOST_AUTH]).toContain(req.cookies.get("authToken")?.value);
  });

  it("returns every uuid and authToken value in header order", () => {
    expect(cookieValuesNamed(header, "uuid")).toEqual([PARENT_UUID, HOST_UUID]);
    expect(cookieValuesNamed(header, "authToken")).toEqual([PARENT_AUTH, HOST_AUTH]);
  });

  it("counts only this app's cookie names so 31 analytics cookies do not look excessive", () => {
    expect(APP_COOKIE_NAMES.has("uuid")).toBe(true);
    expect(countAppCookiesInHeader(thirdPartyCookies(31))).toBe(0);
    expect(countAppCookiesInHeader(header)).toBe(4);
    expect(countAppCookiesInHeader(`${thirdPartyCookies(31)}; uuid=a; Path=/; HttpOnly`)).toBe(1);
  });
});
