// OpenAI-compatible inference through the governor: clients (OpenBot, OMP, Hermes) point at one URL and
// one token, ask for `auto`, and the governor picks the best QUALIFIED model it can reach.
//
// The Worker can only call providers it holds API keys for (OpenRouter, OrcaRouter). Subscription models
// (Codex, Antigravity, Claude OAuth) live in logins on the operator's machines and are never routed here.
// Paid models still need HD approval to qualify (ruling #1): this route only spends on what routing allows.
import { mapModel, rankQualifiedModels, recordUsage, type ModelEntry } from "./governor.js";

export interface ProxyEnv {
  DB: D1Database;
  OPENROUTER_API_KEY?: string;
  ORCAROUTER_API_KEY?: string;
  ORCAROUTER_BASE_URL?: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Model ids a client can ask for, and the routing category each one means. */
export const AUTO_MODELS: Record<string, { category: string; name: string }> = {
  auto: { category: "general_reasoning", name: "Model Governor · Auto" },
  "auto-coding": { category: "coding", name: "Model Governor · Auto (coding)" },
  "auto-fast": { category: "fast_classification", name: "Model Governor · Auto (fast)" },
};

/** Upstream attempts before giving up: the best qualified model, then the next ones. */
const MAX_ATTEMPTS = 3;

/** Statuses that mean "this model or provider, not the request": try the next candidate. */
const RETRYABLE = new Set([402, 404, 408, 409, 429, 500, 502, 503, 504]);

function upstream(provider: string, env: ProxyEnv): { url: string; key: string } | null {
  if (provider === "openrouter" && env.OPENROUTER_API_KEY) {
    return { url: "https://openrouter.ai/api/v1/chat/completions", key: env.OPENROUTER_API_KEY };
  }
  if (provider === "orcarouter" && env.ORCAROUTER_API_KEY) {
    return { url: `${env.ORCAROUTER_BASE_URL || "https://api.orcarouter.ai/v1"}/chat/completions`, key: env.ORCAROUTER_API_KEY };
  }
  return null;
}

/** Providers this Worker can actually call, given the secrets it has. */
export function reachableProviders(env: ProxyEnv): string[] {
  return ["openrouter", "orcarouter"].filter((p) => upstream(p, env) !== null);
}

/** Every path a client may use: `/v1/...`, or under the `/api/inference` base OpenBot was configured with. */
export function proxyRoute(pathname: string): "models" | "chat" | null {
  const rest = pathname.replace(/^\/api\/inference/, "").replace(/^\/v1/, "");
  if (rest === "/models") return "models";
  if (rest === "/chat/completions") return "chat";
  return null;
}

async function candidates(model: string, env: ProxyEnv): Promise<ModelEntry[]> {
  const providers = reachableProviders(env);
  if (!providers.length) return [];
  const auto = AUTO_MODELS[model];
  if (auto) return rankQualifiedModels(env.DB, auto.category, { providers }, MAX_ATTEMPTS);
  const row = await env.DB
    .prepare("SELECT * FROM model_catalog WHERE id = ? AND lifecycle = 'qualified' AND status = 'active'")
    .bind(model)
    .first<any>();
  const entry = row ? mapModel(row) : null;
  return entry && providers.includes(entry.provider) ? [entry] : [];
}

const err = (status: number, message: string, headers: Record<string, string>) =>
  new Response(JSON.stringify({ error: { message, type: "governor_error" } }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });

export async function listModels(env: ProxyEnv, headers: Record<string, string>): Promise<Response> {
  const providers = reachableProviders(env);
  const qualified = providers.length
    ? await env.DB
        .prepare(`SELECT * FROM model_catalog WHERE lifecycle = 'qualified' AND status = 'active'
          AND provider IN (${providers.map(() => "?").join(",")}) ORDER BY quality_score DESC LIMIT 100`)
        .bind(...providers)
        .all<any>()
    : { results: [] };
  const created = Math.floor(Date.now() / 1000);
  const data = [
    ...Object.entries(AUTO_MODELS).map(([id, m]) => ({ id, object: "model", created, owned_by: "model-governor", name: m.name })),
    ...(qualified.results || []).map((r: any) => ({ id: r.id, object: "model", created, owned_by: r.provider, name: r.model_name })),
  ];
  return new Response(JSON.stringify({ object: "list", data }), {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export async function chatCompletions(
  request: Request,
  env: ProxyEnv,
  headers: Record<string, string>,
  podId: string,
  fetcher: Fetcher = (i, init) => fetch(i, init)
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return err(400, "request body must be JSON", headers);
  }
  const requested = typeof body?.model === "string" && body.model ? body.model : "auto";
  const list = await candidates(requested, env);
  if (!list.length) {
    return err(503, `no qualified model the governor can reach for "${requested}"`, headers);
  }

  const failures: string[] = [];
  for (const model of list) {
    const target = upstream(model.provider, env)!;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetcher(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.key}`, "User-Agent": "model-governor-pod" },
        body: JSON.stringify({ ...body, model: model.modelName }),
      });
    } catch (e) {
      failures.push(`${model.id}: ${String(e).slice(0, 120)}`);
      continue;
    }
    if (!res.ok && RETRYABLE.has(res.status)) {
      failures.push(`${model.id}: HTTP ${res.status}`);
      continue;
    }

    const out = new Headers(headers);
    out.set("Content-Type", res.headers.get("Content-Type") || "application/json");
    out.set("X-Governor-Model", model.id);
    out.set("X-Governor-Provider", model.provider);
    if (failures.length) out.set("X-Governor-Fallbacks", String(failures.length));

    if (body.stream || !res.ok) return new Response(res.body, { status: res.status, headers: out });

    const text = await res.text();
    try {
      const usage = JSON.parse(text)?.usage;
      if (usage) {
        await recordUsage(env.DB, {
          podId,
          provider: model.provider,
          modelId: model.id,
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          latencyMs: Date.now() - started,
          tier: model.tier as any,
        });
      }
    } catch {
      // Usage telemetry is best-effort; the answer still goes back.
    }
    return new Response(text, { status: res.status, headers: out });
  }
  return err(502, `every candidate failed: ${failures.join("; ")}`, headers);
}
