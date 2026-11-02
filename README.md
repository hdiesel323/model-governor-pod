# Autonomous Worker Pod Chassis

> An edge-first, replicable template for building autonomous, durable worker pods with persistent state and real-time observability.

This repository provides a standardized chassis for creating specialized autonomous worker pods. Each pod is an independent, serverless micro-agent that runs 24/7 on edge infrastructure, executes assigned tasks, maintains persistent state, and communicates over an asynchronous event mesh.

---

## 🏗️ Architecture

Every pod built from this chassis is **edge-native, self-contained, and decoupled from developer machines**:

```
 ┌────────────────────────────────────────────────────────┐
 │            Central Orchestration Mesh / Hub            │
 │            (HTTP / Webhook / Event Mesh)               │
 └─────────────┬────────────────────────────▲─────────────┘
               │ task.assigned              │ heartbeat
               │ (Event Envelope)           │ task.progress / task.completed
               ▼                            │
 ┌──────────────────────────────────────────┴─────────────┐
 │       Autonomous Worker Pod (Cloudflare Worker)        │
 │                                                        │
 │  ┌──────────────┐   ┌───────────────┐  ┌─────────────┐ │
 │  │ / (Cockpit)  │   │  Event Mesh   │  │  Cron / 5m  │ │
 │  │ Dark Mode UI │   │  Client Node  │  │  Keepalive  │ │
 │  └──────────────┘   └───────┬───────┘  └──────┬──────┘ │
 │                             │                 │        │
 │                     ┌───────▼─────────────────▼──────┐ │
 │                     │ Pluggable Domain Task Handler  │ │
 │                     │       (src/handler.ts)         │ │
 │                     └───────────────┬────────────────┘ │
 │                                     │                  │
 │                             ┌───────▼───────┐          │
 │                             │ Cloudflare D1 │          │
 │                             │ / SQLite WAL  │          │
 │                             └───────────────┘          │
 └────────────────────────────────────────────────────────┘
```

1. **Edge-First Deployment**: Runs globally on Cloudflare Workers with an isolated Cloudflare D1 SQL database.
2. **Zero-Local Dependency**: No persistent background daemons or cron jobs required on local machines. Pods run 24/7 on distributed edge infrastructure.
3. **Dual-Engine Persistence**: Seamless parity between local development (Node.js + native `node:sqlite` in WAL mode) and edge production (Cloudflare D1 SQL database).
4. **Decoupled Architecture**: Developers only customize one file: [`src/handler.ts`](src/handler.ts). Database migrations, mesh routing, keepalives, and the web cockpit UI are handled automatically by the chassis.
5. **Universal Human-Readable Summary Engine**: Automatically transforms raw task payloads, topic namespaces, and resource URLs into clear, plain-English definitions for human review.

---

## ⚡ 1-Command Scaffolding

To stamp out a new worker pod instance from this chassis:

```bash
node bin/scaffold.js --name <pod-name> --role <role> --domain <domain> [options]
```

### Options:
- `--name`: Unique identifier for the pod (e.g. `document-parser`, `billing-auditor`, `data-indexer`)
- `--role`: Functional role (e.g. `parser`, `auditor`, `indexer`, `worker`)
- `--domain`: Project group or domain namespace (e.g. `operations`, `analytics`, `finance`)
- `--out`: Target output directory (defaults to `../<name>`)
- `--no-db`: Skip automatic Cloudflare D1 database provisioning

### Example:
```bash
node bin/scaffold.js \
  --name telemetry-processor \
  --role processor \
  --domain analytics
```

---

## 📁 Repository Structure

```
├── bin/
│   └── scaffold.js        # 1-command generator for new pod instances
├── src/
│   ├── types.ts           # Core interfaces (PodConfig, TaskRecord, TaskHandler)
│   ├── config.ts          # Environment configuration loader
│   ├── handler.ts         # ⭐ Pluggable business logic (ONLY FILE YOU MODIFY)
│   ├── tincan.ts          # Universal mesh client & event publisher
│   ├── ui.ts              # Built-in dark-mode Cockpit UI with task simulator
│   ├── worker.ts          # Cloudflare Worker entrypoint + scheduled cron handler
│   └── main.ts            # Local development runner (Node.js + node:sqlite)
├── tests/
│   └── pod.test.ts        # Unit test suite
├── schema.sql             # Dual D1 / SQLite database schema
├── wrangler.jsonc         # Cloudflare Workers configuration
├── justfile               # Operational recipe runner
└── package.json
```

---

## 🛠️ Implementing Custom Business Logic

To implement your pod's functionality, edit [`src/handler.ts`](src/handler.ts). The chassis calls `handle(task, context)` whenever a new task is received:

```typescript
import { TaskRecord, HandlerContext, TaskHandler } from "./types.js";

export class CustomPodHandler implements TaskHandler {
  public name = "custom-handler";

  public canHandle(topic: string, _spec: any): boolean {
    return true; // Match topics this pod specializes in
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, publishEvent } = context;

    // 1. Perform domain work (API calls, data processing, LLM inference, transformations)
    const output = await processTask(task.spec);

    // 2. Formulate execution result
    const result = {
      taskId: task.taskId,
      status: "completed",
      artifacts: output,
      completedAt: new Date(now).toISOString(),
    };

    // 3. Notify the central hub of completion over the event mesh
    await publishEvent("task.completed", "hub", {
      taskId: task.taskId,
      workerPod: podConfig.id,
      event: "completed",
      result,
      timestamp: now,
    });

    return result;
  }
}
```

---

## 🚀 Deployment

### 1. Configure Cloudflare D1 Database
Create an isolated D1 database for your pod:
```bash
wrangler d1 create <pod-name>-db
```
Paste the generated `database_id` into your `wrangler.jsonc`.

### 2. Apply Schema
```bash
wrangler d1 execute <pod-name>-db --remote --file=schema.sql -y
```

### 3. Deploy Worker
```bash
wrangler deploy
```

Your pod is now live globally at `https://<pod-name>.<account>.workers.dev`.

---

## 📊 Observability & Cockpit UI

Each pod serves a self-contained web Cockpit UI at `/`:
- **Real-Time Status**: Displays active capabilities, uptime status, and keepalive health.
- **Task Execution Ledger**: Live record of tasks executed, processing status, and verified outputs.
- **Manual Task Simulator**: Interactive form to trigger and test tasks directly against the edge runtime.

---

## 🧪 Local Testing

```bash
# Run unit test suite
npm test

# Type check
npm run check # or: npx tsc --noEmit

# Run local development server with SQLite WAL
npm run dev
```

---

## 📜 License
MIT License. Free to use, adapt, and build upon.
