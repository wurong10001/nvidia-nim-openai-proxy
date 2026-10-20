export interface Env {
  ADMIN_KV: KVNamespace;
  ADMIN_TEMP_KV: KVNamespace;
  // Optional: shared upstream key. When unset, clients must supply their own.
  NIM_API_KEY?: string;
  // GATEWAY_API_KEY removed; API key comes from request header
  NIM_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
}

async function md5Hash(plain: string): Promise<string> {
  const buf = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest('MD5', buf);
  const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
  return hash;
}

const DEFAULT_NIM_BASE_URL = "https://integrate.api.nvidia.com";
const ALLOWED_ROUTES = new Map<string, string[]>([
  ["/v1/models", ["GET"]],
  ["/v1/chat/completions", ["POST"]],
  ["/v1/completions", ["POST"]],
  ["/v1/embeddings", ["POST"]],
]);

const REQUEST_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "x-forwarded-for",
  "cf-connecting-ip",
  "cf-ray",
]);

const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
]);

function jsonError(status: number, message: string): Response {
  return Response.json(
    { error: { message, type: "proxy_error" } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const allowedOrigin = env.ALLOWED_ORIGIN;

  if (allowedOrigin) {
    if (origin === allowedOrigin) {
      headers.set("Access-Control-Allow-Origin", allowedOrigin);
      headers.set("Vary", "Origin");
    }
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }

  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, OpenAI-Organization, OpenAI-Project, X-Request-Id",
  );
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function createUpstreamUrl(pathname: string, search: string, base: string): URL {
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("NIM_BASE_URL must be an HTTPS origin");
  }
  url.pathname = pathname;
  url.search = search;
  return url;
}

function sanitizeResponseHeaders(source: Headers, cors: Headers): Headers {
  const headers = new Headers(source);
  for (const name of RESPONSE_HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
  headers.delete("content-length");
  headers.set("Cache-Control", "no-store");
  cors.forEach((value, name) => headers.set(name, value));
  return headers;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  }

  const cors = corsHeaders(request, env);
// Admin dashboard and APIs require the KV storage bindings.
if (url.pathname.startsWith("/op/admin") || url.pathname.startsWith("/op/api")) {
  if (!env.ADMIN_KV || !env.ADMIN_TEMP_KV) {
    return jsonError(503, "Admin storage not configured");
  }
}
// Serve admin dashboard
if (url.pathname.startsWith("/op/admin")) {
  const adminPage = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Admin Dashboard</title></head>
<body>
<h1>Admin Dashboard</h1>
<div id="app"></div>
<script>
async function loadData() {
  try {
    const res = await fetch("/op/api/test");
    const data = await res.json();
    document.getElementById("app").innerText = JSON.stringify(data);
  } catch (e) {
    document.getElementById("app").innerText = "Error loading data";
  }
}
loadData();
</script>
</body>
</html>`;
  return new Response(adminPage, { headers: cors, status: 200 });
}
// Simple admin API
if (url.pathname.startsWith("/op/api")) {
  const subpath = url.pathname.replace("/op/api", "");
  if (subpath === "/set-admin-pw" && request.method === "POST") {
    const body = (await request.json()) as { password?: string };
    const plainPwd = body.password;
    if (!plainPwd) {
      return jsonError(400, "Password required");
    }
    const hashed = await md5Hash(plainPwd);
    const existing = await env.ADMIN_KV.get("ADMIN_PASSWORD");
    if (existing) {
      return jsonError(409, "Admin password already set");
    }
    await env.ADMIN_KV.put("ADMIN_PASSWORD", hashed);
    return new Response(JSON.stringify({status:"ok"}), { headers: cors, status: 200 });
  }
  if (subpath === "/change-admin-pw" && request.method === "POST") {
    const token = request.headers.get("X-Admin-Token");
    if (!token) return jsonError(401, "Missing admin token");
    const tokenExists = await env.ADMIN_TEMP_KV.get(token);
    if (!tokenExists) return jsonError(403, "Invalid token");
    const body = (await request.json()) as { oldPassword?: string; newPassword?: string };
    const oldPwd = body.oldPassword;
    const newPwd = body.newPassword;
    if (!oldPwd || !newPwd) {
      return jsonError(400, "Old and new passwords required");
    }
    const oldHashed = await md5Hash(oldPwd);
    const stored = await env.ADMIN_KV.get("ADMIN_PASSWORD");
    if (oldHashed !== stored) return jsonError(403, "Old password incorrect");
    const newHashed = await md5Hash(newPwd);
    await env.ADMIN_KV.put("ADMIN_PASSWORD", newHashed);
    return new Response(JSON.stringify({status:"ok"}), { headers: cors, status: 200 });
  }
  if (subpath === "/login" && request.method === "POST") {
    const body = (await request.json()) as { password?: string };
    const pwd = body.password;
    if (!pwd) return jsonError(400, "Password required");
    const hashed = await md5Hash(pwd);
    const stored = await env.ADMIN_KV.get("ADMIN_PASSWORD");
    if (hashed !== stored) return jsonError(401, "Invalid password");
    const uuid = crypto.randomUUID();
    await env.ADMIN_TEMP_KV.put(uuid, "admin");
    return new Response(JSON.stringify({token: uuid}), { headers: cors, status:200 });
  }
  if (subpath === "/protected" && request.method === "GET") {
    const token = request.headers.get("X-Admin-Token");
    if (!token) return jsonError(401, "Missing token");
    const tokenExists = await env.ADMIN_TEMP_KV.get(token);
    if (!tokenExists) return jsonError(403, "Invalid token");
    return new Response(JSON.stringify({status:"access granted"}), { headers: cors, status:200 });
  }
  return jsonError(404, "API endpoint not found");
}
const methods = ALLOWED_ROUTES.get(url.pathname);
  if (!methods) {
    return jsonError(404, "Endpoint not found");
  }

  if (request.method === "OPTIONS") {
    if (env.ALLOWED_ORIGIN && request.headers.get("Origin") !== env.ALLOWED_ORIGIN) {
      return jsonError(403, "Origin not allowed");
    }
    return new Response(null, { status: 204, headers: cors });
  }

  if (!methods.includes(request.method)) {
    return jsonError(405, "Method not allowed");
  }
  // Determine NIM API key: env or request header
  let nimKey: string | undefined;
  if (env.NIM_API_KEY) {
    nimKey = env.NIM_API_KEY;
  } else {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return jsonError(401, "Missing API key");
    }
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    nimKey = match?.[1];
    if (!nimKey) {
      return jsonError(401, "Invalid API key format");
    }
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = createUpstreamUrl(
      url.pathname,
      url.search,
      env.NIM_BASE_URL ?? DEFAULT_NIM_BASE_URL,
    );
  } catch {
    return jsonError(500, "Invalid NIM upstream configuration");
  }

  const headers = new Headers(request.headers);
  for (const name of REQUEST_HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
  headers.delete("authorization");
  headers.set("Authorization", `Bearer ${nimKey}`);
  headers.set("Cache-Control", "no-store");

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" ? null : request.body,
      // Required when streaming a request body through the Workers runtime.
      // @ts-expect-error Cloudflare Workers supports streaming request bodies.
      duplex: "half",
      redirect: "manual",
    });
  } catch (error) {
    console.error("NIM upstream request failed", error);
    return jsonError(502, "NIM upstream request failed");
  }

  const responseBody =
    upstream.status === 204 || upstream.status === 205 || upstream.status === 304
      ? null
      : upstream.body;
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: sanitizeResponseHeaders(upstream.headers, cors),
  });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
