/** @jest-environment node */

import { ModelPerformanceAggregator } from "@/utils/server/modelPerformanceUtils"

describe("ModelPerformanceAggregator", () => {
  it("aggregates model performance stats per model", () => {
    const aggregator = new ModelPerformanceAggregator()

    aggregator.addRecord({
      model: "gpt-4o",
      status: "success",
      tokensPerSecond: 50,
      totalTokens: 200,
      timings: {
        ttfb: 1000,
        answerStreaming: 3000,
        totalSessionTime: 4000,
      },
    })

    aggregator.addRecord({
      model: "gpt-4o",
      status: "success",
      tokensPerSecond: 70,
      totalTokens: 300,
      timings: {
        ttfb: 3000,
        answerStreaming: 5000,
        totalSessionTime: 7000,
      },
    })

    aggregator.addRecord({
      model: "gpt-4.1",
      status: "success",
      tokensPerSecond: 40,
      totalTokens: 100,
      timings: {
        ttfb: 1500,
        answerStreaming: 2500,
        totalSessionTime: 3500,
      },
    })

    const summaries = aggregator.buildSummary()
    const gpt4o = summaries.find((summary) => summary.model === "gpt-4o")
    const totals = aggregator.getTotals()

    expect(gpt4o?.count).toBe(2)
    expect(gpt4o?.metrics.ttfbMs.mean).toBeCloseTo(2000, 5)
    expect(gpt4o?.metrics.ttfbMs.stdDev).toBeCloseTo(1000, 5)
    expect(gpt4o?.metrics.tokensPerSecond.mean).toBeCloseTo(60, 5)
    expect(gpt4o?.metrics.tokensPerSecond.stdDev).toBeCloseTo(10, 5)
    expect(totals.totalRecords).toBe(3)
  })
})
