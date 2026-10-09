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

function appContext(headers: Record<string, string | undefined>): AppContext {
  return {
    ctx: {
      req: { headers },
      res: { getHeader: jest.fn(), setHeader: jest.fn() },
    },
    Component: () => null,
    router: { pathname: "/" } as AppContext["router"],
  } as unknown as AppContext;
}

describe("MyApp library access server path", () => {
  beforeEach(() => {
    mockGetProps.mockResolvedValue({
      props: { siteConfig, contactEmail: null },
    });
  });

  test("shows a restricted library only when the middleware header names it", async () => {
    const allowed = await MyApp.getInitialProps(
      appContext({ "x-library-access": encodeLibraryAccessValue(["Ananda Family Wiki"]) })
    );
    expect(allowed.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library", wikiLibrary]);
  });

  test("hides a restricted library when the middleware header is empty", async () => {
    const result = await MyApp.getInitialProps(appContext({ "x-library-access": "" }));
    expect(result.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
  });

  test("hides a restricted library when the header is missing, even if a client cookie names it", async () => {
    const result = await MyApp.getInitialProps(
      appContext({
        cookie: `libraryAccess=${encodeLibraryAccessValue(["Ananda Family Wiki"])}`,
      })
    );
    expect(result.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
  });

  test("hides a restricted library when the header is unknown", async () => {
    const result = await MyApp.getInitialProps(appContext({ "x-library-access": "true" }));
    expect(result.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
  });
});
