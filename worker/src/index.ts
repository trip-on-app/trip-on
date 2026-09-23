export interface Env {
  ADMIN_ID: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ADMIN_STATUS_URL: string;
  ADMIN_STATUS_TOKEN: string;
  ADMIN_CONTROL_URL?: string;
}

const sessionMaxAgeSeconds = 60 * 60 * 8;

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
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
  const token = cookie(request, "tripon_admin_session");
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

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  return await sessionIsValid(request, env) ? null : json({ error: "AUTH_REQUIRED" }, 401);
}

async function proxyStatus(env: Env): Promise<Response> {
  const upstream = await fetch(env.ADMIN_STATUS_URL, {
    headers: { "X-TripOn-Gateway-Token": env.ADMIN_STATUS_TOKEN },
    signal: AbortSignal.timeout(10_000),
  });
  if (!upstream.ok) return json({ error: "UPSTREAM_UNAVAILABLE" }, 503);
  const payload = await upstream.json<unknown>();
  return json(payload);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = new Headers({
      "access-control-allow-origin": url.origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "vary": "Origin",
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await request.json<unknown>().catch(() => null);
      if (!body || typeof body !== "object") return json({ error: "INVALID_REQUEST" }, 400, cors);
      const { id, password } = body as { id?: unknown; password?: unknown };
      if (id !== env.ADMIN_ID || password !== env.ADMIN_PASSWORD) return json({ error: "INVALID_CREDENTIALS" }, 401, cors);
      const expiresAt = String(Date.now() + sessionMaxAgeSeconds * 1000);
      const token = expiresAt + "." + await hmac(expiresAt, env.SESSION_SECRET);
      return json({ ok: true }, 200, new Headers([...cors, ["set-cookie", sessionCookie(token, sessionMaxAgeSeconds)]]));
    }

    if (request.method === "GET" && url.pathname === "/api/admin/session") {
      const denied = await requireAdmin(request, env);
      return denied ?? json({ ok: true }, 200, cors);
    }

    if (request.method === "POST" && url.pathname === "/api/admin/logout") {
      return json({ ok: true }, 200, new Headers([...cors, ["set-cookie", sessionCookie("", 0)]]));
    }

    const denied = await requireAdmin(request, env);
    if (denied) return denied;

    if (request.method === "GET" && url.pathname === "/api/servers") {
      return proxyStatus(env);
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