import { useRouter } from "next/router";
import { GetServerSideProps } from "next";
import AuthLayout from "@/components/AuthLayout";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { SiteConfig } from "@/types/siteConfig";

interface RequestSubmittedPageProps {
  siteConfig: SiteConfig;
}

export default function RequestSubmittedPage({ siteConfig }: RequestSubmittedPageProps) {
  const router = useRouter();

  const handleReturnToLogin = () => {
    router.push("/login");
  };

  return (
    <AuthLayout siteConfig={siteConfig} title="Request Submitted">
      <div className="p-8 text-center">
        <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-green-100 mb-4">
          <span className="material-icons text-green-600 text-4xl">check_circle</span>
        </div>

        <h2 className="text-3xl font-bold text-gray-900 mb-4">Request Submitted!</h2>
        <p className="text-lg text-gray-600 mb-6">
          Your access request has been sent to the selected admin. They will review it and send you an activation email
          if approved.
        </p>

        <button
          onClick={handleReturnToLogin}
          className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 transform hover:-translate-y-0.5 transition-all duration-200"
        >
          Return to Login
        </button>
      </div>
    </AuthLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async () => {
  const siteConfig = await loadSiteConfig();

  return {
    props: {
      siteConfig,
    },
  };
};
