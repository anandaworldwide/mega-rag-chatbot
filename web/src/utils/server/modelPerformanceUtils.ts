import * as fbadmin from "firebase-admin"
import { db } from "@/services/firebase"
import { firestoreAdd } from "@/utils/server/firestoreRetryUtils"
import { getModelPerformanceCollectionName } from "@/utils/server/firestoreUtils"

export interface TimingMetricsInput {
  startTime: number
  pineconeSetupComplete?: number
  vectorStoreSetupComplete?: number
  chainExecutionStart?: number
  firstTokenGenerated?: number
  firstByteTime?: number
  answerStreamingComplete?: number
  suggestionsGenerationStart?: number
  suggestionsGenerationComplete?: number
  documentSaveStart?: number
  documentSaveComplete?: number
  totalTokens?: number
  tokensPerSecond?: number
  totalTime?: number
}

export interface ModelPerformanceTimingBreakdown {
  pineconeSetup: number
  vectorStoreSetup: number
  chainExecution: number
  llmThinkTime: number
  tokenDelivery: number
  ttfb: number
  answerStreaming: number
  suggestionsGeneration: number
  documentSave: number
  totalSessionTime: number
}

export interface ModelPerformanceRecordContext {
  modelName: string
  siteId: string
  collection: string
  sourceCount: number
  requestType: "chat" | "comparison"
  status: "success" | "error"
  totalTokens: number
  tokensPerSecond: number
}

export interface ModelPerformanceRecord {
  model: string
  siteId: string
  collection: string
  sourceCount: number
  requestType: "chat" | "comparison"
  status: "success" | "error"
  totalTokens: number
  tokensPerSecond: number
  timings: ModelPerformanceTimingBreakdown
  createdAt: fbadmin.firestore.FieldValue
}

export interface FirestoreTimestampLike {
  toDate: () => Date
}

export interface ModelPerformanceRecordData {
  model?: string
  siteId?: string
  collection?: string
  sourceCount?: number
  requestType?: "chat" | "comparison"
  status?: "success" | "error"
  totalTokens?: number
  tokensPerSecond?: number
  timings?: Partial<ModelPerformanceTimingBreakdown>
  createdAt?: FirestoreTimestampLike
}

export interface ModelPerformanceMetricSummary {
  mean: number
  stdDev: number
  count: number
}

export interface ModelPerformanceSummary {
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

class RunningStats {
  private count = 0
  private mean = 0
  private m2 = 0

  public add(value?: number) {
    if (value === undefined || !Number.isFinite(value)) return
    this.count += 1
    const delta = value - this.mean
    this.mean += delta / this.count
    const delta2 = value - this.mean
    this.m2 += delta * delta2
  }

  public snapshot(): ModelPerformanceMetricSummary {
    if (this.count === 0) {
      return { mean: 0, stdDev: 0, count: 0 }
    }

    const variance = this.m2 / this.count
    return {
      mean: this.mean,
      stdDev: Math.sqrt(Math.max(variance, 0)),
      count: this.count,
    }
  }
}

class ModelStatsAccumulator {
  private count = 0
  private readonly ttfb = new RunningStats()
  private readonly answerStreaming = new RunningStats()
  private readonly totalSession = new RunningStats()
  private readonly tokensPerSecond = new RunningStats()
  private readonly totalTokens = new RunningStats()

  public addRecord(record: ModelPerformanceRecordData) {
    this.count += 1
    this.ttfb.add(record.timings?.ttfb)
    this.answerStreaming.add(record.timings?.answerStreaming)
    this.totalSession.add(record.timings?.totalSessionTime)
    this.tokensPerSecond.add(record.tokensPerSecond)
    this.totalTokens.add(record.totalTokens)
  }

  public toSummary(model: string): ModelPerformanceSummary {
    return {
      model,
      count: this.count,
      metrics: {
        ttfbMs: this.ttfb.snapshot(),
        answerStreamingMs: this.answerStreaming.snapshot(),
        totalSessionMs: this.totalSession.snapshot(),
        tokensPerSecond: this.tokensPerSecond.snapshot(),
        totalTokens: this.totalTokens.snapshot(),
      },
    }
  }
}

export class ModelPerformanceAggregator {
  private readonly includeErrors: boolean
  private readonly modelStats = new Map<string, ModelStatsAccumulator>()
  private totalRecords = 0
  private errorRecords = 0

  constructor({ includeErrors = false }: { includeErrors?: boolean } = {}) {
    this.includeErrors = includeErrors
  }

  public addRecord(record: ModelPerformanceRecordData) {
    this.totalRecords += 1
    if (record.status === "error") {
      this.errorRecords += 1
      if (!this.includeErrors) return
    }

    const model = record.model || "unknown"
    const accumulator = this.modelStats.get(model) || new ModelStatsAccumulator()
    accumulator.addRecord(record)
    this.modelStats.set(model, accumulator)
  }

  public buildSummary(): ModelPerformanceSummary[] {
    return Array.from(this.modelStats.entries())
      .map(([model, accumulator]) => accumulator.toSummary(model))
      .sort((a, b) => a.model.localeCompare(b.model))
  }

  public getTotals() {
    return {
      totalRecords: this.totalRecords,
      errorRecords: this.errorRecords,
    }
  }
}

export class ModelPerformanceTracker {
  private readonly collectionName = getModelPerformanceCollectionName()
  private readonly firestore = db

  public buildTimingBreakdown(metrics: TimingMetricsInput): ModelPerformanceTimingBreakdown {
    const {
      startTime,
      pineconeSetupComplete,
      vectorStoreSetupComplete,
      chainExecutionStart,
      firstTokenGenerated,
      firstByteTime,
      answerStreamingComplete,
      suggestionsGenerationStart,
      suggestionsGenerationComplete,
      documentSaveStart,
      documentSaveComplete,
      totalTime,
    } = metrics

    return {
      pineconeSetup: pineconeSetupComplete ? pineconeSetupComplete - startTime : 0,
      vectorStoreSetup:
        vectorStoreSetupComplete && pineconeSetupComplete ? vectorStoreSetupComplete - pineconeSetupComplete : 0,
      chainExecution:
        chainExecutionStart && vectorStoreSetupComplete ? chainExecutionStart - vectorStoreSetupComplete : 0,
      llmThinkTime: firstTokenGenerated && chainExecutionStart ? firstTokenGenerated - chainExecutionStart : 0,
      tokenDelivery: firstByteTime && firstTokenGenerated ? firstByteTime - firstTokenGenerated : 0,
      ttfb: firstByteTime ? firstByteTime - startTime : 0,
      answerStreaming: answerStreamingComplete && firstByteTime ? answerStreamingComplete - firstByteTime : 0,
      suggestionsGeneration:
        suggestionsGenerationComplete && suggestionsGenerationStart
          ? suggestionsGenerationComplete - suggestionsGenerationStart
          : 0,
      documentSave: documentSaveComplete && documentSaveStart ? documentSaveComplete - documentSaveStart : 0,
      totalSessionTime: totalTime || 0,
    }
  }

  public buildRecord(
    metrics: TimingMetricsInput,
    context: ModelPerformanceRecordContext
  ): ModelPerformanceRecord {
    const timings = this.buildTimingBreakdown(metrics)

    return {
      model: context.modelName,
      siteId: context.siteId,
      collection: context.collection,
      sourceCount: context.sourceCount,
      requestType: context.requestType,
      status: context.status,
      totalTokens: context.totalTokens,
      tokensPerSecond: context.tokensPerSecond,
      timings,
      createdAt: fbadmin.firestore.FieldValue.serverTimestamp(),
    }
  }

  public async recordChatPerformance(record: ModelPerformanceRecord) {
    if (!this.firestore) return

    await firestoreAdd(
      this.firestore.collection(this.collectionName),
      record,
      "model performance record",
      `model: ${record.model}`
    )
  }
}
