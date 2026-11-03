/**
 * Sole AWS SES send path for the Next.js app.
 * Preview, development, and unset VERCEL_ENV never send to the original recipients.
 */
import { SESClient, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-ses";

export type OutboundSendResult = {
  MessageId: string;
};

const SKIPPED_MESSAGE_ID = "outbound-skipped";
const SINK_MESSAGE_ID = "outbound-sink";
const SUBJECT_PREFIX = "[PREVIEW]";

let sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (!sesClient) {
    sesClient = new SESClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }
  return sesClient;
}

function isProductionVercelEnv(): boolean {
  return process.env.VERCEL_ENV === "production";
}

function getSinkEmail(): string | undefined {
  const sink = process.env.OUTBOUND_SINK_EMAIL?.trim();
  return sink ? sink : undefined;
}

function getSubjectData(input: SendEmailCommandInput): string {
  return input.Message?.Subject?.Data ?? "";
}

function prefixPreviewSubject(subject: string): string {
  if (subject.startsWith(SUBJECT_PREFIX)) {
    return subject;
  }
  return subject ? `${SUBJECT_PREFIX} ${subject}` : SUBJECT_PREFIX;
}

function rewriteForSink(input: SendEmailCommandInput, sinkEmail: string): SendEmailCommandInput {
  const prefixedSubject = prefixPreviewSubject(getSubjectData(input));

  return {
    ...input,
    Destination: {
      ToAddresses: [sinkEmail],
    },
    Message: input.Message
      ? {
          ...input.Message,
          Subject: {
            ...input.Message.Subject,
            Data: prefixedSubject,
          },
        }
      : input.Message,
  };
}

async function sendViaSes(input: SendEmailCommandInput): Promise<OutboundSendResult> {
  const result = await getSesClient().send(new SendEmailCommand(input));
  return { MessageId: result.MessageId || SINK_MESSAGE_ID };
}

/**
 * Send one email through SES, or hold it when VERCEL_ENV is not production.
 *
 * Non-production:
 * - If OUTBOUND_SINK_EMAIL is set, send only to that address and prefix the subject with [PREVIEW].
 * - If it is not set, log a short line and return success without calling SES.
 */
export async function sendOutboundEmail(input: SendEmailCommandInput): Promise<OutboundSendResult> {
  if (!isProductionVercelEnv()) {
    const sinkEmail = getSinkEmail();
    if (sinkEmail) {
      return sendViaSes(rewriteForSink(input, sinkEmail));
    }

    console.log("[outbound] skipped SES send (non-production, no sink)");
    return { MessageId: SKIPPED_MESSAGE_ID };
  }

  return sendViaSes(input);
}
