// Live model probing (factory-hub#78). Measures real latency, throughput and a deterministic pass rate.
// Scores are PROBE scores (a fixed smoke suite), not general "quality". Real coding quality comes from pod receipts.
// Spend gate (ruling #1): $0 models are probed automatically; paid models only within PROBE_BUDGET_USD_DAILY
// (set by HD; default 0 = never), and spend is computed from catalog prices and recorded per probe.

import type { Fetcher } from "./discovery.js";

export const SUITE_VERSION = "smoke-2026-11-v1";
const MAX_TOKENS = 2000; // generous: reasoning models must not exhaust the budget before answering (see #76)

export interface ProbeItem { name: string; prompt: string; grade: (answer: string) => boolean }

export function clean(answer: string): string {
  return answer
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function gradeZipRegex(answer: string): boolean {
  const m = clean(answer).match(/^\/(.+)\/([a-z]*)$/s);
  if (!m) return false;
  let re: RegExp;
  try { re = new RegExp(m[1], m[2]); } catch { return false; }
  const yes = ["12345", "90210", "00501"];
  const no = ["1234", "123456", "12a45", "a12345", "12345-6789", ""];
  return yes.every((s) => re.test(s)) && no.every((s) => !re.test(s));
}

export const SUITE: ProbeItem[] = [
  { name: "exact", prompt: "Reply with exactly the word PONG and nothing else.", grade: (a) => clean(a) === "PONG" },
  {
    name: "json",
    prompt: 'Return only a JSON object with keys "a" and "b": a is the integer 17*23, b is the string "x". No prose, no code fences.',
    grade: (a) => { try { const o = JSON.parse(clean(a)); return o.a === 391 && o.b === "x"; } catch { return false; } },
  },
  {
    name: "instruction",
    prompt: "List the first five prime numbers separated by commas, with no spaces and nothing else.",
    grade: (a) => clean(a).replace(/\.$/, "") === "2,3,5,7,11",
  },
  {
    name: "code_read",
    prompt: "What does this JavaScript print? console.log([1,2,3].map(x => x * 2).reduce((a, b) => a + b, 0)) Reply with the number only.",
    grade: (a) => clean(a) === "12",
  },
  {
    name: "code_write",
    prompt: "Write a JavaScript regular expression literal that matches a string consisting of exactly five ASCII digits (a US ZIP code) and nothing else. Reply with only the regex literal, like /.../",
    grade: gradeZipRegex,
  },
];

export interface ProbeTarget {
  id: string; provider: string; modelName: string; tier: string;
  inputCostPer1M: number | null; outputCostPer1M: number | null;
}

export interface ProbeResult {
  modelId: string; passed: number; total: number; latencyMs: number | null; tokensPerSec: number | null;
  promptTokens: number; completionTokens: number; costUsd: number; error?: string; providerError?: boolean;
}

function endpoint(provider: string, env: ProbeEnv): { url: string; key?: string } {
  if (provider === "orcarouter") return { url: `${env.ORCAROUTER_BASE_URL || "https://api.orcarouter.ai/v1"}/chat/completions`, key: env.ORCAROUTER_API_KEY };
  return { url: "https://openrouter.ai/api/v1/chat/completions", key: env.OPENROUTER_API_KEY };
}

export interface ProbeEnv { OPENROUTER_API_KEY?: string; ORCAROUTER_API_KEY?: string; ORCAROUTER_BASE_URL?: string }

export async function probeModel(target: ProbeTarget, env: ProbeEnv, fetcher: Fetcher = (i, init) => fetch(i, init)): Promise<ProbeResult> {
  const { url, key } = endpoint(target.provider, env);
  const result: ProbeResult = { modelId: target.id, passed: 0, total: SUITE.length, latencyMs: null, tokensPerSec: null, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  if (!key) return { ...result, error: `no API key for ${target.provider}`, providerError: true };
  let totalMs = 0;
  for (const item of SUITE) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: target.modelName, messages: [{ role: "user", content: item.prompt }], temperature: 0, max_tokens: MAX_TOKENS }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: any) {
      return { ...result, error: `${item.name}: ${e?.message ?? e}`, providerError: true };
    }
    const ms = Date.now() - started;
    if (!res.ok) {
      // 429/5xx/404 are provider conditions, not model quality: recorded, never counted as a quality run.
      return { ...result, error: `${item.name}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`, providerError: true };
    }
    const data = (await res.json()) as any;
    totalMs += ms;
    result.promptTokens += Number(data?.usage?.prompt_tokens ?? 0);
    result.completionTokens += Number(data?.usage?.completion_tokens ?? 0);
    if (item.grade(String(data?.choices?.[0]?.message?.content ?? ""))) result.passed++;
  }
  result.latencyMs = Math.round(totalMs / SUITE.length);
  result.tokensPerSec = totalMs > 0 ? +(result.completionTokens / (totalMs / 1000)).toFixed(1) : null;
  result.costUsd = +(((result.promptTokens * (target.inputCostPer1M ?? 0)) + (result.completionTokens * (target.outputCostPer1M ?? 0))) / 1e6).toFixed(6);
  return result;
}

/** Estimated suite cost, for the budget gate before spending. Unknown prices are not probed when paid. */
export function estimateSuiteCost(t: ProbeTarget): number | null {
  if (t.tier === "FREE_TIER") return 0;
  if (t.inputCostPer1M === null || t.outputCostPer1M === null) return null;
  return (SUITE.length * (300 * t.inputCostPer1M + MAX_TOKENS * t.outputCostPer1M)) / 1e6; // worst case
}

export async function spentToday(db: D1Database, now: number): Promise<number> {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const r = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM model_probes WHERE created_at >= ?").bind(start.getTime()).first<{ s: number }>();
  return Number(r?.s ?? 0);
}

const PROMOTE_MIN_RUNS = 3;
const PROMOTE_PASS_RATE = 0.8;
const DEMOTE_PASS_RATE = 0.6;

/** Records a probe and re-derives the model's measured fields and lifecycle from stored probes only. */
export async function recordProbe(db: D1Database, target: ProbeTarget, r: ProbeResult, now: number): Promise<string> {
  await db.prepare(`INSERT INTO model_probes (id, model_id, suite_version, passed, total, latency_ms, tokens_per_sec,
      prompt_tokens, completion_tokens, cost_usd, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`prb_${now}_${Math.random().toString(36).slice(2, 7)}`, target.id, SUITE_VERSION, r.passed, r.total, r.latencyMs,
      r.tokensPerSec, r.promptTokens, r.completionTokens, r.costUsd, r.error ?? null, now)
    .run();
  if (r.providerError) {
    if (/HTTP 429/.test(r.error ?? "")) await db.prepare("UPDATE model_catalog SET status = 'rate_limited', last_benchmarked_at = ? WHERE id = ?").bind(now, target.id).run();
    // 401/403/404: this account cannot use the model; park it for a day instead of re-probing every tick.
    else if (/HTTP 40[134]/.test(r.error ?? "")) await db.prepare("UPDATE model_catalog SET status = 'degraded', last_benchmarked_at = ? WHERE id = ?").bind(now, target.id).run();
    return "provider_error";
  }
  const agg = await db.prepare(`SELECT COUNT(*) runs, SUM(passed) passed, SUM(total) total, AVG(latency_ms) lat, AVG(tokens_per_sec) tps
      FROM model_probes WHERE model_id = ? AND error IS NULL AND suite_version = ?`).bind(target.id, SUITE_VERSION).first<any>();
  const recent = await db.prepare(`SELECT SUM(passed) * 1.0 / SUM(total) rate FROM (SELECT passed, total FROM model_probes
      WHERE model_id = ? AND error IS NULL AND suite_version = ? ORDER BY created_at DESC LIMIT 3)`).bind(target.id, SUITE_VERSION).first<any>();
  const rate = agg.total > 0 ? agg.passed / agg.total : 0;
  const row = await db.prepare("SELECT tier, approved_by, lifecycle FROM model_catalog WHERE id = ?").bind(target.id).first<any>();
  let lifecycle = row?.lifecycle ?? "candidate";
  const allowed = row?.tier === "FREE_TIER" || Boolean(row?.approved_by);
  if (lifecycle !== "retired") {
    if (agg.runs >= PROMOTE_MIN_RUNS && rate >= PROMOTE_PASS_RATE && allowed) lifecycle = "qualified";
    else if (lifecycle === "qualified" && Number(recent?.rate ?? 0) < DEMOTE_PASS_RATE) lifecycle = "candidate";
  }
  await db.prepare(`UPDATE model_catalog SET probe_runs = ?, probe_passes = ?, avg_latency_ms = ?, tokens_per_sec = ?,
      quality_score = ?, last_benchmarked_at = ?, lifecycle = ?, status = 'active' WHERE id = ?`)
    .bind(agg.runs, agg.passed, Math.round(agg.lat), Math.round(agg.tps ?? 0), +(rate * 100).toFixed(1), now, lifecycle, target.id)
    .run();
  return lifecycle;
}

export interface ProbeCycleReport { probed: { id: string; passed: number; total: number; costUsd: number; lifecycle: string; error?: string }[]; skippedPaid: string[]; budget: number; spentBefore: number }

/** One cron cycle: a few free candidates (least probed, newest first) plus paid ones only within today's budget. */
export async function runProbeCycle(db: D1Database, env: ProbeEnv & { PROBE_BUDGET_USD_DAILY?: string }, fetcher?: Fetcher, now = Date.now(), maxFree = 3): Promise<ProbeCycleReport> {
  const budget = Math.max(0, Number(env.PROBE_BUDGET_USD_DAILY ?? 0) || 0);
  const spentBefore = await spentToday(db, now);
  const map = (r: any): ProbeTarget => ({ id: r.id, provider: r.provider, modelName: r.model_name, tier: r.tier, inputCostPer1M: r.input_cost_per_1m, outputCostPer1M: r.output_cost_per_1m });
  const free = await db.prepare(`SELECT * FROM model_catalog WHERE lifecycle != 'retired' AND tier = 'FREE_TIER' AND source = 'discovered'
      AND (status = 'active' OR (status = 'rate_limited' AND last_benchmarked_at < ?) OR (status = 'degraded' AND last_benchmarked_at < ?))
      ORDER BY probe_runs ASC, model_created_at DESC LIMIT ?`).bind(now - 3600_000, now - 86_400_000, maxFree).all<any>();
  const targets = (free.results ?? []).map(map);
  const skippedPaid: string[] = [];
  // Paid: newest releases first; never re-spend on a model already measured 3 times unless it is approved.
  const paid = await db.prepare(`SELECT * FROM model_catalog WHERE lifecycle = 'candidate' AND tier = 'PAID' AND source = 'discovered'
      AND status = 'active' AND (probe_runs < 3 OR approved_by IS NOT NULL)
      ORDER BY probe_runs ASC, model_created_at DESC LIMIT 5`).all<any>();
  let remaining = budget - spentBefore;
  for (const t of (paid.results ?? []).map(map)) {
    const est = estimateSuiteCost(t);
    if (budget > 0 && est !== null && est <= remaining) { targets.push(t); remaining -= est; }
    else skippedPaid.push(t.id);
  }
  const probed: ProbeCycleReport["probed"] = [];
  for (const t of targets) {
    const r = await probeModel(t, env, fetcher);
    const lifecycle = await recordProbe(db, t, r, Date.now());
    probed.push({ id: t.id, passed: r.passed, total: r.total, costUsd: r.costUsd, lifecycle, error: r.error });
  }
  return { probed, skippedPaid, budget, spentBefore };
}
