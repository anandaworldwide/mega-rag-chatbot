import { useEffect, useState } from "react"
import type { GetServerSideProps } from "next"
import type { NextApiRequest } from "next"
import { AdminLayout } from "@/components/AdminLayout"
import { loadSiteConfig } from "@/utils/server/loadSiteConfig"
import { isAdminPageAllowed } from "@/utils/server/adminPageGate"
import { fetchWithAuth } from "@/utils/client/tokenManager"
import type { SiteConfig } from "@/types/siteConfig"

interface ModelPerformanceMetricSummary {
  mean: number
  stdDev: number
  count: number
}

interface ModelPerformanceSummary {
  model: string
  count: number
  metrics: {
    ttfbMs: ModelPerformanceMetricSummary
    answerStreamingMs: ModelPerformanceMetricSummary
    totalSessionMs: ModelPerformanceMetricSummary
    tokensPerSecond: ModelPerformanceMetricSummary
    totalTokens: ModelPerformanceMetricSummary
  }
}

interface ModelPerformanceResponse {
  siteId: string
  lookbackDays: number
  since: string
  generatedAt: string
  totals: {
    totalRecords: number
    errorRecords: number
  }
  models: ModelPerformanceSummary[]
}

interface ModelPerformanceProps {
  siteConfig: SiteConfig | null
}

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00"
}

export const getServerSideProps: GetServerSideProps = async ({ req }) => {
  const siteConfig = await loadSiteConfig()
  const isAllowed = await isAdminPageAllowed(req as NextApiRequest, undefined, siteConfig)

  if (!isAllowed) {
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    }
  }

  return {
    props: {
      siteConfig,
    },
  }
}

export default function ModelPerformance({ siteConfig }: ModelPerformanceProps) {
  const [data, setData] = useState<ModelPerformanceResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchStats = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await fetchWithAuth("/api/admin/model-performance")
        if (!response.ok) {
          throw new Error("Failed to load model performance data")
        }
        const payload = (await response.json()) as ModelPerformanceResponse
        setData(payload)
      } catch (err) {
        console.error("Error fetching model performance data:", err)
        setError("Failed to load model performance data")
      } finally {
        setIsLoading(false)
      }
    }

    fetchStats()
  }, [])

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Model Performance</h1>
        <p className="text-sm text-gray-600 mt-1">Averages per model over the last 7 days</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        </div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4 mb-6">
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Total records</div>
              <div className="text-lg font-semibold text-gray-900">{data?.totals.totalRecords ?? 0}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Error records</div>
              <div className="text-lg font-semibold text-gray-900">{data?.totals.errorRecords ?? 0}</div>
            </div>
            {data?.generatedAt && (
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Last updated</div>
                <div className="text-sm font-medium text-gray-900">
                  {new Date(data.generatedAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full bg-white border border-gray-200">
              <thead>
                <tr className="bg-gray-50">
                  <th className="whitespace-nowrap px-4 py-2 border text-left">Model</th>
                  <th className="whitespace-nowrap px-4 py-2 border text-left">Requests</th>
                  <th className="whitespace-nowrap px-4 py-2 border text-left">TTFB</th>
                  <th className="whitespace-nowrap px-4 py-2 border text-left">Streaming</th>
                  <th className="whitespace-nowrap px-4 py-2 border text-left">Total</th>
                  <th className="whitespace-nowrap px-4 py-2 border text-left">Tokens/sec</th>
                  <th className="whitespace-nowrap px-4 py-2 border text-left">Total tokens</th>
                </tr>
              </thead>
              <tbody>
                {data?.models.map((model) => (
                  <tr key={model.model} className="hover:bg-gray-50">
                    <td className="px-4 py-2 border font-medium text-gray-900">{model.model}</td>
                    <td className="px-4 py-2 border text-gray-700">{model.count}</td>
                    <td className="px-4 py-2 border text-gray-700">
                      <div>
                        {formatSeconds(model.metrics.ttfbMs.mean)} +/- {formatSeconds(model.metrics.ttfbMs.stdDev)}
                      </div>
                      <div className="text-xs text-gray-500">n={model.metrics.ttfbMs.count}</div>
                    </td>
                    <td className="px-4 py-2 border text-gray-700">
                      <div>
                        {formatSeconds(model.metrics.answerStreamingMs.mean)} +/-{" "}
                        {formatSeconds(model.metrics.answerStreamingMs.stdDev)}
                      </div>
                      <div className="text-xs text-gray-500">n={model.metrics.answerStreamingMs.count}</div>
                    </td>
                    <td className="px-4 py-2 border text-gray-700">
                      <div>
                        {formatSeconds(model.metrics.totalSessionMs.mean)} +/-{" "}
                        {formatSeconds(model.metrics.totalSessionMs.stdDev)}
                      </div>
                      <div className="text-xs text-gray-500">n={model.metrics.totalSessionMs.count}</div>
                    </td>
                    <td className="px-4 py-2 border text-gray-700">
                      <div>
                        {formatNumber(model.metrics.tokensPerSecond.mean)} +/-{" "}
                        {formatNumber(model.metrics.tokensPerSecond.stdDev)}
                      </div>
                      <div className="text-xs text-gray-500">n={model.metrics.tokensPerSecond.count}</div>
                    </td>
                    <td className="px-4 py-2 border text-gray-700">
                      <div>
                        {formatNumber(model.metrics.totalTokens.mean)} +/-{" "}
                        {formatNumber(model.metrics.totalTokens.stdDev)}
                      </div>
                      <div className="text-xs text-gray-500">n={model.metrics.totalTokens.count}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )

  return (
    <AdminLayout siteConfig={siteConfig} pageTitle="Model Performance">
      {mainContent}
    </AdminLayout>
  )
}
