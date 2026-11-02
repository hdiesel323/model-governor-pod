import { PodConfig, TaskRecord } from "./types.js";

export function renderPodUiHtml(
  config: PodConfig,
  tasks: TaskRecord[],
  messages: any[] = []
): string {
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const runningCount = tasks.filter((t) => t.status === "running").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;

  const taskRows = tasks.map((t) => {
    const statusColor = t.status === "completed" ? "#10b981" : t.status === "running" ? "#3b82f6" : t.status === "failed" ? "#ef4444" : "#f59e0b";
    const humanDef = getTaskHumanDefinition(t, config);
    return `
      <tr>
        <td class="mono font-xs">
          <div style="font-weight: 600; color: #60a5fa;">${t.taskId}</div>
        </td>
        <td style="max-width: 320px;">
          <div style="font-weight: 600; color: #f8fafc; font-size: 0.85rem;">${escapeHtml(humanDef.title)}</div>
          <div style="color: #94a3b8; font-size: 0.74rem; line-height: 1.35; margin-top: 2px;">${escapeHtml(humanDef.summary)}</div>
          <div style="margin-top: 4px;"><span class="badge-topic font-xs">${escapeHtml(t.topic)}</span></div>
        </td>
        <td class="font-xs">${escapeHtml(t.source)}</td>
        <td><span class="badge" style="background: rgba(255,255,255,0.06); color: ${statusColor};">${t.status}</span></td>
        <td class="mono font-xs">${new Date(t.createdAt).toLocaleTimeString()}</td>
        <td>
          <details>
            <summary class="mono font-xs pointer inspect-btn">View Result</summary>
            <pre class="payload-box">${escapeHtml(JSON.stringify(t.result || t.spec, null, 2))}</pre>
          </details>
        </td>
      </tr>
    `;
  }).join("");

  const messageRows = messages.map((m) => {
    const dirBadge = m.direction === "inbound" ? `<span style="color:#60a5fa;">&darr; IN</span>` : `<span style="color:#34d399;">&uarr; OUT</span>`;
    return `
      <tr>
        <td class="mono font-xs">${dirBadge}</td>
        <td class="font-xs"><span class="badge-topic">${escapeHtml(m.topic)}</span></td>
        <td class="mono font-xs">${escapeHtml(m.from_pod || m.fromPod)} &rarr; ${escapeHtml(m.to_pod || m.toPod)}</td>
        <td class="mono font-xs">${new Date(m.created_at || m.createdAt).toLocaleTimeString()}</td>
      </tr>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(config.name)} &mdash; Worker Pod Cockpit</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚡</text></svg>">
  <style>
    :root {
      --bg-dark: #080b11;
      --bg-panel: #0f172a;
      --bg-card: #131c31;
      --border: #1e293b;
      --border-focus: #3b82f6;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --green: #10b981;
      --yellow: #f59e0b;
      --red: #ef4444;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .logo-area { display: flex; align-items: center; gap: 14px; }
    .pod-badge {
      background: linear-gradient(135deg, #10b981, #059669);
      color: white;
      font-weight: 800;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      letter-spacing: 0.05em;
      box-shadow: 0 0 15px rgba(16, 185, 129, 0.3);
    }
    .lob-badge {
      background: rgba(139, 92, 246, 0.15);
      border: 1px solid rgba(139, 92, 246, 0.35);
      color: #c084fc;
      font-size: 0.75rem;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    h1 { font-size: 1.45rem; font-weight: 700; }
    .header-stats { display: flex; gap: 16px; font-size: 0.85rem; color: var(--text-muted); }
    .header-stats span strong { color: var(--text-main); }

    .nav-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 16px;
      margin-bottom: 24px;
    }
    .hub-link {
      color: #60a5fa;
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .hub-link:hover { text-decoration: underline; }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 28px;
    }
    @media (max-width: 1024px) {
      .grid-2 { grid-template-columns: 1fr; }
    }

    .panel {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .panel h2 {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .caps-box { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
    .cap-tag {
      background: #1e293b;
      color: #94a3b8;
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    .form-box textarea {
      width: 100%;
      height: 90px;
      background: #080b11;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      color: var(--text-main);
      font-size: 0.9rem;
      resize: vertical;
      font-family: inherit;
      outline: none;
    }
    .form-box textarea:focus { border-color: var(--border-focus); }
    .form-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 12px;
    }
    .btn-action {
      background: #2563eb;
      color: white;
      border: none;
      padding: 8px 18px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .btn-action:hover { background: #1d4ed8; }

    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 10px 12px; color: var(--text-muted); border-bottom: 1px solid var(--border); font-size: 0.78rem; text-transform: uppercase; }
    td { padding: 10px 12px; border-bottom: 1px solid #162032; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .mono { font-family: ui-monospace, monospace; }
    .font-xs { font-size: 0.78rem; }
    .pointer { cursor: pointer; }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-topic {
      background: #1e293b;
      color: #38bdf8;
      font-family: ui-monospace, monospace;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.75rem;
    }
    .payload-box {
      margin-top: 6px;
      padding: 8px 10px;
      background: #050810;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: #94a3b8;
      max-height: 140px;
      overflow-y: auto;
      font-size: 0.72rem;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo-area">
      <div class="pod-badge">POD</div>
      <div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <h1>${escapeHtml(config.name)}</h1>
          <span class="lob-badge">DOMAIN: ${escapeHtml(config.lob)}</span>
        </div>
        <div style="font-size: 0.78rem; color: #64748b;">ID: <code>${escapeHtml(config.id)}</code> &bull; Role: <code>${escapeHtml(config.role)}</code></div>
      </div>
    </div>
    <div class="header-stats">
      <span>Completed: <strong style="color: #10b981;">${completedCount}</strong></span>
      <span>Running: <strong style="color: #3b82f6;">${runningCount}</strong></span>
      <span>Failed: <strong style="color: #ef4444;">${failedCount}</strong></span>
      <span>Total: <strong>${tasks.length}</strong></span>
    </div>
  </header>

  <div class="nav-bar">
    <span style="font-size: 0.8rem; color: var(--text-muted);">Connected Mesh Hub:</span>
    <a href="${escapeHtml(config.hubUrl)}" target="_blank" class="hub-link">${escapeHtml(config.hubUrl)} &nearr;</a>
    <button class="btn-action" style="margin-left: auto; padding: 4px 12px; font-size: 0.78rem;" onclick="triggerHeartbeat()">Send Heartbeat</button>
  </div>

  <div class="grid-2">
    <!-- Pod Metadata & Capabilities -->
    <div class="panel">
      <h2>Pod Capabilities & Status</h2>
      <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px;">
        Registered functional capabilities advertised to the central orchestration hub:
      </div>
      <div class="caps-box">
        ${config.capabilities.map((c) => `<span class="cap-tag">${escapeHtml(c)}</span>`).join("")}
      </div>
    </div>

    <!-- Manual Task Trigger / Simulator -->
    <div class="panel">
      <h2>Manual Task Simulator</h2>
      <div class="form-box">
        <textarea id="taskInput" placeholder="Submit mock task JSON or instruction e.g. { 'topic': 'data.process', 'payload': { 'recordId': 'rec_101', 'action': 'analyze' } }"></textarea>
        <div class="form-controls">
          <span id="triggerMsg" style="font-size: 0.82rem;"></span>
          <button class="btn-action" onclick="executeMockTask()">Execute Task</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Task Execution Ledger -->
  <div class="panel" style="margin-bottom: 28px;">
    <h2>
      <span>Task Execution Ledger (${tasks.length})</span>
      <span style="font-size: 0.78rem; color: #64748b;">Durable task state machine</span>
    </h2>
    <div style="overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th>Task ID</th>
            <th>Human Definition & Topic</th>
            <th>Source</th>
            <th>Status</th>
            <th>Time</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          ${taskRows.length > 0 ? taskRows : `<tr><td colspan="6" style="text-align:center; padding: 24px; color:#64748b;">No tasks executed yet</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    async function triggerHeartbeat() {
      try {
        const res = await fetch("/api/heartbeat", { method: "POST" });
        if (res.ok) alert("Heartbeat delivered to Factory Hub!");
        else alert("Heartbeat failed");
      } catch (err) {
        alert("Heartbeat network error");
      }
    }

    async function executeMockTask() {
      const input = document.getElementById("taskInput");
      const msg = document.getElementById("triggerMsg");
      const raw = input.value.trim();
      if (!raw) return;

      msg.innerText = "Executing...";
      msg.style.color = "#3b82f6";

      let spec = { raw };
      try { spec = JSON.parse(raw); } catch {}

      try {
        const res = await fetch("/api/task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: "task_manual_" + Date.now(),
            topic: spec.topic || "custom.execution",
            source: "pod-cockpit-ui",
            spec,
          }),
        });

        const data = await res.json();
        if (res.ok) {
          msg.innerText = "Task completed successfully!";
          msg.style.color = "#10b981";
          input.value = "";
          setTimeout(() => window.location.reload(), 1200);
        } else {
          msg.innerText = "Error: " + (data.error || "Failed");
          msg.style.color = "#ef4444";
        }
      } catch (err) {
        msg.innerText = "Network error";
        msg.style.color = "#ef4444";
      }
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getTaskHumanDefinition(t: TaskRecord, config: PodConfig): { title: string; summary: string } {
  const topic = t.topic || "task.execution";
  const spec = t.spec || {};

  // Parse topic structure: [entity, ...actionSegments]
  const topicParts = topic.split(".");
  const entity = topicParts[0].charAt(0).toUpperCase() + topicParts[0].slice(1);
  const action = topicParts.slice(1).join(" ").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Execution";

  let subject = spec.title || spec.name || spec.target || spec.domain || spec.action || "";
  if (typeof subject === "string" && (subject.startsWith("http://") || subject.startsWith("https://"))) {
    try {
      subject = new URL(subject).hostname.replace(/^www\./, "");
    } catch {}
  }

  const title = subject ? `${entity} ${action}: ${subject}` : `${entity} ${action}`;

  // Formulate general execution summary based on task lifecycle
  let summary = `Autonomous execution by ${config.name} (${config.role}) for LOB: ${config.lob}.`;
  if (t.status === "completed" && t.result) {
    if (typeof t.result === "string") {
      summary = `Execution completed: "${t.result.slice(0, 70)}"`;
    } else if (typeof t.result === "object") {
      const keys = Object.keys(t.result);
      summary = `Completed successfully with ${keys.length} verified output field${keys.length === 1 ? "" : "s"}.`;
    }
  } else if (t.status === "failed") {
    summary = `Failed: ${t.errorMessage || "Execution error encountered"}`;
  } else if (t.status === "running") {
    summary = `Task currently processing on edge runtime.`;
  }

  return { title, summary };
}
