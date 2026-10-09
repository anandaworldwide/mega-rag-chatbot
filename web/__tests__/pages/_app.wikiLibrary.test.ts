import MyApp from "@/pages/_app";
import { getCommonSiteConfigProps } from "@/utils/server/getCommonSiteConfigProps";
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

const siteConfig = {
  siteId: "ananda",
  requireLogin: true,
  includedLibraries: ["Ananda Library", "Ananda Family Wiki"],
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

describe("MyApp wiki library server path", () => {
  beforeEach(() => {
    mockGetProps.mockResolvedValue({
      props: { siteConfig, contactEmail: null },
    });
  });

  test("shows the wiki only when the middleware header is 1", async () => {
    const allowed = await MyApp.getInitialProps(appContext({ "x-wiki-library": "1" }));
    expect(allowed.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
  });

  test("hides the wiki when the middleware header is 0", async () => {
    const result = await MyApp.getInitialProps(appContext({ "x-wiki-library": "0" }));
    expect(result.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
  });

  test("hides the wiki when the header is missing, even if a client cookie says 1", async () => {
    const result = await MyApp.getInitialProps(
      appContext({
        cookie: "wikiLibrary=1",
      })
    );
    expect(result.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
  });

  test("hides the wiki when the header is unknown", async () => {
    const result = await MyApp.getInitialProps(appContext({ "x-wiki-library": "true" }));
    expect(result.pageProps.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
  });
});
