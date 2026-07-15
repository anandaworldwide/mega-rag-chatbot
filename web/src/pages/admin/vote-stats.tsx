import { useCallback, useEffect, useState } from "react";
import type { GetServerSideProps, NextApiRequest } from "next";
import Head from "next/head";
import Link from "next/link";
import { AdminLayout } from "@/components/AdminLayout";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isSuperuserPageAllowed } from "@/utils/server/adminPageGate";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import type { SiteConfig } from "@/types/siteConfig";

type VoteStatsLookbackDays = 7 | 30;

interface VoteStatsArmSummary {
  arm: string;
  answers: number;
  comparableAnswers: number;
  upvotes: number;
  downvotes: number;
  comparableUpvotes: number;
  comparableDownvotes: number;
  geoOrOverrideVotes: number;
}

interface VoteStatsResponse {
  siteId: string;
  lookbackDays: VoteStatsLookbackDays;
  since: string;
  generatedAt: string;
  summary: {
    answersInWindow: number;
    answersWithModel: number;
    answersWithAbTestModel: number;
    answersWithoutAbTestModel: number;
    geoAnswers: number;
    upvotes: number;
    downvotes: number;
    comparableVotes: number;
    comparableUpvotes: number;
    comparableDownvotes: number;
    downvoteEventsInWindow: number;
  };
  arms: VoteStatsArmSummary[];
  modelCounts: Array<{ model: string; count: number }>;
  recentVotes: Array<{
    id: string;
    vote: 1 | -1;
    model: string | null;
    abTestModel: string | null;
    isLocationQuery: boolean;
    comparable: boolean;
    question: string;
    feedbackReason: string | null;
    feedbackComment: string | null;
    timestamp: string | null;
  }>;
  recentDownvoteEvents: Array<{
    id: string;
    answerDocId: string | null;
    question: string;
    reason: string | null;
    comment: string | null;
    model: string | null;
    abTestModel: string | null;
    triageCategory: string | null;
    triageStatus: string | null;
    createdAt: string | null;
  }>;
}

interface VoteStatsPageProps {
  siteConfig: SiteConfig | null;
}

function rateLabel(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(0)}%`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function armLabel(arm: string): string {
  if (arm === "(no abTestModel)") return "No A/B arm";
  if (arm === "grok-4.5") return "grok-4.5 (treatment)";
  if (arm === "claude-fable-5") return "claude-fable-5 (holdout)";
  if (arm === "gpt-4o") return "gpt-4o (control)";
  return arm;
}

export const getServerSideProps: GetServerSideProps = async ({ req }) => {
  const siteConfig = await loadSiteConfig();
  const isAllowed = await isSuperuserPageAllowed(req as NextApiRequest, undefined, siteConfig);

  if (!isAllowed) {
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }

  return {
    props: {
      siteConfig,
    },
  };
};

export default function VoteStatsPage({ siteConfig }: VoteStatsPageProps) {
  const [lookbackDays, setLookbackDays] = useState<VoteStatsLookbackDays>(7);
  const [data, setData] = useState<VoteStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (days: VoteStatsLookbackDays) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth(`/api/admin/vote-stats?days=${days}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to load vote stats");
      }
      const payload = (await response.json()) as VoteStatsResponse;
      setData(payload);
    } catch (err) {
      console.error("Error fetching vote stats:", err);
      setError(err instanceof Error ? err.message : "Failed to load vote stats");
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats(lookbackDays);
  }, [fetchStats, lookbackDays]);

  const abTraffic = data?.summary.answersWithAbTestModel || 0;
  const treatmentArm = data?.arms.find((arm) => arm.arm === "grok-4.5");
  const holdoutArm = data?.arms.find((arm) => arm.arm === "claude-fable-5");
  const treatmentShare =
    abTraffic > 0 && treatmentArm ? `${((treatmentArm.answers / abTraffic) * 100).toFixed(0)}% Grok` : null;
  const holdoutShare =
    abTraffic > 0 && holdoutArm ? `${((holdoutArm.answers / abTraffic) * 100).toFixed(0)}% Fable holdout` : null;

  const mainContent = (
    <>
      <Head>
        <title>Vote & A/B Stats - Admin</title>
      </Head>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Vote & A/B Stats</h1>
          <p className="mt-1 text-sm text-gray-600">
            Upvotes and downvotes on answers created in the selected window, with Claude A/B comparable rates.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {([7, 30] as VoteStatsLookbackDays[]).map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setLookbackDays(days)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                lookbackDays === days ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              Last {days} days
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {isLoading && !data && <div className="text-sm text-gray-500">Loading vote stats…</div>}

      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={`Answers (${data.lookbackDays}d)`} value={data.summary.answersInWindow} />
            <StatCard label="In A/B arms" value={data.summary.answersWithAbTestModel} />
            <StatCard label="Upvotes" value={data.summary.upvotes} accent="green" />
            <StatCard label="Downvotes" value={data.summary.downvotes} accent="red" />
          </div>

          {data.summary.comparableVotes === 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              No comparable A/B votes in this window (votes where <code>model === abTestModel</code> and not a location
              query). Traffic may be present while feedback volume is still low.
            </div>
          )}

          <section className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <h2 className="text-lg font-semibold text-gray-900">A/B arm rates</h2>
              <p className="mt-1 text-sm text-gray-600">
                Comparable rates only count votes where the execution model matches the sticky arm and the answer was
                not a location query.
                {treatmentShare || holdoutShare
                  ? ` Live mix: ${[treatmentShare, holdoutShare].filter(Boolean).join(", ")}.`
                  : ""}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">Arm</th>
                    <th className="px-4 py-2 font-medium">Answers</th>
                    <th className="px-4 py-2 font-medium">Comparable</th>
                    <th className="px-4 py-2 font-medium">Up</th>
                    <th className="px-4 py-2 font-medium">Down</th>
                    <th className="px-4 py-2 font-medium">Up rate</th>
                    <th className="px-4 py-2 font-medium">Down rate</th>
                    <th className="px-4 py-2 font-medium">Geo/override votes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.arms.map((arm) => (
                    <ArmRow key={arm.arm} arm={arm} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-gray-200 px-4 py-3 text-xs text-gray-600">
              <span className="rounded-full bg-gray-100 px-2.5 py-1">
                Comparable votes: {data.summary.comparableVotes}
              </span>
              <span className="rounded-full bg-gray-100 px-2.5 py-1">Geo answers: {data.summary.geoAnswers}</span>
              <span className="rounded-full bg-gray-100 px-2.5 py-1">
                No A/B arm: {data.summary.answersWithoutAbTestModel}
              </span>
              <span className="rounded-full bg-gray-100 px-2.5 py-1">
                Downvote events created: {data.summary.downvoteEventsInWindow}
              </span>
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-200 px-4 py-3">
                <h2 className="text-lg font-semibold text-gray-900">Execution model mix</h2>
                <p className="mt-1 text-sm text-gray-600">Answers by stored <code>model</code> field.</p>
              </div>
              <div className="space-y-3 px-4 py-4">
                {data.modelCounts.map((item) => {
                  const pct =
                    data.summary.answersInWindow > 0
                      ? Math.round((item.count / data.summary.answersInWindow) * 100)
                      : 0;
                  return (
                    <div key={item.model}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="font-medium text-gray-800">{item.model}</span>
                        <span className="text-gray-600">
                          {item.count} ({pct}%)
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded bg-gray-100">
                        <div className="h-full rounded bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
                {data.modelCounts.length === 0 && (
                  <p className="text-sm text-gray-500">No answers in this window.</p>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-200 px-4 py-3">
                <h2 className="text-lg font-semibold text-gray-900">How to read this</h2>
              </div>
              <div className="space-y-3 px-4 py-4 text-sm text-gray-700">
                <p>
                  Window starts at <span className="font-mono text-xs">{data.since}</span>. Generated{" "}
                  <span className="font-mono text-xs">{data.generatedAt}</span>.
                </p>
                <p>
                  Upvotes have no separate vote timestamp, so this dashboard counts votes on answers{" "}
                  <strong>created</strong> in the window. Downvote feedback events use their own{" "}
                  <code>createdAt</code>.
                </p>
                <p>
                  For triage of individual downvotes, use{" "}
                  <Link href="/admin/downvotes" className="text-blue-600 hover:underline">
                    Review Downvotes
                  </Link>
                  .
                </p>
              </div>
            </section>
          </div>

          <section className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <h2 className="text-lg font-semibold text-gray-900">Votes on answers in window</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">When</th>
                    <th className="px-4 py-2 font-medium">Vote</th>
                    <th className="px-4 py-2 font-medium">model</th>
                    <th className="px-4 py-2 font-medium">abTestModel</th>
                    <th className="px-4 py-2 font-medium">Comparable</th>
                    <th className="px-4 py-2 font-medium">Question</th>
                    <th className="px-4 py-2 font-medium">Doc</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentVotes.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                        No upvotes or downvotes on answers created in this window.
                      </td>
                    </tr>
                  ) : (
                    data.recentVotes.map((vote) => (
                      <tr key={vote.id} className="border-t border-gray-100">
                        <td className="whitespace-nowrap px-4 py-2 text-gray-600">{formatWhen(vote.timestamp)}</td>
                        <td className="px-4 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              vote.vote === 1 ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                            }`}
                          >
                            {vote.vote === 1 ? "Up" : "Down"}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-800">{vote.model || "—"}</td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-800">{vote.abTestModel || "—"}</td>
                        <td className="px-4 py-2 text-gray-700">{vote.comparable ? "Yes" : "No"}</td>
                        <td className="max-w-xs truncate px-4 py-2 text-gray-800" title={vote.question}>
                          {vote.question || "—"}
                        </td>
                        <td className="px-4 py-2">
                          <Link
                            href={`/share/${vote.id}`}
                            className="font-mono text-xs text-blue-600 hover:underline"
                            target="_blank"
                          >
                            {vote.id.slice(0, 8)}…
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <h2 className="text-lg font-semibold text-gray-900">Downvote events created in window</h2>
              <p className="mt-1 text-sm text-gray-600">
                Includes downvotes on older answers if the feedback event was created recently.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 font-medium">Reason</th>
                    <th className="px-4 py-2 font-medium">Category</th>
                    <th className="px-4 py-2 font-medium">model</th>
                    <th className="px-4 py-2 font-medium">abTestModel</th>
                    <th className="px-4 py-2 font-medium">Question</th>
                    <th className="px-4 py-2 font-medium">Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentDownvoteEvents.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                        No downvote feedback events created in this window.
                      </td>
                    </tr>
                  ) : (
                    data.recentDownvoteEvents.map((event) => (
                      <tr key={event.id} className="border-t border-gray-100">
                        <td className="whitespace-nowrap px-4 py-2 text-gray-600">{formatWhen(event.createdAt)}</td>
                        <td className="px-4 py-2 text-gray-800">{event.reason || "—"}</td>
                        <td className="px-4 py-2 text-gray-700">{event.triageCategory || "—"}</td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-800">{event.model || "—"}</td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-800">{event.abTestModel || "—"}</td>
                        <td className="max-w-xs truncate px-4 py-2 text-gray-800" title={event.question}>
                          {event.question || "—"}
                        </td>
                        <td className="px-4 py-2">
                          {event.answerDocId ? (
                            <Link
                              href={`/share/${event.answerDocId}`}
                              className="font-mono text-xs text-blue-600 hover:underline"
                              target="_blank"
                            >
                              {event.answerDocId.slice(0, 8)}…
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {isLoading && <div className="text-xs text-gray-400">Refreshing…</div>}
        </div>
      )}
    </>
  );

  return (
    <AdminLayout siteConfig={siteConfig} pageTitle="Vote & A/B Stats" superuserOnly>
      {mainContent}
    </AdminLayout>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "green" | "red";
}) {
  const valueClass =
    accent === "green" ? "text-green-700" : accent === "red" ? "text-red-700" : "text-gray-900";
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

function ArmRow({ arm }: { arm: VoteStatsArmSummary }) {
  return (
    <tr className="border-t border-gray-100">
      <td className="px-4 py-2 font-medium text-gray-900">{armLabel(arm.arm)}</td>
      <td className="px-4 py-2 text-gray-700">{arm.answers}</td>
      <td className="px-4 py-2 text-gray-700">{arm.comparableAnswers}</td>
      <td className="px-4 py-2 text-gray-700">{arm.upvotes}</td>
      <td className="px-4 py-2 text-gray-700">{arm.downvotes}</td>
      <td className="px-4 py-2 text-gray-700">{rateLabel(arm.comparableUpvotes, arm.comparableAnswers)}</td>
      <td className="px-4 py-2 text-gray-700">{rateLabel(arm.comparableDownvotes, arm.comparableAnswers)}</td>
      <td className="px-4 py-2 text-gray-700">{arm.geoOrOverrideVotes}</td>
    </tr>
  );
}
