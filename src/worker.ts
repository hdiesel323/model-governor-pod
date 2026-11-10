import { loadPodConfig } from "./config.js";
import { TincanClient } from "./tincan.js";
import { setHubAuthToken } from "./skill-engine.js";
import { activeHandler } from "./handler.js";
import { renderPodUiHtml } from "./ui.js";
import { TaskRecord } from "./types.js";
import { getModelCatalog, resolveOptimalModel, recordUsage, getTelemetryStats, mapModel, getSubscriptionAdvisor } from "./governor.js";
import { authGate } from "./auth.js";
import { runDiscovery } from "./discovery.js";
import { runProbeCycle, recordProbe } from "./probe.js";
import { proxyRoute, listModels, chatCompletions } from "./proxy.js";

interface Env {
  DB: D1Database;
  FACTORY_HUB?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  POD_ID?: string;
  POD_NAME?: string;
  POD_ROLE?: string;
  POD_LOB?: string;
  FACTORY_HUB_URL?: string;
  FACTORY_HUB_TOKEN?: string;
  GOVERNOR_ADMIN_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  ORCAROUTER_API_KEY?: string;
  ORCAROUTER_BASE_URL?: string;
  /** HD-set daily ceiling for probing PAID models. Default 0: paid models are never probed automatically. */
  PROBE_BUDGET_USD_DAILY?: string;
}

const json = (body: any, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const config = loadPodConfig(env as any);
    setHubAuthToken(config.hubToken);
    const tincan = new TincanClient(config, env.FACTORY_HUB);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Auth gate (factory-hub#78): everything but /health needs a credential; admin routes need the admin token.
    const denied = authGate(request, env);
    if (denied) {
      const h = new Headers(denied.headers);
      for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
      return new Response(denied.body, { status: denied.status, headers: h });
    }

    // Health Check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          podId: config.id,
          name: config.name,
          role: config.role,
          lob: config.lob,
          edge: true,
          timestamp: Date.now(),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cockpit UI
    if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      const tasks = await getTasks(env.DB, 30);
      const messages = await getMessages(env.DB, 20);
      const stats = await getTelemetryStats(env.DB);
      const catalog = await getModelCatalog(env.DB);
      const html = renderPodUiHtml(config, tasks, messages, stats, catalog);

      if (method === "HEAD") {
        return new Response(null, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(html, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
    }

    // OpenAI-compatible inference (/v1/... or /api/inference/...): one URL and token for every client.
    const proxied = proxyRoute(url.pathname);
    if (proxied === "models" && method === "GET") return listModels(env, corsHeaders);
    if (proxied === "chat" && method === "POST") return chatCompletions(request, env, corsHeaders, config.id);

    // API: List Model Catalog with Pricing and Benchmarks
    if (method === "GET" && url.pathname === "/api/models") {
      const catalog = await getModelCatalog(env.DB);
      return new Response(JSON.stringify({ catalog }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // API: Route to the best QUALIFIED model (measured by probes; paid ones approved by HD).
    if (method === "GET" && url.pathname === "/api/models/route") {
      const category = url.searchParams.get("category") || "general_reasoning";
      const maxCost = url.searchParams.get("maxOutputCostPer1M");
      const model = await resolveOptimalModel(env.DB, category, {
        excludeFamily: url.searchParams.get("excludeFamily") || undefined,
        maxOutputCostPer1M: maxCost === null ? undefined : Number(maxCost),
      });
      if (!model) return json({ recommendedModel: null, reason: `no qualified model for category ${category}` }, 404, corsHeaders);
      return json({ recommendedModel: model }, 200, corsHeaders);
    }

    // API: Probe history for one model (read-only).
    if (method === "GET" && url.pathname === "/api/governor/probes") {
      const model = url.searchParams.get("model");
      const rows = await env.DB.prepare(`SELECT * FROM model_probes ${model ? "WHERE model_id = ?" : ""} ORDER BY created_at DESC LIMIT 100`)
        .bind(...(model ? [model] : [])).all<any>();
      return json({ probes: rows.results ?? [] }, 200, corsHeaders);
    }

    // ADMIN: approve / revoke a model for routing. Paid models never qualify without this (ruling #1).
    const adminModel = url.pathname.match(/^\/api\/models\/(.+)\/(approve|revoke)$/);
    if (method === "POST" && adminModel) {
      const id = decodeURIComponent(adminModel[1]);
      const row = await env.DB.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(id).first<any>();
      if (!row) return json({ error: `unknown model ${id}` }, 404, corsHeaders);
      if (adminModel[2] === "approve") {
        const body = (await request.json().catch(() => ({}))) as any;
        await env.DB.prepare("UPDATE model_catalog SET approved_by = ?, approved_at = ? WHERE id = ?")
          .bind(String(body.by || "hd"), Date.now(), id).run();
      } else {
        await env.DB.prepare("UPDATE model_catalog SET approved_by = NULL, approved_at = NULL, lifecycle = CASE WHEN tier = 'PAID' AND lifecycle = 'qualified' THEN 'candidate' ELSE lifecycle END WHERE id = ?")
          .bind(id).run();
      }
      const updated = await env.DB.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(id).first<any>();
      return json({ model: mapModel(updated) }, 200, corsHeaders);
    }

    // ADMIN: run discovery or one probe cycle now.
    if (method === "POST" && url.pathname === "/api/governor/discover") {
      return json({ discovery: await runDiscovery(env.DB, env) }, 200, corsHeaders);
    }
    if (method === "POST" && url.pathname === "/api/governor/probe") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (body.model) {
        const row = await env.DB.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(String(body.model)).first<any>();
        if (!row) return json({ error: "unknown model" }, 404, corsHeaders);
        if (row.tier !== "FREE_TIER" && !row.approved_by) return json({ error: "paid model: approve it first (spend gate)" }, 409, corsHeaders);
        const { probeModel } = await import("./probe.js");
        const target = { id: row.id, provider: row.provider, modelName: row.model_name, tier: row.tier, inputCostPer1M: row.input_cost_per_1m, outputCostPer1M: row.output_cost_per_1m };
        const r = await probeModel(target, env);
        return json({ probe: r, lifecycle: await recordProbe(env.DB, target, r, Date.now()) }, 200, corsHeaders);
      }
      return json({ cycle: await runProbeCycle(env.DB, env) }, 200, corsHeaders);
    }

    // ADMIN: record probe results from local devices (Mac, HEL1) for OAuth subscription models (factory-hub#80)
    if (method === "POST" && url.pathname === "/api/governor/probe-result") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (!body.modelId || !body.provider || body.passed === undefined || !body.total || !body.device) {
        return json({ error: "Missing required fields (modelId, provider, passed, total, device)" }, 400, corsHeaders);
      }
      const now = Date.now();
      let row = await env.DB.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(String(body.modelId)).first<any>();
      if (!row) {
        const modelName = String(body.modelName || body.modelId);
        const family = String(body.family || body.provider);
        const category = String(body.category || "coding");
        await env.DB.prepare(`
          INSERT INTO model_catalog (
            id, provider, model_name, family, category, tier,
            input_cost_per_1m, output_cost_per_1m, source, first_seen_at, last_seen_at, lifecycle, status
          ) VALUES (?, ?, ?, ?, ?, 'OAUTH', 0, 0, 'oauth_device', ?, ?, 'candidate', 'active')
        `).bind(body.modelId, body.provider, modelName, family, category, now, now).run();
        row = await env.DB.prepare("SELECT * FROM model_catalog WHERE id = ?").bind(String(body.modelId)).first<any>();
      }
      const target = {
        id: row.id,
        provider: row.provider,
        modelName: row.model_name,
        tier: row.tier,
        inputCostPer1M: row.input_cost_per_1m,
        outputCostPer1M: row.output_cost_per_1m,
      };
      const probeRes = {
        modelId: target.id,
        passed: Number(body.passed),
        total: Number(body.total),
        latencyMs: body.latencyMs !== undefined ? Number(body.latencyMs) : null,
        tokensPerSec: body.tokensPerSec !== undefined ? Number(body.tokensPerSec) : null,
        promptTokens: Number(body.promptTokens || 0),
        completionTokens: Number(body.completionTokens || 0),
        costUsd: 0,
        device: String(body.device),
        error: body.error ? String(body.error) : undefined,
        providerError: Boolean(body.providerError || body.error),
      };
      const lifecycle = await recordProbe(env.DB, target, probeRes, now);
      return json({ status: "recorded", modelId: target.id, lifecycle, device: probeRes.device, probe: probeRes }, 200, corsHeaders);
    }

    // API: Subscription Advisor (factory-hub#80)
    if (method === "GET" && url.pathname === "/api/governor/subscription-advisor") {
      const days = Number(url.searchParams.get("days") || 30);
      const minDays = url.searchParams.has("minDays") ? Number(url.searchParams.get("minDays")) : undefined;
      const minEvents = url.searchParams.has("minEvents") ? Number(url.searchParams.get("minEvents")) : undefined;
      const report = await getSubscriptionAdvisor(env.DB, { days, minDays, minEvents });
      return json(report, 200, corsHeaders);
    }

    // Quotas: record or inspect rate limits / exhausted OAuth providers (factory-hub#80)
    if (method === "GET" && url.pathname === "/api/governor/quotas") {
      const rows = await env.DB.prepare("SELECT * FROM provider_quotas ORDER BY updated_at DESC").all<any>();
      return json({ quotas: rows.results ?? [] }, 200, corsHeaders);
    }
    if (method === "POST" && url.pathname === "/api/governor/quotas") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (!body.provider || !body.status) {
        return json({ error: "Missing required fields (provider, status)" }, 400, corsHeaders);
      }
      const now = Date.now();
      await env.DB.prepare(`
        INSERT INTO provider_quotas (provider, status, error, exhausted_at, resets_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          status = excluded.status,
          error = excluded.error,
          exhausted_at = excluded.exhausted_at,
          resets_at = excluded.resets_at,
          updated_at = excluded.updated_at
      `).bind(
        body.provider,
        body.status,
        body.error ?? null,
        body.status !== "active" ? now : null,
        body.resetsAt ?? null,
        now
      ).run();
      return json({ status: "recorded", provider: body.provider, quotaStatus: body.status }, 200, corsHeaders);
    }

    // API: Record LLM Usage Telemetry
    if (method === "POST" && url.pathname === "/api/telemetry/log") {
      try {
        const body = (await request.json()) as any;
        if (!body.podId || !body.modelId) {
          return new Response(JSON.stringify({ error: "Missing required fields (podId, modelId)" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const event = await recordUsage(env.DB, {
          podId: body.podId,
          taskId: body.taskId,
          provider: body.provider || "unknown",
          modelId: body.modelId,
          promptTokens: parseInt(body.promptTokens || "0", 10),
          completionTokens: parseInt(body.completionTokens || "0", 10),
          latencyMs: parseInt(body.latencyMs || "0", 10),
          tier: body.tier,
          actualCost: body.actualCost,
        });
        return new Response(JSON.stringify({ status: "recorded", event }), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // API: Get Telemetry & TokenMaxxing Analytics
    if (method === "GET" && url.pathname === "/api/telemetry/stats") {
      const stats = await getTelemetryStats(env.DB);
      return new Response(JSON.stringify({ stats }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // API: Ingest & Execute Task
    if (method === "POST" && url.pathname === "/api/task") {
      try {
        const body = (await request.json()) as any;
        const taskId = body.taskId || `task_${Date.now()}`;
        const topic = body.topic || "generic.task";
        const source = body.source || "api";
        const spec = body.spec || {};
        const now = Date.now();

        // Save task as running in D1
        const insertRes = await env.DB.prepare(`
          INSERT INTO tasks (task_id, topic, source, spec_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'running', ?, ?)
        `)
          .bind(taskId, topic, source, JSON.stringify(spec), now, now)
          .run();

        const id = insertRes.meta.last_row_id;
        const taskRecord: TaskRecord = {
          id,
          taskId,
          topic,
          source,
          spec,
          status: "running",
          createdAt: now,
          updatedAt: now,
        };

        // Execute pluggable business handler
        try {
          const result = await activeHandler.handle(taskRecord, {
            podConfig: config,
            now,
            db: env.DB,
            env: env as any,
            publishEvent: async (evTopic, toPod, payload) => {
              await tincan.publish(evTopic, toPod, payload);
              await logMessage(env.DB, "outbound", evTopic, config.id, toPod, payload);
            },
          });

          // Mark completed
          await env.DB.prepare(`
            UPDATE tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE task_id = ?
          `)
            .bind(JSON.stringify(result), Date.now(), taskId)
            .run();

          return new Response(JSON.stringify({ success: true, taskId, status: "completed", result }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (execErr: any) {
          // Mark failed
          await env.DB.prepare(`
            UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE task_id = ?
          `)
            .bind(execErr?.message || String(execErr), Date.now(), taskId)
            .run();

          return new Response(JSON.stringify({ error: execErr?.message || "Task execution failed", taskId }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err?.message || "Invalid payload" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // API: List Tasks
    if (method === "GET" && url.pathname === "/api/tasks") {
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const tasks = await getTasks(env.DB, limit);
      return new Response(JSON.stringify({ tasks }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // API: Send Heartbeat to Factory Hub
    if (method === "POST" && url.pathname === "/api/heartbeat") {
      const ok = await tincan.sendHeartbeat();
      return new Response(JSON.stringify({ success: ok, hubUrl: config.hubUrl }), {
        status: ok ? 200 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },

  // Scheduled cron worker: runs periodic heartbeats & polls Factory Hub for tasks
  async scheduled(event: any, env: Env): Promise<void> {
    const config = loadPodConfig(env as any);
    setHubAuthToken(config.hubToken);
    const tincan = new TincanClient(config, env.FACTORY_HUB);

    // 1. Send heartbeat
    await tincan.sendHeartbeat();

    // 1b. Model radar (factory-hub#78): discovery hourly (or when nothing is discovered yet), probes every tick.
    try {
      const discovered = await env.DB.prepare("SELECT COUNT(*) n FROM model_catalog WHERE source = 'discovered'").first<{ n: number }>();
      if (new Date().getUTCMinutes() < 5 || !discovered?.n) {
        const reports = await runDiscovery(env.DB, env);
        const newIds = reports.flatMap((r) => r.newIds);
        if (newIds.length) await tincan.publish("model.discovered", "pod:pm", { count: newIds.length, ids: newIds.slice(0, 50), reports: reports.map((r) => ({ ...r, newIds: undefined })) });
      }
      const cycle = await runProbeCycle(env.DB, env);
      console.log(`[governor] probe cycle: ${cycle.probed.length} probed, ${cycle.skippedPaid.length} paid skipped (budget $${cycle.budget})`);
    } catch (err: any) {
      console.error("[governor] radar error:", err?.message || err);
    }

    // 2. Poll for pending tasks assigned to this pod
    const messages = await tincan.pollInbox(5);
    for (const msg of messages) {
      if (msg.topic === "task.assigned" && msg.payload) {
        const payload = msg.payload;
        const taskId = payload.taskId || msg.id;
        const now = Date.now();

        await env.DB.prepare(`
          INSERT INTO tasks (task_id, topic, source, spec_json, status, created_at, updated_at)
          VALUES (?, ?, 'factory-hub-mesh', ?, 'running', ?, ?)
          ON CONFLICT(task_id) DO NOTHING
        `)
          .bind(taskId, msg.topic, JSON.stringify(payload.spec || payload), now, now)
          .run();

        const taskRecord: TaskRecord = {
          id: 0,
          taskId,
          topic: msg.topic,
          source: "factory-hub-mesh",
          spec: payload.spec || payload,
          status: "running",
          createdAt: now,
          updatedAt: now,
        };

        try {
          const result = await activeHandler.handle(taskRecord, {
            podConfig: config,
            now,
            db: env.DB,
            env: env as any,
            publishEvent: async (evTopic, toPod, pl) => {
              await tincan.publish(evTopic, toPod, pl);
            },
          });

          await env.DB.prepare("UPDATE tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE task_id = ?")
            .bind(JSON.stringify(result), Date.now(), taskId)
            .run();
        } catch (err: any) {
          await env.DB.prepare("UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE task_id = ?")
            .bind(err?.message || "Execution error", Date.now(), taskId)
            .run();
        }

        // Acknowledge envelope on Factory Hub
        await tincan.acknowledge(msg.id);
      }
    }
  },
};

async function getTasks(db: D1Database, limit = 50): Promise<TaskRecord[]> {
  try {
    const res = await db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").bind(limit).all<any>();
    return res.results.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      topic: r.topic,
      source: r.source,
      spec: JSON.parse(r.spec_json),
      status: r.status,
      result: r.result_json ? JSON.parse(r.result_json) : undefined,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

async function getMessages(db: D1Database, limit = 30): Promise<any[]> {
  try {
    const res = await db.prepare("SELECT * FROM tincan_messages ORDER BY created_at DESC LIMIT ?").bind(limit).all<any>();
    return res.results;
  } catch {
    return [];
  }
}

async function logMessage(db: D1Database, direction: string, topic: string, fromPod: string, toPod: string, payload: any) {
  try {
    const msgId = `tc_pod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await db.prepare(`
      INSERT INTO tincan_messages (id, direction, topic, from_pod, to_pod, payload_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?)
    `)
      .bind(msgId, direction, topic, fromPod, toPod, JSON.stringify(payload), Date.now())
      .run();
  } catch {}
}
