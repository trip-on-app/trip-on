const API_BASE = (window.TRIPON_ADMIN_API_BASE || "").replace(/\/$/, "");
const SESSION_TOKEN_KEY = "tripon_admin_session_token";
const REFRESH_MS = 10000;
let servers = [];
let pendingAction = null;
let timer = null;
const flight = {
  airlineName: "이스타항공",
  flightNumber: "ZE605",
  departureAt: "2026.09.29 07:25",
  arrivalAt: "2026.09.29 09:55",
  departureCode: "ICN",
  arrivalCode: "NRT",
  terminal: "P02",
  gate: "확인 중",
  seat: "확인 중",
  ...(window.TRIPON_DASHBOARD_FLIGHT || {})
};

const els = {
  loginView: document.querySelector("#loginView"),
  dashboardView: document.querySelector("#dashboardView"),
  loginForm: document.querySelector("#loginForm"),
  loginError: document.querySelector("#loginError"),
  grid: document.querySelector("#serverGrid"),
  onlineCount: document.querySelector("#onlineCount"),
  activeRequests: document.querySelector("#activeRequests"),
  avgLatency: document.querySelector("#avgLatency"),
  routingStatus: document.querySelector("#routingStatus"),
  modeBadge: document.querySelector("#modeBadge"),
  refreshBtn: document.querySelector("#refreshBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  activityList: document.querySelector("#activityList"),
  activityEmpty: document.querySelector("#activityEmpty"),
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmForm: document.querySelector("#confirmForm"),
  confirmTitle: document.querySelector("#confirmTitle"),
  confirmText: document.querySelector("#confirmText"),
  dangerConfirm: document.querySelector("#dangerConfirm"),
  confirmError: document.querySelector("#confirmError"),
  closeConfirmBtn: document.querySelector("#closeConfirmBtn"),
  cancelConfirmBtn: document.querySelector("#cancelConfirmBtn"),
  airlineName: document.querySelector("#airlineName"),
  flightNumber: document.querySelector("#flightNumber"),
  departureAt: document.querySelector("#departureAt"),
  arrivalAt: document.querySelector("#arrivalAt"),
  departureCode: document.querySelector("#departureCode"),
  arrivalCode: document.querySelector("#arrivalCode"),
  terminalValue: document.querySelector("#terminalValue"),
  gateValue: document.querySelector("#gateValue"),
  seatValue: document.querySelector("#seatValue")
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function pct(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function formatLastSeen(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function metric(label, value, display) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return '<div class="metric-row"><span class="metric-label">' + escapeHtml(label) + '</span><div class="bar" aria-hidden="true"><i style="width:' + safe + '%"></i></div><span class="metric-value">' + escapeHtml(display) + '</span></div>';
}

function statusBadge(ok, trueText = "정상", falseText = "중지") {
  return '<strong>' + (ok ? trueText : falseText) + '</strong>';
}

function serverCard(server) {
  const ramPct = pct(server.ramUsedGb, server.ramTotalGb);
  const vramPct = pct(server.vramUsedGb, server.vramTotalGb);
  const statusClass = server.online ? (server.draining ? "warn" : "online") : "offline";
  const statusText = !server.online ? "오프라인" : server.draining ? "대기" : "온라인";
  const modelRunning = Boolean(server.gemma ?? server.qwen);
  const vram = Number.isFinite(server.vramUsedGb) && Number.isFinite(server.vramTotalGb) ? server.vramUsedGb.toFixed(1) + " / " + server.vramTotalGb + " GB" : "N/A";
  const actions = [
    ["restart_gateway", "게이트웨이 재시작"],
    ["restart_tunnel", "터널 재시작"],
    [server.draining ? "resume" : "drain", server.draining ? "요청 재개" : "요청 중지"],
    ["restart_pc", "PC 재시작"],
    ["shutdown", "PC 종료"]
  ];
  return '<article class="server-card ' + (server.online ? "" : "offline-card") + '">' +
    '<div class="server-card-head"><div class="server-name"><strong>' + escapeHtml(server.name) + '</strong><span>' + escapeHtml(server.subtitle || server.id) + '</span></div><span class="badge ' + statusClass + '">' + statusText + '</span></div>' +
    '<div class="metrics">' +
      metric("CPU", server.cpu, Number.isFinite(server.cpu) ? server.cpu + "%" : "N/A") +
      metric("RAM", ramPct, Number.isFinite(server.ramUsedGb) ? server.ramUsedGb.toFixed(1) + " / " + server.ramTotalGb + " GB" : "N/A") +
      metric("GPU", server.gpu, Number.isFinite(server.gpu) ? server.gpu + "%" : "N/A") +
      metric("VRAM", vramPct, vram) +
    '</div>' +
    '<div class="status-grid">' +
      '<div class="status-item"><span>Gemma 3</span>' + statusBadge(modelRunning) + '</div>' +
      '<div class="status-item"><span>Ollama</span>' + statusBadge(server.ollama) + '</div>' +
      '<div class="status-item"><span>터널</span>' + statusBadge(server.tunnel, "연결됨", "연결 안 됨") + '</div>' +
      '<div class="status-item"><span>GPU 온도</span><strong>' + (Number.isFinite(server.gpuTempC) ? server.gpuTempC + "°C" : "N/A") + '</strong></div>' +
      '<div class="status-item"><span>진행 중 요청</span><strong>' + (server.activeRequests ?? 0) + '</strong></div>' +
      '<div class="status-item"><span>응답 시간</span><strong>' + (Number.isFinite(server.latencyMs) ? server.latencyMs + " ms" : "—") + '</strong></div>' +
    '</div>' +
    '<div class="server-meta"><div><span>마지막 확인</span><strong>' + formatLastSeen(server.lastSeen) + '</strong></div><div><span>역할</span><strong>' + escapeHtml(server.role || "AI 서버") + '</strong></div><div><span>요청 상태</span><strong>' + (server.draining ? "중지됨" : server.online ? "수신 중" : "사용 불가") + '</strong></div></div>' +
    '<div class="controls">' + actions.map(([action, label]) => '<button class="btn ' + (["restart_pc", "shutdown"].includes(action) ? "ghost-danger" : "secondary") + ' control-btn" data-server="' + escapeHtml(server.id) + '" data-action="' + action + '">' + label + '</button>').join("") + '</div></article>';
}

function renderFlightBoard() {
  els.airlineName.textContent = flight.airlineName;
  els.flightNumber.textContent = flight.flightNumber;
  els.departureAt.textContent = flight.departureAt;
  els.arrivalAt.textContent = flight.arrivalAt;
  els.departureCode.textContent = flight.departureCode;
  els.arrivalCode.textContent = flight.arrivalCode;
  els.terminalValue.textContent = flight.terminal;
  els.gateValue.textContent = flight.gate;
  els.seatValue.textContent = flight.seat;
}

function render() {
  const online = servers.filter(server => server.online);
  const active = servers.reduce((sum, server) => sum + (Number(server.activeRequests) || 0), 0);
  const latencies = online.map(server => server.latencyMs).filter(Number.isFinite);
  const average = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  els.onlineCount.textContent = online.length + " / " + servers.length;
  els.activeRequests.textContent = String(active);
  els.avgLatency.textContent = average ? average + " ms" : "—";
  els.routingStatus.textContent = online.length ? "정상" : "오프라인";
  els.modeBadge.textContent = "연결됨";
  els.modeBadge.className = "badge online";
  els.grid.innerHTML = servers.length ? servers.map(serverCard).join("") : '<div class="empty">등록된 AI 서버가 없습니다.</div>';
  document.querySelectorAll(".control-btn").forEach(button => button.addEventListener("click", () => openConfirm(button.dataset.server, button.dataset.action)));
}

function addActivity(serverId, action, status) {
  els.activityEmpty.style.display = "none";
  const item = document.createElement("li");
  item.innerHTML = '<span class="activity-time">' + new Date().toLocaleTimeString("ko-KR") + '</span><strong>' + escapeHtml(serverId) + " · " + escapeHtml(action) + '</strong><span class="activity-status">' + escapeHtml(status) + "</span>";
  els.activityList.prepend(item);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (token) headers.set("Authorization", "Bearer " + token);
  const response = await fetch(API_BASE + path, { credentials: "include", ...options, headers });
  if (response.status === 401) throw new Error("AUTH_REQUIRED");
  if (!response.ok) throw new Error("REQUEST_FAILED");
  return response.status === 204 ? null : response.json();
}

async function loadServers() {
  try {
    const data = await api("/api/servers", { cache: "no-store" });
    if (!Array.isArray(data.servers)) throw new Error("REQUEST_FAILED");
    servers = data.servers;
    render();
  } catch (error) {
    if (error.message === "AUTH_REQUIRED") return showLogin();
    els.modeBadge.textContent = "연결 오류";
    els.modeBadge.className = "badge offline";
    els.grid.innerHTML = '<div class="empty">서버 상태를 불러오지 못했습니다. 연결을 확인해 주세요.</div>';
  }
}

function showDashboard() {
  els.loginView.hidden = true;
  els.dashboardView.hidden = false;
  renderFlightBoard();
  loadServers();
  timer = setInterval(loadServers, REFRESH_MS);
}

function showLogin() {
  clearInterval(timer);
  els.dashboardView.hidden = true;
  els.loginView.hidden = false;
}

function openConfirm(serverId, action) {
  const dangerous = ["restart_pc", "shutdown"].includes(action);
  pendingAction = { serverId, action };
  els.dangerConfirm.checked = false;
  els.confirmError.textContent = "";
  els.confirmTitle.textContent = dangerous ? "위험한 명령 확인" : "명령 확인";
  els.confirmText.textContent = dangerous ? "실행하면 AI 서비스가 일시 중단될 수 있습니다." : "선택한 서버에 관리 명령을 보냅니다.";
  document.querySelector("#confirmLabel").style.display = dangerous ? "flex" : "none";
  els.confirmDialog.showModal();
}

async function sendControl(serverId, action) {
  addActivity(serverId, action.replaceAll("_", " "), "실행 중");
  try {
    await api("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverId, action }) });
    els.activityList.firstElementChild.querySelector(".activity-status").textContent = "완료";
    await loadServers();
  } catch (error) {
    els.activityList.firstElementChild.querySelector(".activity-status").textContent = "실패";
    if (error.message === "AUTH_REQUIRED") showLogin();
  }
}

els.loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  els.loginError.textContent = "";
  const form = new FormData(els.loginForm);
  try {
    const result = await api("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: form.get("id"), password: form.get("password") }) });
    sessionStorage.setItem(SESSION_TOKEN_KEY, result.token);
    els.loginForm.reset();
    showDashboard();
  } catch {
    els.loginError.textContent = "관리자 ID 또는 비밀번호를 확인해 주세요.";
  }
});
els.logoutBtn.addEventListener("click", async () => { try { await api("/api/admin/logout", { method: "POST" }); } finally { sessionStorage.removeItem(SESSION_TOKEN_KEY); showLogin(); } });
els.refreshBtn.addEventListener("click", loadServers);
els.closeConfirmBtn.addEventListener("click", () => els.confirmDialog.close());
els.cancelConfirmBtn.addEventListener("click", () => els.confirmDialog.close());
els.confirmForm.addEventListener("submit", async event => { event.preventDefault(); if (!pendingAction) return; const dangerous = ["restart_pc", "shutdown"].includes(pendingAction.action); if (dangerous && !els.dangerConfirm.checked) { els.confirmError.textContent = "서비스 중단 가능성을 확인해 주세요."; return; } const action = pendingAction; pendingAction = null; els.confirmDialog.close(); await sendControl(action.serverId, action.action); });

api("/api/admin/session", { cache: "no-store" }).then(showDashboard).catch(showLogin);
window.addEventListener("beforeunload", () => clearInterval(timer));
