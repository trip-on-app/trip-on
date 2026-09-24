export interface Env {
  ADMIN_ID: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ADMIN_STATUS_URL: string;
  ADMIN_STATUS_TOKEN: string;
  ADMIN_CONTROL_URL?: string;
  AGENT_PUSH_TOKEN: string;
  DASHBOARD_ORIGIN: string;
  DB: D1Database;
}

const sessionMaxAgeSeconds = 60 * 60 * 8;

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const output = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  new Headers(headers).forEach((value, name) => output.set(name, value));
  return Response.json(data, { status, headers: output });
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get("origin");
  const headers = new Headers({ "vary": "Origin" });
  if (origin === env.DASHBOARD_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  }
  return headers;
}

function cookie(request: Request, name: string): string | null {
  const prefix = name + "=";
  for (const value of (request.headers.get("cookie") ?? "").split(";")) {
    const item = value.trim();
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return null;
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function sessionIsValid(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const token = bearer ?? cookie(request, "tripon_admin_session");
  if (!token) return false;
  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature || !/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;
  const expected = await hmac(expiresAt, env.SESSION_SECRET);
  if (signature.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < signature.length; index++) difference |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function sessionCookie(value: string, maxAge: number): string {
  return "tripon_admin_session=" + value + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + maxAge;
}

async function requireAdmin(request: Request, env: Env, cors: Headers): Promise<Response | null> {
  return await sessionIsValid(request, env) ? null : json({ error: "AUTH_REQUIRED" }, 401, cors);
}

function secretMatches(candidate: string | null, expected: string): boolean {
  if (!candidate || !expected) return false;
  const left = new TextEncoder().encode(candidate);
  const right = new TextEncoder().encode(expected);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function pushPcStatus(request: Request, env: Env): Promise<Response> {
  if (!secretMatches(request.headers.get("X-TripOn-Agent-Token"), env.AGENT_PUSH_TOKEN)) return json({ error: "AGENT_AUTH_REQUIRED" }, 401);
  const raw = await request.text();
  if (raw.length > 8_192) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return json({ error: "INVALID_JSON" }, 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "INVALID_STATUS" }, 400);
  const body = input as Record<string, unknown>;
  const percent = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
  const temperature = body.gpuTempC === null || (typeof body.gpuTempC === "number" && Number.isFinite(body.gpuTempC) && body.gpuTempC >= -20 && body.gpuTempC <= 150);
  const averages = body.averageLatencyMs;
  const serverId = body.serverId === "pc-1" || body.serverId === "pc-2" ? body.serverId : null;
  if (!serverId || !percent(body.cpu) || !percent(body.gpu) || !percent(body.ram) || !temperature || !averages || typeof averages !== "object") return json({ error: "INVALID_STATUS" }, 400);
  const latency = averages as Record<string, unknown>;
  for (const key of ["daily", "weekly", "monthly"]) if (latency[key] !== null && (typeof latency[key] !== "number" || !Number.isFinite(latency[key]) || latency[key] < 0 || latency[key] > 120_000)) return json({ error: "INVALID_STATUS" }, 400);
  const status = {
    serverId,
    name: typeof body.name === "string" ? body.name.slice(0, 80) : (serverId === "pc-1" ? "AI PC 01" : "AI PC 02"),
    model: typeof body.model === "string" ? body.model.slice(0, 80) : "gemma3:12b-it-qat",
    online: true,
    cpu: body.cpu,
    gpu: body.gpu,
    ram: body.ram,
    gpuTempC: body.gpuTempC,
    lastAiResponseAt: typeof body.lastAiResponseAt === "string" ? body.lastAiResponseAt.slice(0, 40) : null,
    averageLatencyMs: { daily: latency.daily, weekly: latency.weekly, monthly: latency.monthly },
    requests: body.requests && typeof body.requests === "object" ? body.requests : { total: 0, completed: 0, failed: 0, active: 0 },
  };
  await env.DB.prepare("INSERT INTO admin_pc_status (server_id, status_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(server_id) DO UPDATE SET status_json = excluded.status_json, updated_at = excluded.updated_at").bind(serverId, JSON.stringify(status), new Date().toISOString()).run();
  return json({ ok: true }, 202);
}

async function readPcStatuses(env: Env, cors: Headers): Promise<Response> {
  const result = await env.DB.prepare("SELECT server_id, status_json, updated_at FROM admin_pc_status WHERE server_id IN ('pc-1','pc-2')").all<{ server_id: string; status_json: string; updated_at: string }>();
  const rows = new Map((result.results || []).map(row => [row.server_id, row]));
  const servers = ["pc-1", "pc-2"].map(serverId => {
    const row = rows.get(serverId);
    if (!row) return { serverId, name: serverId === "pc-1" ? "AI PC 01" : "AI PC 02", model: "gemma3:12b-it-qat", online: false, cpu: null, gpu: null, ram: null, gpuTempC: null, lastAiResponseAt: null, averageLatencyMs: { daily: null, weekly: null, monthly: null }, requests: { total: 0, completed: 0, failed: 0, active: 0 }, lastSeenAt: null };
    const status = JSON.parse(row.status_json) as Record<string, unknown>;
    const online = Date.now() - Date.parse(row.updated_at) <= 75_000;
    return { ...status, serverId, online, lastSeenAt: row.updated_at };
  });
  return json({ servers }, 200, cors);
}

async function pollPcCommand(request: Request, env: Env): Promise<Response> {
  if (!secretMatches(request.headers.get("X-TripOn-Agent-Token"), env.AGENT_PUSH_TOKEN)) return json({ error: "AGENT_AUTH_REQUIRED" }, 401);
  const serverId = new URL(request.url).searchParams.get("serverId");
  if (serverId !== "pc-1" && serverId !== "pc-2") return json({ error: "INVALID_SERVER_ID" }, 400);
  const row = await env.DB.prepare("SELECT id, action FROM admin_pc_commands WHERE server_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1").bind(serverId).first<{ id: string; action: string }>();
  if (!row) return json({ command: null });
  const claimed = await env.DB.prepare("UPDATE admin_pc_commands SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'").bind(new Date().toISOString(), row.id).run();
  return json({ command: claimed.meta.changes ? row : null });
}

async function recordPcCommandResult(request: Request, env: Env): Promise<Response> {
  if (!secretMatches(request.headers.get("X-TripOn-Agent-Token"), env.AGENT_PUSH_TOKEN)) return json({ error: "AGENT_AUTH_REQUIRED" }, 401);
  const body = await request.json<{ id?: unknown; serverId?: unknown; status?: unknown; result?: unknown }>().catch(() => ({}));
  const serverId = body.serverId === "pc-1" || body.serverId === "pc-2" ? body.serverId : new URL(request.url).searchParams.get("serverId");
  if ((serverId !== "pc-1" && serverId !== "pc-2") || typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id) || !["succeeded", "failed"].includes(String(body.status))) return json({ error: "INVALID_COMMAND_RESULT" }, 400);
  const result = typeof body.result === "string" ? body.result.slice(0, 300) : "";
  const saved = await env.DB.prepare("UPDATE admin_pc_commands SET status = ?, result = ?, updated_at = ? WHERE id = ? AND server_id = ? AND status = 'processing'").bind(body.status, result, new Date().toISOString(), body.id, serverId).run();
  return json({ ok: saved.meta.changes > 0 });
}

type PromotionInput = { code?: unknown; plan?: unknown; people?: unknown; date?: unknown };

function promotionInput(body: PromotionInput): { code: string; plan: "Pro" | "Enterprise"; people: number | null; date: string | null } | null {
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const plan = body.plan === "Pro" || body.plan === "Enterprise" ? body.plan : null;
  const people = body.people === null || body.people === undefined || body.people === "" ? null : Number(body.people);
  const date = body.date === null || body.date === undefined || body.date === "" ? null : String(body.date);
  if (!/^[A-Z0-9_-]{4,48}$/.test(code) || !plan || (people !== null && (!Number.isInteger(people) || people < 1)) || (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date))) return null;
  return { code, plan, people, date };
}

async function listPromotions(env: Env, cors: Headers): Promise<Response> {
  const result = await env.DB.prepare("SELECT id, code, plan, max_uses AS people, used_count AS used, expires_at AS date, created_at AS createdAt, updated_at AS updatedAt FROM admin_promotions ORDER BY updated_at DESC").all();
  return json({ promotions: result.results }, 200, cors);
}

async function savePromotion(request: Request, env: Env, cors: Headers, id?: string): Promise<Response> {
  const body = await request.json<PromotionInput>().catch(() => ({}));
  const input = promotionInput(body);
  if (!input) return json({ error: "INVALID_PROMOTION" }, 400, cors);
  const now = new Date().toISOString();
  const promotionId = id ?? crypto.randomUUID();
  try {
    if (id) {
      const result = await env.DB.prepare("UPDATE admin_promotions SET code = ?, plan = ?, max_uses = ?, expires_at = ?, updated_at = ? WHERE id = ?").bind(input.code, input.plan, input.people, input.date, now, promotionId).run();
      if (!result.meta.changes) return json({ error: "PROMOTION_NOT_FOUND" }, 404, cors);
    } else {
      await env.DB.prepare("INSERT INTO admin_promotions (id, code, plan, max_uses, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(promotionId, input.code, input.plan, input.people, input.date, now, now).run();
    }
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return json({ error: "DUPLICATE_CODE" }, 409, cors);
    throw error;
  }
  return json({ ok: true, id: promotionId }, id ? 200 : 201, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method === "POST" && url.pathname === "/api/agent/status") return pushPcStatus(request, env);
    if (request.method === "GET" && url.pathname === "/api/agent/control") return pollPcCommand(request, env);
    if (request.method === "POST" && url.pathname === "/api/agent/control-result") return recordPcCommandResult(request, env);

    if (request.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await request.json<unknown>().catch(() => null);
      if (!body || typeof body !== "object") return json({ error: "INVALID_REQUEST" }, 400, cors);
      const { id, password } = body as { id?: unknown; password?: unknown };
      if (id !== env.ADMIN_ID || password !== env.ADMIN_PASSWORD) return json({ error: "INVALID_CREDENTIALS" }, 401, cors);
      const expiresAt = String(Date.now() + sessionMaxAgeSeconds * 1000);
      const token = expiresAt + "." + await hmac(expiresAt, env.SESSION_SECRET);
      return json({ ok: true, token }, 200, new Headers([...cors, ["set-cookie", sessionCookie(token, sessionMaxAgeSeconds)]]));
    }

    if (request.method === "GET" && url.pathname === "/api/admin/session") {
      const denied = await requireAdmin(request, env, cors);
      return denied ?? json({ ok: true }, 200, cors);
    }

    if (request.method === "POST" && url.pathname === "/api/admin/logout") {
      return json({ ok: true }, 200, new Headers([...cors, ["set-cookie", sessionCookie("", 0)]]));
    }

    const denied = await requireAdmin(request, env, cors);
    if (denied) return denied;

    if (request.method === "GET" && url.pathname === "/api/servers") {
      return readPcStatuses(env, cors);
    }

    if (request.method === "GET" && url.pathname === "/api/promotions") {
      return listPromotions(env, cors);
    }

    if (request.method === "POST" && url.pathname === "/api/promotions") {
      return savePromotion(request, env, cors);
    }

    const promotionMatch = url.pathname.match(/^\/api\/promotions\/([0-9a-f-]{36})$/i);
    if (request.method === "PUT" && promotionMatch) {
      return savePromotion(request, env, cors, promotionMatch[1]);
    }

    if (request.method === "POST" && url.pathname === "/api/control") {
      const body = await request.json<{ serverId?: unknown; action?: unknown }>().catch(() => ({}));
      if ((body.serverId !== "pc-1" && body.serverId !== "pc-2") || !["restart_pc", "shutdown"].includes(String(body.action))) return json({ error: "INVALID_CONTROL_ACTION" }, 400, cors);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO admin_pc_commands (id, server_id, action, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)").bind(id, body.serverId, body.action, now, now).run();
      return json({ ok: true, queued: true, id }, 202, cors);
    }

    return json({ error: "NOT_FOUND" }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
