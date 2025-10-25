import { useRouter } from "next/router";
import Head from "next/head";
import { SiteConfig } from "@/types/siteConfig";
import { getSiteName } from "@/utils/client/siteConfig";
import Layout from "@/components/layout";

interface ChooseAuthMethodProps {
  siteConfig: SiteConfig | null;
}

export default function ChooseAuthMethodPage({ siteConfig }: ChooseAuthMethodProps) {
  const router = useRouter();

  const handleSetPassword = () => {
    router.push("/set-password");
  };

  const handleContinueWithMagicLink = () => {
    router.push("/");
  };

  return (
    <>
      <Head>
        <title>Choose Login Method - {getSiteName(siteConfig)}</title>
      </Head>
      <Layout siteConfig={siteConfig}>
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
          <div className="p-6 bg-white rounded shadow-md max-w-md w-full">
            <h1 className="mb-4 text-2xl font-semibold">Welcome! Choose Your Login Method</h1>
            <p className="mb-6 text-gray-600">
              Your account is now active. Choose how you&apos;d like to log in next time:
            </p>

            <div className="space-y-4">
              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-lg mb-2">Continue with Magic Links</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Get a secure login link sent to your email each time. No password to remember.
                </p>
                <button
                  onClick={handleContinueWithMagicLink}
                  className="w-full p-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  Continue with Magic Links
                </button>
              </div>

              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-lg mb-2">Set a Password</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Log in quickly with your email and password. You can always use magic links as a backup.
                </p>
                <button
                  onClick={handleSetPassword}
                  className="w-full p-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                >
                  Set a Password
                </button>
              </div>
            </div>

            <p className="mt-4 text-xs text-gray-500 text-center">
              You can always set a password later from your profile settings.
            </p>
          </div>
        </div>
      </Layout>
    </>
  );
}

export async function getServerSideProps() {
  const { loadSiteConfigSync } = await import("@/utils/server/loadSiteConfig");
  const siteConfig = loadSiteConfigSync();

  return {
    props: {
      siteConfig,
    },
  };
}
