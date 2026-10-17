#!/usr/bin/env node
/**
 * Read a local page and print safe identity fields only.
 * Do not print answers, sources, emails, or secrets.
 */
const url = process.argv[2];
if (!url || !url.startsWith("http://127.0.0.1:")) {
  console.error("verify-mega-rag: page-probe needs an http://127.0.0.1 URL");
  process.exit(1);
}

const response = await fetch(url, { redirect: "manual" });
const html = await response.text();
const csp = response.headers.get("content-security-policy");
const location = response.headers.get("location");
const match = html.match(
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
);

function locationGoesToLogin(header, baseUrl) {
  if (!header) {
    return false;
  }
  try {
    const parsed = header.startsWith("http") ? new URL(header) : new URL(header, baseUrl);
    return parsed.pathname === "/login";
  } catch {
    return false;
  }
}

const out = {
  status: response.status,
  hasNextData: Boolean(match),
  page: null,
  siteId: null,
  requireLogin: null,
  shortname: null,
  middlewareCsp: Boolean(csp),
  location: location || null,
  locationIsLogin: locationGoesToLogin(location, url),
  loginChunk: null,
};

if (match) {
  const data = JSON.parse(match[1]);
  out.page = data.page || null;
  const siteConfig = data?.props?.pageProps?.siteConfig || {};
  out.siteId = siteConfig.siteId || null;
  out.requireLogin = typeof siteConfig.requireLogin === "boolean" ? siteConfig.requireLogin : null;
  out.shortname = siteConfig.shortname || null;
}

const origin = new URL(url).origin;
const chunkUrl = `${origin}/_next/static/chunks/pages/login.js`;
try {
  const chunk = await fetch(chunkUrl, { method: "GET" });
  out.loginChunk = chunk.status;
} catch {
  out.loginChunk = 0;
}

console.log(JSON.stringify(out));
