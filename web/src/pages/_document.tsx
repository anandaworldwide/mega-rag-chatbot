// Custom Document component for Next.js
import Document, { Html, Head, Main, NextScript } from "next/document";
import type { DocumentContext, DocumentInitialProps } from "next/document";
import { getRequestNonce } from "@/utils/server/cspNonce";

type AppDocumentProps = DocumentInitialProps & {
  nonce?: string;
};

export function nonceFromDocumentContext(ctx: { req?: { headers?: Record<string, string | string[] | undefined> } }): string | undefined {
  return getRequestNonce(ctx.req?.headers);
}

export default function AppDocument({ nonce }: AppDocumentProps) {
  // Use a generic app title - the manifest.json will have the site-specific name
  const appTitle = "Chatbot";

  return (
    <Html lang="en">
      <Head nonce={nonce}>
        {/* PWA Manifest - dynamically generated based on site config */}
        <link rel="manifest" href="/api/manifest.json" />
        {/* Theme Color */}
        <meta name="theme-color" content="#ff6b35" />
        {/* iOS Safari PWA Support */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={appTitle} />
        {/* Apple Touch Icon */}
        <link rel="apple-touch-icon" sizes="180x180" href="/api/apple-touch-icon" />
        {/* Favicon */}
        <link rel="icon" href="/favicon.ico" />
        {/* Include Material Icons font */}
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet" />
        {/* Include Open Sans font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body>
        {/* Main content will be injected here */}
        <Main />
        {/* Next.js scripts receive the CSP nonce from middleware */}
        <NextScript nonce={nonce} />
      </body>
    </Html>
  );
}

AppDocument.getInitialProps = async (ctx: DocumentContext): Promise<AppDocumentProps> => {
  const initialProps = await Document.getInitialProps(ctx);
  const nonce = nonceFromDocumentContext(ctx);
  return { ...initialProps, nonce };
};
