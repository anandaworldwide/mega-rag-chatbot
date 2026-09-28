import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/cron/remindLucaS3Backup";
import { sendOpsAlert } from "@/utils/server/emailOps";

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn(),
}));

jest.mock("@/utils/server/cronAuthUtils", () => ({
  withJwtOrCronAuth: jest.fn((routeHandler) => routeHandler),
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((routeHandler) => routeHandler),
}));

const mockSendOpsAlert = sendOpsAlert as jest.MockedFunction<typeof sendOpsAlert>;

describe("/api/cron/remindLucaS3Backup", () => {
  const originalSiteId = process.env.SITE_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SITE_ID = "ananda";
    mockSendOpsAlert.mockResolvedValue(true);
  });

  afterAll(() => {
    process.env.SITE_ID = originalSiteId;
  });

  function callHandler(method = "GET") {
    const { req, res } = createMocks({ method });
    return handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse).then(() => res);
  }

  it("sends the reminder from the Luca site", async () => {
    const res = await callHandler();

    expect(res._getStatusCode()).toBe(200);
    expect(mockSendOpsAlert).toHaveBeenCalledWith(
      "Reminder: back up Luca S3",
      expect.stringContaining("./bin/sync_ingest_backup_from_s3.sh ~/Desktop/luca-s3-backup"),
      undefined,
      { alertLabel: "" }
    );
  });

  it("does not send from any other site", async () => {
    process.env.SITE_ID = "crystal";

    const res = await callHandler();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "Skipped S3 backup reminder for site crystal",
      sent: false,
    });
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
  });

  it("returns 500 when the email fails", async () => {
    mockSendOpsAlert.mockResolvedValue(false);

    const res = await callHandler();

    expect(res._getStatusCode()).toBe(500);
  });
});