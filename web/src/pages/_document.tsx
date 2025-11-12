// Custom Document component for Next.js
import { Html, Head, Main, NextScript, DocumentContext } from "next/document";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

interface DocumentProps {
  shortname: string;
}

export default function Document({ shortname }: DocumentProps) {
  return (
    <Html lang="en">
      <Head>
        {/* PWA Manifest - dynamically generated based on site config */}
        <link rel="manifest" href="/manifest.json" />
        {/* Theme Color */}
        <meta name="theme-color" content="#ff6b35" />
        {/* iOS Safari PWA Support */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={shortname || "Chatbot"} />
        {/* Apple Touch Icon */}
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
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
        {/* Next.js scripts */}
        <NextScript />
      </body>
    </Html>
  );
}

Document.getInitialProps = async (ctx: DocumentContext) => {
  // Load site config to get shortname for apple-mobile-web-app-title
  const siteConfig = loadSiteConfigSync();
  const shortname = siteConfig?.shortname || "Chatbot";

  // Render the page to get default props
  await ctx.renderPage();

  return {
    shortname,
  };
};
