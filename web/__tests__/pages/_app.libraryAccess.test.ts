import jwt from "jsonwebtoken";
import MyApp from "@/pages/_app";
import { getCommonSiteConfigProps } from "@/utils/server/getCommonSiteConfigProps";
import { encodeLibraryAccessValue } from "@/utils/server/libraryAccess";
import type { AppContext } from "next/app";

jest.mock("next/font/google", () => ({
  Inter: jest.fn(() => ({
    className: "mocked-font",
  })),
}));

jest.mock("@/utils/client/tokenManager", () => ({
  initializeTokenManager: jest.fn(() => Promise.resolve("token")),
  fetchWithAuth: jest.fn(),
}));

jest.mock("react-toastify", () => ({
  toast: { error: jest.fn(), warning: jest.fn() },
  ToastContainer: jest.fn(() => null),
}));

jest.mock("@/components/SessionExpiredModal", () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

jest.mock("@/components/AuthGuard", () => ({
  __esModule: true,
  default: jest.fn(({ children }) => children),
}));

jest.mock("nextjs-google-analytics", () => ({
  GoogleAnalytics: jest.fn(() => null),
  event: jest.fn(),
}));

jest.mock("@tanstack/react-query", () => ({
  QueryClientProvider: jest.fn(({ children }) => children),
}));

jest.mock("@/utils/client/reactQueryConfig", () => ({
  queryClient: {},
}));

jest.mock("@/utils/server/getCommonSiteConfigProps", () => ({
  getCommonSiteConfigProps: jest.fn(),
}));

const wikiLibrary = { name: "Ananda Family Wiki", accessEmailsEnv: "WIKI_LIBRARY_EMAILS" };
const siteConfig = {
  siteId: "ananda",
  requireLogin: true,
  includedLibraries: ["Ananda Library", wikiLibrary],
};

const mockGetProps = getCommonSiteConfigProps as jest.MockedFunction<typeof getCommonSiteConfigProps>;
const secret = "library-access-app-secret";

function signAuthToken(email: string): string {
  return jwt.sign({ client: "web", email }, secret, {
    algorithm: "HS256",
    issuer: "mega-rag-chatbot",
    audience: "mega-rag-chatbot-users",
  });
}

function appContext(headers?: Record<string, string | undefined>): AppContext {
  return {
    ctx: headers
      ? {
          req: { headers },
          res: { getHeader: jest.fn(), setHeader: jest.fn() },
        }
      : {},
    Component: () => null,
    router: { pathname: "/" } as AppContext["router"],
  } as unknown as AppContext;
}

function libraryNames(result: { pageProps: { siteConfig: { includedLibraries?: unknown[] } } }): unknown[] {
  return result.pageProps.siteConfig.includedLibraries || [];
}

describe("MyApp library access menu", () => {
  const originalEmails = process.env.WIKI_LIBRARY_EMAILS;
  const originalSecret = process.env.SECURE_TOKEN;
  let cookieDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockGetProps.mockResolvedValue({
      props: { siteConfig, contactEmail: null },
    });
    process.env.SECURE_TOKEN = secret;
    process.env.WIKI_LIBRARY_EMAILS = "allowed@ananda.org";
    cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
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
    if (cookieDescriptor) {
      Object.defineProperty(document, "cookie", cookieDescriptor);
    }
  });

  test("a server render with an allowed auth cookie includes the wiki in the menu", async () => {
    const result = await MyApp.getInitialProps(
      appContext({ cookie: `authToken=${signAuthToken("allowed@ananda.org")}` })
    );
    expect(libraryNames(result)).toEqual(["Ananda Library", wikiLibrary]);
  });

  test("a server render with a non-allowed auth cookie hides the wiki", async () => {
    const result = await MyApp.getInitialProps(
      appContext({ cookie: `authToken=${signAuthToken("visitor@ananda.org")}` })
    );
    expect(libraryNames(result)).toEqual(["Ananda Library"]);
  });

  test("a server render without an auth cookie hides the wiki even if a client header names it", async () => {
    const result = await MyApp.getInitialProps(
      appContext({
        "x-library-access": encodeLibraryAccessValue(["Ananda Family Wiki"]),
        cookie: `libraryAccess=${encodeLibraryAccessValue(["Ananda Family Wiki"])}`,
      })
    );
    expect(libraryNames(result)).toEqual(["Ananda Library"]);
  });

  test("a client navigation with the middleware libraryAccess cookie keeps the wiki", async () => {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => `libraryAccess=${encodeLibraryAccessValue(["Ananda Family Wiki"])}`,
      set() {
        /* jsdom cookie write */
      },
    });
    const result = await MyApp.getInitialProps(appContext());
    expect(libraryNames(result)).toEqual(["Ananda Library", wikiLibrary]);
  });

  test("a client navigation without the libraryAccess cookie hides the wiki", async () => {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set() {
        /* jsdom cookie write */
      },
    });
    const result = await MyApp.getInitialProps(appContext());
    expect(libraryNames(result)).toEqual(["Ananda Library"]);
  });
});
