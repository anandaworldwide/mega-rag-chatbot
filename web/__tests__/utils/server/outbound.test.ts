/** @jest-environment node */

const mockSend = jest.fn().mockResolvedValue({ MessageId: "mock-ses-id" });

jest.mock("@aws-sdk/client-ses", () => ({
  SESClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  SendEmailCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn().mockReturnValue({
    name: "Test Site",
    shortname: "test",
  }),
}));

import { SendEmailCommand } from "@aws-sdk/client-ses";
import { sendOutboundEmail } from "@/utils/server/outbound";
import { sendLoginEmail } from "@/utils/server/userLoginMagicUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";

const sampleInput = {
  Source: "noreply@example.com",
  Destination: {
    ToAddresses: ["user@example.com"],
    CcAddresses: ["copy@example.com"],
    BccAddresses: ["hidden@example.com"],
  },
  Message: {
    Subject: { Data: "Original subject" },
    Body: { Text: { Data: "secret body" } },
  },
};

describe("sendOutboundEmail", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OUTBOUND_SINK_EMAIL;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("skips SES when VERCEL_ENV is preview and no sink is set", async () => {
    process.env.VERCEL_ENV = "preview";
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await sendOutboundEmail(sampleInput);

    expect(result).toEqual({ MessageId: "outbound-skipped" });
    expect(SendEmailCommand).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[outbound] skipped SES send (non-production, no sink)");
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("secret body");
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("user@example.com");
    logSpy.mockRestore();
  });

  it("routes to the sink and prefixes the subject in preview", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.OUTBOUND_SINK_EMAIL = "sink@example.test";

    const result = await sendOutboundEmail(sampleInput);

    expect(result).toEqual({ MessageId: "mock-ses-id" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledWith({
      ...sampleInput,
      Destination: {
        ToAddresses: ["sink@example.test"],
      },
      Message: {
        ...sampleInput.Message,
        Subject: { Data: "[PREVIEW] Original subject" },
      },
    });
  });

  it("keeps ReplyToAddresses in sink mode", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.OUTBOUND_SINK_EMAIL = "sink@example.test";

    await sendOutboundEmail({
      ...sampleInput,
      ReplyToAddresses: ["reply@example.com"],
    });

    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: {
          ToAddresses: ["sink@example.test"],
        },
        ReplyToAddresses: ["reply@example.com"],
      })
    );
  });

  it("does not double prefix an existing [PREVIEW] subject", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.OUTBOUND_SINK_EMAIL = "sink@example.test";

    await sendOutboundEmail({
      ...sampleInput,
      Message: {
        ...sampleInput.Message,
        Subject: { Data: "[PREVIEW] Already marked" },
      },
    });

    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Message: expect.objectContaining({
          Subject: { Data: "[PREVIEW] Already marked" },
        }),
      })
    );
  });

  it("sends the original recipients when VERCEL_ENV is production", async () => {
    process.env.VERCEL_ENV = "production";

    const result = await sendOutboundEmail(sampleInput);

    expect(result).toEqual({ MessageId: "mock-ses-id" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledWith(sampleInput);
  });
});

describe("magic link preview guard", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_BASE_URL = "https://test.example.com";
    process.env.CONTACT_EMAIL = "noreply@example.com";
    process.env.SITE_ID = "test";
    delete process.env.OUTBOUND_SINK_EMAIL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not call SES when VERCEL_ENV is preview and no sink is set", async () => {
    process.env.VERCEL_ENV = "preview";
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    await sendLoginEmail("user@example.com", "login-token");

    expect(SendEmailCommand).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("routes the magic link to the sink in preview", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.OUTBOUND_SINK_EMAIL = "sink@example.test";

    await sendLoginEmail("user@example.com", "login-token");

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: { ToAddresses: ["sink@example.test"] },
        Message: expect.objectContaining({
          Subject: expect.objectContaining({
            Data: "[PREVIEW] Sign in to Test Site",
          }),
        }),
      })
    );
  });

  it("calls SES when VERCEL_ENV is production", async () => {
    process.env.VERCEL_ENV = "production";

    await sendLoginEmail("user@example.com", "login-token");

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: { ToAddresses: ["user@example.com"] },
      })
    );
  });
});

describe("ops alert preview guard", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    process.env.CONTACT_EMAIL = "noreply@example.com";
    process.env.SITE_ID = "ananda";
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    delete process.env.JEST_WORKER_ID;
    delete process.env.OUTBOUND_SINK_EMAIL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not call SES when VERCEL_ENV is preview and no sink is set", async () => {
    process.env.VERCEL_ENV = "preview";
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await sendOpsAlert("Disk full", "Ops body");

    expect(result).toBe(true);
    expect(SendEmailCommand).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("routes the ops alert to the sink in preview", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.OUTBOUND_SINK_EMAIL = "sink@example.test";

    const result = await sendOpsAlert("Disk full", "Ops body");

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: { ToAddresses: ["sink@example.test"] },
        Message: expect.objectContaining({
          Subject: expect.objectContaining({
            Data: expect.stringMatching(/^\[PREVIEW\] /),
          }),
        }),
      })
    );
  });

  it("calls SES when VERCEL_ENV is production", async () => {
    process.env.VERCEL_ENV = "production";

    const result = await sendOpsAlert("Disk full", "Ops body");

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: { ToAddresses: ["ops@example.com"] },
      })
    );
  });
});
