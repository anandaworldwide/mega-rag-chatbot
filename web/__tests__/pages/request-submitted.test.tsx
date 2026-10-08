/**
 * @jest-environment jsdom
 */

import { GetServerSidePropsContext } from "next";
import { getServerSideProps } from "../../src/pages/request-submitted";
import { loadSiteConfig } from "../../src/utils/server/loadSiteConfig";

jest.mock("../../src/utils/server/loadSiteConfig");
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("/request-submitted - Server-Side Rendering", () => {
  const mockContext = {
    req: {},
    res: {},
    query: {},
    params: {},
    resolvedUrl: "/request-submitted",
  } as GetServerSidePropsContext;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should allow access when requireLogin is true", async () => {
    mockLoadSiteConfig.mockResolvedValue({
      name: "Test Site",
      requireLogin: true,
    } as any);

    const result = await getServerSideProps(mockContext);

    expect(result).toEqual({
      props: {
        siteConfig: {
          name: "Test Site",
          requireLogin: true,
        },
      },
    });
  });

  it("should return 404 when requireLogin is false", async () => {
    mockLoadSiteConfig.mockResolvedValue({
      name: "Library Magic",
      requireLogin: false,
    } as any);

    const result = await getServerSideProps(mockContext);

    expect(result).toEqual({
      notFound: true,
    });
  });

  it("should return 404 when requireLogin is undefined", async () => {
    mockLoadSiteConfig.mockResolvedValue({
      name: "Public Site",
    } as any);

    const result = await getServerSideProps(mockContext);

    expect(result).toEqual({
      notFound: true,
    });
  });
});
