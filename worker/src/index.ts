export interface Env {
  ADMIN_ID: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ADMIN_STATUS_URL: string;
  ADMIN_STATUS_TOKEN: string;
  ADMIN_CONTROL_URL?: string;
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

async function proxyStatus(env: Env, cors: Headers): Promise<Response> {
  const upstream = await fetch(env.ADMIN_STATUS_URL, {
    headers: { "X-TripOn-Gateway-Token": env.ADMIN_STATUS_TOKEN },
    signal: AbortSignal.timeout(10_000),
  });
  if (!upstream.ok) {
    console.error("ADMIN_STATUS_UPSTREAM_ERROR", upstream.status);
    return json({ error: "UPSTREAM_UNAVAILABLE", upstreamStatus: upstream.status }, 503, cors);
  }
  const payload = await upstream.json<unknown>();
  return json(payload, 200, cors);
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
      return proxyStatus(env, cors);
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
      if (!env.ADMIN_CONTROL_URL) return json({ error: "CONTROL_NOT_CONFIGURED" }, 503, cors);
      const body = await request.text();
      const upstream = await fetch(env.ADMIN_CONTROL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "X-TripOn-Gateway-Token": env.ADMIN_STATUS_TOKEN },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", ...cors } });
    }

    return json({ error: "NOT_FOUND" }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
