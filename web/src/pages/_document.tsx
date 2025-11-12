// Custom Document component for Next.js
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  // Use a generic app title - the manifest.json will have the site-specific name
  // This avoids needing getInitialProps which can cause issues in production
  const appTitle = "Chatbot";

  return (
    <Html lang="en">
      <Head>
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
        {/* Next.js scripts */}
        <NextScript />
      </body>
    </Html>
  );
}
