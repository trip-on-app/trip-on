const API_BASE = "";
const REFRESH_MS = 10000;

const demoServers = [
  {
    id: "pc1",
    name: "PC 1 · Legion",
    subtitle: "Gaming / backup AI server",
    online: true,
    cpu: 42,
    ramUsedGb: 14.2,
    ramTotalGb: 32,
    gpu: 27,
    vramUsedGb: 3.4,
    vramTotalGb: 8,
    gpuTempC: 63,
    ollama: true,
    qwen: true,
    tunnel: true,
    draining: false,
    activeRequests: 1,
    latencyMs: 1800,
    lastSeen: new Date().toISOString()
  },
  {
    id: "pc2",
    name: "PC 2 · AI Server",
    subtitle: "Primary Qwen server",
    online: true,
    cpu: 19,
    ramUsedGb: 11.4,
    ramTotalGb: 32,
    gpu: null,
    vramUsedGb: null,
    vramTotalGb: null,
    gpuTempC: null,
    ollama: true,
    qwen: true,
    tunnel: true,
    draining: false,
    activeRequests: 0,
    latencyMs: 2400,
    lastSeen: new Date().toISOString()
  }
];

let servers = structuredClone(demoServers);
let usingDemo = true;
let pendingAction = null;
let timer = null;

const els = {
  grid: document.querySelector("#serverGrid"),
  onlineCount: document.querySelector("#onlineCount"),
  activeRequests: document.querySelector("#activeRequests"),
  avgLatency: document.querySelector("#avgLatency"),
  routingStatus: document.querySelector("#routingStatus"),
  modeBadge: document.querySelector("#modeBadge"),
  refreshBtn: document.querySelector("#refreshBtn"),
  activityList: document.querySelector("#activityList"),
  activityEmpty: document.querySelector("#activityEmpty"),
  authDialog: document.querySelector("#authDialog"),
  authForm: document.querySelector("#authForm"),
  authTitle: document.querySelector("#authTitle"),
  authText: document.querySelector("#authText"),
  passwordInput: document.querySelector("#passwordInput"),
  dangerConfirm: document.querySelector("#dangerConfirm"),
  confirmLabel: document.querySelector("#confirmLabel"),
  authError: document.querySelector("#authError"),
  closeAuthBtn: document.querySelector("#closeAuthBtn"),
  cancelAuthBtn: document.querySelector("#cancelAuthBtn")
};

function pct(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function formatLastSeen(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusBadge(ok, textTrue = "Running", textFalse = "Stopped") {
  return '<strong>' + (ok ? textTrue : textFalse) + '</strong>';
}

function metric(label, value, display) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return `
    <div class="metric-row">
      <span class="metric-label">${label}</span>
      <div class="bar" aria-hidden="true"><i style="width:${safe}%"></i></div>
      <span class="metric-value">${display}</span>
    </div>
  `;
}

function render() {
  const online = servers.filter(s => s.online);
  const active = servers.reduce((sum, s) => sum + (s.activeRequests || 0), 0);
  const latencies = online.map(s => s.latencyMs).filter(Number.isFinite);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a,b) => a+b, 0) / latencies.length) : null;

  els.onlineCount.textContent = `${online.length} / ${servers.length}`;
  els.activeRequests.textContent = String(active);
  els.avgLatency.textContent = avgLatency ? `${avgLatency} ms` : "—";
  els.routingStatus.textContent = online.length >= 2 ? "Redundant" : online.length === 1 ? "Failover only" : "Offline";

  els.modeBadge.textContent = usingDemo ? "DEMO MODE" : "LIVE";
  els.modeBadge.className = "badge " + (usingDemo ? "neutral" : "online");

  els.grid.innerHTML = servers.map(serverCard).join("");
  bindControlButtons();
}

function serverCard(s) {
  const ramPct = pct(s.ramUsedGb, s.ramTotalGb);
  const vramPct = pct(s.vramUsedGb, s.vramTotalGb);
  const statusClass = s.online ? (s.draining ? "warn" : "online") : "offline";
  const statusText = !s.online ? "OFFLINE" : s.draining ? "DRAINING" : "ONLINE";
  const gpuDisplay = Number.isFinite(s.gpu) ? `${s.gpu}%` : "N/A";
  const vramDisplay = Number.isFinite(s.vramUsedGb) && Number.isFinite(s.vramTotalGb)
    ? `${s.vramUsedGb.toFixed(1)} / ${s.vramTotalGb} GB`
    : "N/A";
  const tempDisplay = Number.isFinite(s.gpuTempC) ? `${s.gpuTempC}°C` : "N/A";

  return `
    <article class="server-card ${s.online ? "" : "offline-card"}">
      <div class="server-card-head">
        <div class="server-name">
          <strong>${s.name}</strong>
          <span>${s.subtitle || s.id}</span>
        </div>
        <span class="badge ${statusClass}">${statusText}</span>
      </div>

      <div class="metrics">
        ${metric("CPU", s.cpu, Number.isFinite(s.cpu) ? s.cpu + "%" : "N/A")}
        ${metric("RAM", ramPct, Number.isFinite(s.ramUsedGb) ? s.ramUsedGb.toFixed(1) + " / " + s.ramTotalGb + " GB" : "N/A")}
        ${metric("GPU", s.gpu, gpuDisplay)}
        ${metric("VRAM", vramPct, vramDisplay)}
      </div>

      <div class="status-grid">
        <div class="status-item"><span>Qwen</span>${statusBadge(s.qwen)}</div>
        <div class="status-item"><span>Ollama</span>${statusBadge(s.ollama)}</div>
        <div class="status-item"><span>Tunnel</span>${statusBadge(s.tunnel, "Connected", "Disconnected")}</div>
        <div class="status-item"><span>GPU temp</span><strong>${tempDisplay}</strong></div>
        <div class="status-item"><span>Requests</span><strong>${s.activeRequests ?? 0}</strong></div>
        <div class="status-item"><span>Latency</span><strong>${Number.isFinite(s.latencyMs) ? s.latencyMs + " ms" : "—"}</strong></div>
      </div>

      <div class="server-meta">
        <div><span>Last seen</span><strong>${formatLastSeen(s.lastSeen)}</strong></div>
        <div><span>Role</span><strong>${s.id === "pc2" ? "Primary" : "Backup"}</strong></div>
        <div><span>Routing</span><strong>${s.draining ? "Paused" : s.online ? "Accepting" : "Unavailable"}</strong></div>
      </div>

      <div class="controls">
        <button class="btn secondary control-btn" data-server="${s.id}" data-action="restart_qwen">Restart Qwen</button>
        <button class="btn secondary control-btn" data-server="${s.id}" data-action="restart_tunnel">Restart Tunnel</button>
        <button class="btn secondary control-btn" data-server="${s.id}" data-action="${s.draining ? "resume" : "drain"}">${s.draining ? "Resume" : "Drain"}</button>
        <button class="btn ghost-danger control-btn" data-server="${s.id}" data-action="restart_pc">Restart PC</button>
        <button class="btn ghost-danger control-btn" data-server="${s.id}" data-action="shutdown">Shutdown</button>
      </div>
    </article>
  `;
}

function bindControlButtons() {
  document.querySelectorAll(".control-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const serverId = btn.dataset.server;
      const action = btn.dataset.action;
      const protectedAction = ["restart_pc", "shutdown"].includes(action);

      if (protectedAction) {
        openAuth(serverId, action);
      } else {
        sendControl(serverId, action, null);
      }
    });
  });
}

function openAuth(serverId, action) {
  const server = servers.find(s => s.id === serverId);
  pendingAction = { serverId, action };
  els.passwordInput.value = "";
  els.dangerConfirm.checked = false;
  els.authError.textContent = "";

  const isShutdown = action === "shutdown";
  els.authTitle.textContent = isShutdown ? "Shutdown PC" : "Restart PC";
  els.authText.textContent = `${server?.name || serverId} will ${isShutdown ? "shut down" : "restart"}. AI service may be temporarily unavailable.`;
  els.confirmLabel.style.display = "flex";
  els.authDialog.showModal();
  els.passwordInput.focus();
}

async function sendControl(serverId, action, password) {
  const label = action.replaceAll("_", " ");
  addActivity(serverId, label, "Pending");

  if (usingDemo) {
    applyDemoAction(serverId, action);
    updateLatestActivity("Done");
    return;
  }

  try {
    const res = await fetch(API_BASE + "/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, action, password })
    });

    if (!res.ok) throw new Error("Control request failed");
    updateLatestActivity("Done");
    await loadServers();
  } catch (err) {
    updateLatestActivity("Failed");
    alert("Command failed: " + err.message);
  }
}

function applyDemoAction(serverId, action) {
  const s = servers.find(x => x.id === serverId);
  if (!s) return;

  if (action === "drain") s.draining = true;
  if (action === "resume") s.draining = false;

  if (action === "restart_qwen") {
    s.qwen = false;
    render();
    setTimeout(() => { s.qwen = true; s.lastSeen = new Date().toISOString(); render(); }, 1200);
  }

  if (action === "restart_tunnel") {
    s.tunnel = false;
    render();
    setTimeout(() => { s.tunnel = true; s.lastSeen = new Date().toISOString(); render(); }, 1200);
  }

  if (action === "restart_pc") {
    s.online = false;
    s.qwen = false;
    s.ollama = false;
    s.tunnel = false;
    render();
    setTimeout(() => {
      s.online = true;
      s.qwen = true;
      s.ollama = true;
      s.tunnel = true;
      s.lastSeen = new Date().toISOString();
      render();
    }, 2500);
  }

  if (action === "shutdown") {
    s.online = false;
    s.qwen = false;
    s.ollama = false;
    s.tunnel = false;
    s.activeRequests = 0;
  }

  render();
}

function addActivity(serverId, action, status) {
  els.activityEmpty.style.display = "none";
  const li = document.createElement("li");
  li.dataset.latest = "true";
  li.innerHTML = `
    <span class="activity-time">${new Date().toLocaleTimeString()}</span>
    <strong>${serverId.toUpperCase()} · ${action}</strong>
    <span class="activity-status">${status}</span>
  `;
  els.activityList.prepend(li);
}

function updateLatestActivity(status) {
  const latest = els.activityList.querySelector("li");
  if (!latest) return;
  const node = latest.querySelector(".activity-status");
  if (node) node.textContent = status;
}

async function loadServers() {
  try {
    const res = await fetch(API_BASE + "/api/servers", { cache: "no-store" });
    if (!res.ok) throw new Error("API unavailable");
    const data = await res.json();
    if (!Array.isArray(data.servers)) throw new Error("Invalid payload");
    servers = data.servers;
    usingDemo = false;
  } catch {
    usingDemo = true;
    servers.forEach(s => { if (s.online) s.lastSeen = new Date().toISOString(); });
  }
  render();
}

els.refreshBtn.addEventListener("click", loadServers);
els.closeAuthBtn.addEventListener("click", () => els.authDialog.close());
els.cancelAuthBtn.addEventListener("click", () => els.authDialog.close());

els.authForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!pendingAction) return;

  if (!els.passwordInput.value) {
    els.authError.textContent = "Enter the control password.";
    return;
  }
  if (!els.dangerConfirm.checked) {
    els.authError.textContent = "Confirm that you understand the interruption risk.";
    return;
  }

  const { serverId, action } = pendingAction;
  const password = els.passwordInput.value;
  els.authDialog.close();
  pendingAction = null;
  await sendControl(serverId, action, password);
});

loadServers();
timer = setInterval(loadServers, REFRESH_MS);
window.addEventListener("beforeunload", () => clearInterval(timer));
