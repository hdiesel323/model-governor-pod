/**
 * ============================================================================
 * MODEL GOVERNOR & TOKENMAXXING ENGINE
 * ============================================================================
 * Manages model routing, cost tracking, token telemetry, and proactive
 * benchmarking of free/OAuth tiers across providers.
 */

export interface ModelEntry {
  id: string;
  provider: string;
  modelName: string;
  family: string | null;
  category: "fast_classification" | "general_reasoning" | "deep_audit" | "coding";
  tier: "FREE_TIER" | "OAUTH" | "PAID";
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  contextWindow: number | null;
  /** Measured by probes; null = unmeasured. Never hand-typed (factory-hub#78). */
  avgLatencyMs: number | null;
  tokensPerSec: number | null;
  /** Probe pass rate in percent over the fixed smoke suite; null = unmeasured. Not a general quality claim. */
  qualityScore: number | null;
  status: "active" | "degraded" | "rate_limited";
  lastBenchmarkedAt: number | null;
  lifecycle: "candidate" | "qualified" | "retired";
  source: string;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  probeRuns: number;
  approvedBy: string | null;
}

export interface LlmUsageEvent {
  id: string;
  podId: string;
  taskId?: string;
  provider: string;
  modelId: string;
  tier: "FREE_TIER" | "OAUTH" | "PAID";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  savedUsd: number;
  latencyMs: number;
  status: string;
  createdAt: number;
}


export function mapModel(r: any): ModelEntry {
  return {
    id: r.id,
    provider: r.provider,
    modelName: r.model_name,
    family: r.family ?? null,
    category: r.category,
    tier: r.tier,
    inputCostPer1M: r.input_cost_per_1m ?? null,
    outputCostPer1M: r.output_cost_per_1m ?? null,
    contextWindow: r.context_window ?? null,
    avgLatencyMs: r.avg_latency_ms ?? null,
    tokensPerSec: r.tokens_per_sec ?? null,
    qualityScore: r.quality_score ?? null,
    status: r.status,
    lastBenchmarkedAt: r.last_benchmarked_at ?? null,
    lifecycle: r.lifecycle ?? "candidate",
    source: r.source ?? "unknown",
    firstSeenAt: r.first_seen_at ?? null,
    lastSeenAt: r.last_seen_at ?? null,
    probeRuns: r.probe_runs ?? 0,
    approvedBy: r.approved_by ?? null,
  };
}

/** Qualified first, then measured candidates, newest discoveries first. Retired models are excluded unless asked. */
export async function getModelCatalog(db: D1Database, opts: { includeRetired?: boolean; limit?: number } = {}): Promise<ModelEntry[]> {
  const { results } = await db
    .prepare(`SELECT * FROM model_catalog ${opts.includeRetired ? "" : "WHERE lifecycle != 'retired'"}
      ORDER BY CASE lifecycle WHEN 'qualified' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
        quality_score IS NULL, quality_score DESC, first_seen_at DESC LIMIT ?`)
    .bind(opts.limit ?? 500)
    .all<any>();
  return (results || []).map(mapModel);
}

export interface RouteOptions {
  /** Never return this family (e.g. the auditor's), so review stays cross-family. Comma-separated allowed. */
  excludeFamily?: string;
  /** Upper bound on output price per 1M tokens; unknown prices never pass a bound. */
  maxOutputCostPer1M?: number;
}

/**
 * Only QUALIFIED models are routable (measured by probes; paid ones also approved by HD).
 * fast_classification: fastest measured. Everything else, including coding: highest probe pass rate,
 * then cheapest, then fastest. Returns null when nothing qualifies: callers must handle that explicitly.
 */
export async function resolveOptimalModel(
  db: D1Database,
  category: string = "general_reasoning",
  opts: RouteOptions = {}
): Promise<ModelEntry | null> {
  const where = ["lifecycle = 'qualified'", "status = 'active'"];
  const params: any[] = [];
  const excluded = (opts.excludeFamily || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (excluded.length) {
    where.push(`(family IS NULL OR family NOT IN (${excluded.map(() => "?").join(",")}))`);
    params.push(...excluded);
  }
  if (opts.maxOutputCostPer1M !== undefined) {
    where.push("output_cost_per_1m IS NOT NULL AND output_cost_per_1m <= ?");
    params.push(opts.maxOutputCostPer1M);
  }
  const order = category === "fast_classification"
    ? "tokens_per_sec DESC, quality_score DESC"
    : "quality_score DESC, COALESCE(output_cost_per_1m, 1e9) ASC, tokens_per_sec DESC";
  const row = await db
    .prepare(`SELECT * FROM model_catalog WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 1`)
    .bind(...params)
    .first<any>();
  return row ? mapModel(row) : null;
}

export async function recordUsage(
  db: D1Database,
  usage: {
    podId: string;
    taskId?: string;
    provider: string;
    modelId: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    tier?: "FREE_TIER" | "OAUTH" | "PAID";
    actualCost?: number;
  }
): Promise<LlmUsageEvent> {
  const now = Date.now();
  const id = `use_${now}_${Math.random().toString(36).slice(2, 7)}`;
  const totalTokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);

  // Look up model pricing
  const modelRow = await db
    .prepare("SELECT tier, input_cost_per_1m, output_cost_per_1m FROM model_catalog WHERE id = ? OR model_name = ?")
    .bind(usage.modelId, usage.modelId)
    .first<any>();

  const tier = usage.tier || (modelRow ? modelRow.tier : "PAID");
  let costUsd = usage.actualCost ?? 0.0;

  if (usage.actualCost === undefined && modelRow) {
    const inputCost = (usage.promptTokens / 1_000_000) * modelRow.input_cost_per_1m;
    const outputCost = (usage.completionTokens / 1_000_000) * modelRow.output_cost_per_1m;
    costUsd = inputCost + outputCost;
  }

  // No counterfactual "savings": the old GPT-4o-2024 baseline was an invented comparison (factory-hub#78).
  const savedUsd = 0;

  const event: LlmUsageEvent = {
    id,
    podId: usage.podId,
    taskId: usage.taskId,
    provider: usage.provider,
    modelId: usage.modelId,
    tier,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens,
    costUsd: parseFloat(costUsd.toFixed(6)),
    savedUsd: parseFloat(savedUsd.toFixed(6)),
    latencyMs: usage.latencyMs,
    status: "success",
    createdAt: now,
  };

  await db
    .prepare(
      `INSERT INTO llm_usage_events (
        id, pod_id, task_id, provider, model_id, tier, prompt_tokens, completion_tokens, total_tokens, cost_usd, saved_usd, latency_ms, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)`
    )
    .bind(
      event.id,
      event.podId,
      event.taskId || null,
      event.provider,
      event.modelId,
      event.tier,
      event.promptTokens,
      event.completionTokens,
      event.totalTokens,
      event.costUsd,
      event.savedUsd,
      event.latencyMs,
      event.createdAt
    )
    .run();

  return event;
}

export async function getTelemetryStats(db: D1Database): Promise<{
  totalTokens: number;
  totalCostUsd: number;
  totalSavedUsd: number;
  freeTierPercentage: number;
  eventsCount: number;
  topProviders: { provider: string; tokens: number; cost: number }[];
  recentEvents: LlmUsageEvent[];
}> {
  const totals = await db
    .prepare(`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(saved_usd), 0) as total_saved,
        COALESCE(SUM(CASE WHEN tier IN ('FREE_TIER', 'OAUTH') THEN total_tokens ELSE 0 END), 0) as free_tokens
      FROM llm_usage_events
    `)
    .first<any>();

  const totalTokens = totals?.total_tokens || 0;
  const freeTokens = totals?.free_tokens || 0;
  const freeTierPercentage = totalTokens > 0 ? (freeTokens / totalTokens) * 100 : 100;

  const { results: providerRows } = await db
    .prepare(`
      SELECT provider, SUM(total_tokens) as tokens, SUM(cost_usd) as cost
      FROM llm_usage_events
      GROUP BY provider
      ORDER BY tokens DESC
    `)
    .all<any>();

  const { results: recentRows } = await db
    .prepare("SELECT * FROM llm_usage_events ORDER BY created_at DESC LIMIT 20")
    .all<any>();

  const recentEvents: LlmUsageEvent[] = (recentRows || []).map((r) => ({
    id: r.id,
    podId: r.pod_id,
    taskId: r.task_id,
    provider: r.provider,
    modelId: r.model_id,
    tier: r.tier,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    costUsd: r.cost_usd,
    savedUsd: r.saved_usd,
    latencyMs: r.latency_ms,
    status: r.status,
    createdAt: r.created_at,
  }));

  return {
    totalTokens,
    totalCostUsd: parseFloat((totals?.total_cost || 0).toFixed(4)),
    totalSavedUsd: parseFloat((totals?.total_saved || 0).toFixed(4)),
    freeTierPercentage: parseFloat(freeTierPercentage.toFixed(1)),
    eventsCount: totals?.count || 0,
    topProviders: (providerRows || []).map((p) => ({
      provider: p.provider,
      tokens: p.tokens,
      cost: parseFloat((p.cost || 0).toFixed(4)),
    })),
    recentEvents,
  };
}
