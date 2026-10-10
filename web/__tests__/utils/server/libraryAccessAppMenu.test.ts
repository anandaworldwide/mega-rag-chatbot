/** @jest-environment node */

jest.unmock("next/server");

import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";
import bundledSiteConfigs from "../../../site-config/config.json";
import { middleware } from "../../../middleware";
import { siteConfigForAppProps } from "@/utils/server/libraryAccessAppProps";
import { LIBRARY_ACCESS_HEADER, encodeLibraryAccessValue, libraryAccessCookieNames } from "@/utils/server/libraryAccess";
import { libraryEntryName } from "@/utils/libraryEntries";
import type { LibraryConfigEntry } from "@/types/siteConfig";

const LUCA_LIBRARIES = bundledSiteConfigs.ananda.includedLibraries as LibraryConfigEntry[];
const WIKI_NAME = "Ananda Family Wiki";
const secret = "library-access-menu-secret";

const lucaSiteConfig = {
  siteId: "ananda",
  requireLogin: true,
  includedLibraries: LUCA_LIBRARIES,
  allowedFrontEndDomains: ["localhost:3000", "example.com"],
};

function signAuthToken(email: string): string {
  return jwt.sign({ client: "web", email }, secret, {
    algorithm: "HS256",
    issuer: "mega-rag-chatbot",
    audience: "mega-rag-chatbot-users",
  });
}

/**
 * Copy Next.js resolve-routes.js: apply x-middleware-override-headers onto
 * a Node incoming-message headers object.
 */
function applyMiddlewareRequestOverrides(
  original: Record<string, string>,
  middlewareHeaders: Headers
): Record<string, string | undefined> {
  const applied: Record<string, string | undefined> = { ...original };
  const overrideList = middlewareHeaders.get("x-middleware-override-headers");
  if (!overrideList) {
    return applied;
  }
  const overridden = new Set(overrideList.split(",").map((key) => key.trim()));
  for (const key of Object.keys(applied)) {
    if (!overridden.has(key)) {
      delete applied[key];
    }
  }
  for (const key of overridden) {
    const value = middlewareHeaders.get(`x-middleware-request-${key}`);
    applied[key] = value === null ? undefined : value;
  }
  return applied;
}

function menuLibraryNames(siteConfig: { includedLibraries?: LibraryConfigEntry[] } | null | undefined): string[] {
  return (siteConfig?.includedLibraries || []).map(libraryEntryName);
}

describe("library menu through real middleware and _app props", () => {
  const originalEmails = process.env.WIKI_LIBRARY_EMAILS;
  const originalSecret = process.env.SECURE_TOKEN;
  const originalSite = process.env.SITE_ID;

  beforeEach(() => {
    process.env.SITE_ID = "ananda";
    process.env.SECURE_TOKEN = secret;
    process.env.WIKI_LIBRARY_EMAILS = "allowed@ananda.org";
  });

  afterEach(() => {
    if (originalEmails === undefined) {
      delete process.env.WIKI_LIBRARY_EMAILS;
    } else {
      process.env.WIKI_LIBRARY_EMAILS = originalEmails;
    }
    if (originalSecret === undefined) {
      delete process.env.SECURE_TOKEN;
    } else {
      process.env.SECURE_TOKEN = originalSecret;
    }
    if (originalSite === undefined) {
      delete process.env.SITE_ID;
    } else {
      process.env.SITE_ID = originalSite;
    }
  });

  test("an allowed auth cookie makes middleware name the wiki and _app render it in the menu", async () => {
    const incoming = {
      cookie: `authToken=${signAuthToken("allowed@ananda.org")}`,
    };
    expect(typeof NextResponse.next).toBe("function");
    const response = middleware(
      new NextRequest("http://localhost/", {
        headers: incoming,
      })
    );

    expect(response.headers.get(`x-middleware-request-${LIBRARY_ACCESS_HEADER}`)).toBe(
      encodeLibraryAccessValue([WIKI_NAME])
    );
    const setCookie = response.headers.get("set-cookie") || "";
    expect(libraryAccessCookieNames(setCookie)).toEqual([WIKI_NAME]);

    const forwarded = applyMiddlewareRequestOverrides(incoming, response.headers);
    expect(forwarded[LIBRARY_ACCESS_HEADER]).toBe(encodeLibraryAccessValue([WIKI_NAME]));

    const rendered = await siteConfigForAppProps(lucaSiteConfig, { headers: forwarded });
    expect(menuLibraryNames(rendered)).toContain(WIKI_NAME);

    // Pages getInitialProps often sees only the original Cookie header.
    const withoutForwardedHeader = await siteConfigForAppProps(lucaSiteConfig, { headers: incoming });
    expect(menuLibraryNames(withoutForwardedHeader)).toContain(WIKI_NAME);

    const clientNavigation = await siteConfigForAppProps(lucaSiteConfig, undefined, setCookie);
    expect(menuLibraryNames(clientNavigation)).toContain(WIKI_NAME);
  });

  test("a non-allowed auth cookie never puts the wiki in the middleware header or the menu", async () => {
    const incoming = {
      cookie: `authToken=${signAuthToken("visitor@ananda.org")}`,
    };
    const response = middleware(
      new NextRequest("http://localhost/", {
        headers: incoming,
      })
    );

    expect(response.headers.get(`x-middleware-request-${LIBRARY_ACCESS_HEADER}`)).toBe("");
    const forwarded = applyMiddlewareRequestOverrides(incoming, response.headers);
    const rendered = await siteConfigForAppProps(lucaSiteConfig, { headers: forwarded });
    expect(menuLibraryNames(rendered)).not.toContain(WIKI_NAME);

    const withoutForwardedHeader = await siteConfigForAppProps(lucaSiteConfig, { headers: incoming });
    expect(menuLibraryNames(withoutForwardedHeader)).not.toContain(WIKI_NAME);

    const clientNavigation = await siteConfigForAppProps(
      lucaSiteConfig,
      undefined,
      response.headers.get("set-cookie") || ""
    );
    expect(menuLibraryNames(clientNavigation)).not.toContain(WIKI_NAME);
  });
});
