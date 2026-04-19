import Head from "next/head";
import { SiteConfig } from "@/types/siteConfig";
import { SudoProvider } from "@/contexts/SudoContext";
import type { GetServerSideProps, NextApiRequest, NextApiResponse } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isSuperuserPageAllowed } from "@/utils/server/adminPageGate";
import { AdminLayout } from "@/components/AdminLayout";
import { useState } from "react";

interface CronJobsPageProps {
  siteConfig: SiteConfig | null;
}

const CronJobsPage = ({ siteConfig }: CronJobsPageProps) => {
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, { success: boolean; message: string }>>({});

  const triggerCronJob = async (jobName: string, endpoint: string) => {
    setLoading((prev) => ({ ...prev, [jobName]: true }));
    setResults((prev) => ({ ...prev, [jobName]: { success: false, message: "" } }));

    try {
      const tokenRes = await fetch("/api/web-token");
      if (!tokenRes.ok) {
        throw new Error("Failed to get authentication token");
      }
      const tokenData = await tokenRes.json();
      const token = tokenData.token;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (response.ok) {
        setResults((prev) => ({
          ...prev,
          [jobName]: { success: true, message: data.message || "Job completed successfully" },
        }));
      } else {
        setResults((prev) => ({
          ...prev,
          [jobName]: { success: false, message: data.error || "Job failed" },
        }));
      }
    } catch (error) {
      setResults((prev) => ({
        ...prev,
        [jobName]: {
          success: false,
          message: error instanceof Error ? error.message : "Unknown error occurred",
        },
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [jobName]: false }));
    }
  };

  const cronJobs = [
    {
      name: "Download Locations",
      endpoint: "/api/cron/download-locations",
      description: "Downloads location data CSV from external source and updates S3 if changed",
    },
    {
      name: "Model Performance Digest",
      endpoint: "/api/admin/model-performance-digest",
      description: "Sends daily email digest of model performance metrics for the last 24 hours",
    },
  ];

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Trigger Cron Jobs</h1>
        <p className="text-sm text-gray-600 mt-1">Manually trigger scheduled cron jobs for testing purposes</p>
      </div>

      <div className="space-y-4">
        {cronJobs.map((job) => (
          <div key={job.name} className="border border-gray-200 rounded-lg p-6">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-gray-900 mb-2">{job.name}</h2>
                <p className="text-sm text-gray-600 mb-4">{job.description}</p>
                {results[job.name] && (
                  <div
                    className={`text-sm p-3 rounded ${
                      results[job.name].success
                        ? "bg-green-50 text-green-800 border border-green-200"
                        : "bg-red-50 text-red-800 border border-red-200"
                    }`}
                  >
                    {results[job.name].message}
                  </div>
                )}
              </div>
              <button
                onClick={() => triggerCronJob(job.name, job.endpoint)}
                disabled={loading[job.name]}
                className={`px-4 py-2 rounded font-medium ${
                  loading[job.name]
                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                {loading[job.name] ? (
                  <span className="flex items-center">
                    <span className="material-icons text-sm mr-2 animate-spin">refresh</span>
                    Running...
                  </span>
                ) : (
                  <span className="flex items-center">
                    <span className="material-icons text-sm mr-2">play_arrow</span>
                    Trigger
                  </span>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <SudoProvider disableChecks={!!siteConfig?.requireLogin}>
      <>
        <Head>
          <title>Trigger Cron Jobs - Admin</title>
        </Head>
        <AdminLayout siteConfig={siteConfig} pageTitle="Trigger Cron Jobs" superuserOnly>
          <div className="max-w-4xl">{mainContent}</div>
        </AdminLayout>
      </>
    </SudoProvider>
  );
};

export default CronJobsPage;

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  const siteConfig = await loadSiteConfig();
  const allowed = isSuperuserPageAllowed(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
    siteConfig
  );
  if (!allowed) {
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }
  return { props: { siteConfig } };
};
