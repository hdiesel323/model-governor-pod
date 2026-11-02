import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPodConfig } from "./config.js";
import { TincanClient } from "./tincan.js";
import { activeHandler } from "./handler.js";
import { renderPodUiHtml } from "./ui.js";
import { TaskRecord } from "./types.js";

async function main() {
  const config = loadPodConfig();
  const tincan = new TincanClient(config);

  const dataDir = join(tmpdir(), `pod_${config.id}`);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "pod.sqlite");

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  const schemaPath = join(import.meta.dirname, "..", "schema.sql");
  if (existsSync(schemaPath)) {
    db.exec(readFileSync(schemaPath, "utf8"));
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", podId: config.id, role: config.role, lob: config.lob }));
      return;
    }

    if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      const tasks = getLocalTasks(db);
      const messages = getLocalMessages(db);
      const html = renderPodUiHtml(config, tasks, messages);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(method === "HEAD" ? "" : html);
      return;
    }

    if (method === "POST" && url.pathname === "/api/task") {
      try {
        const body = await parseJson(req);
        const taskId = body.taskId || `task_${Date.now()}`;
        const topic = body.topic || "generic.task";
        const source = body.source || "api";
        const spec = body.spec || {};
        const now = Date.now();

        const insert = db.prepare(`
          INSERT INTO tasks (task_id, topic, source, spec_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'running', ?, ?)
        `);
        const row = insert.run(taskId, topic, source, JSON.stringify(spec), now, now);

        const taskRecord: TaskRecord = {
          id: Number(row.lastInsertRowid),
          taskId,
          topic,
          source,
          spec,
          status: "running",
          createdAt: now,
          updatedAt: now,
        };

        const result = await activeHandler.handle(taskRecord, {
          podConfig: config,
          now,
          publishEvent: async (evTopic, toPod, pl) => {
            await tincan.publish(evTopic, toPod, pl);
            db.prepare(`
              INSERT INTO tincan_messages (id, direction, topic, from_pod, to_pod, payload_json, status, created_at)
              VALUES (?, 'outbound', ?, ?, ?, ?, 'delivered', ?)
            `).run(`tc_${Date.now()}`, evTopic, config.id, toPod, JSON.stringify(pl), Date.now());
          },
        });

        db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE task_id = ?")
          .run(JSON.stringify(result), Date.now(), taskId);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, taskId, status: "completed", result }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Execution error" }));
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/heartbeat") {
      const ok = await tincan.sendHeartbeat();
      res.writeHead(ok ? 200 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`\n======================================================`);
    console.log(`⚡ FACTORY POD: ${config.name.toUpperCase()}`);
    console.log(`======================================================`);
    console.log(`🏢 Line of Business: ${config.lob}`);
    console.log(`🎭 Role:             ${config.role}`);
    console.log(`📡 Local Cockpit:    http://127.0.0.1:${config.port}`);
    console.log(`🛰️  Connected Hub:    ${config.hubUrl}`);
    console.log(`======================================================\n`);
  });
}

function parseJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function getLocalTasks(db: DatabaseSync): TaskRecord[] {
  try {
    const rows = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50").all() as any[];
    return rows.map((r) => ({
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

function getLocalMessages(db: DatabaseSync): any[] {
  try {
    return db.prepare("SELECT * FROM tincan_messages ORDER BY created_at DESC LIMIT 20").all();
  } catch {
    return [];
  }
}

main().catch(console.error);
