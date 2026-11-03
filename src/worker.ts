import { loadPodConfig } from "./config.js";
import { TincanClient } from "./tincan.js";
import { setHubAuthToken } from "./skill-engine.js";
import { activeHandler } from "./handler.js";
import { renderPodUiHtml } from "./ui.js";
import { TaskRecord } from "./types.js";
import { getModelCatalog, resolveOptimalModel, recordUsage, getTelemetryStats } from "./governor.js";

interface Env {
  DB: D1Database;
  FACTORY_HUB?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  POD_ID?: string;
  POD_NAME?: string;
  POD_ROLE?: string;
  POD_LOB?: string;
  FACTORY_HUB_URL?: string;
  FACTORY_HUB_TOKEN?: string;
}

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

    // API: List Model Catalog with Pricing and Benchmarks
    if (method === "GET" && url.pathname === "/api/models") {
      const catalog = await getModelCatalog(env.DB);
      return new Response(JSON.stringify({ catalog }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // API: Resolve Optimal Model for Task (TokenMaxxing Route)
    if (method === "GET" && url.pathname === "/api/models/route") {
      const category = url.searchParams.get("category") || "general_reasoning";
      const preferFree = url.searchParams.get("prefer_free") !== "false";
      const model = await resolveOptimalModel(env.DB, category, preferFree);

      if (!model) {
        return new Response(JSON.stringify({ error: "No active model found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ recommendedModel: model }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
