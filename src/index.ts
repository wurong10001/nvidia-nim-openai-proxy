// KV 空间名：须与 wrangler.toml 中 [[kv_namespaces]] 的 binding 一致。
// 切换 KV 空间时修改此处，并同步 wrangler.toml 中的 binding。
export const KV_NAMESPACE = "nvidia-nim-openai-proxy-pz";

export interface Env {
  // Optional: shared upstream key. When unset, clients must supply their own.
  NIM_API_KEY?: string;
  // GATEWAY_API_KEY removed; API key comes from request header
  NIM_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
  // KV 等绑定按名称动态查找（见上方 KV_NAMESPACE）。
  [key: string]: unknown;
}

// 按 KV_NAMESPACE 名称获取 KV 绑定；未绑定时返回 undefined。
function getKv(env: Env): KVNamespace | undefined {
  const kv = env[KV_NAMESPACE];
  return typeof kv === "object" && kv !== null ? (kv as KVNamespace) : undefined;
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

// Admin 面板页面（KV 已绑定时提供）
const ADMIN_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Admin Dashboard</title></head>
<body>
<h1>Admin Dashboard</h1>
<div id="app">Loading...</div>
<script>
var TOKEN_KEY = 'admin_token';
function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
function setToken(t) { try { if (t) { localStorage.setItem(TOKEN_KEY, t); } else { localStorage.removeItem(TOKEN_KEY); } } catch (e) {} }
function show(html) { document.getElementById('app').innerHTML = html; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function api(path, options) {
  options = options || {};
  var headers = { 'Content-Type': 'application/json' };
  var token = getToken();
  if (token) { headers['X-Admin-Token'] = token; }
  return fetch(path, { method: options.method || 'GET', headers: headers, body: options.body })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    });
}
function init() {
  api('/op/api/status').then(function (r) {
    if (!r.data.initialized) { renderSetup(); return; }
    if (getToken()) { renderPanel(); return; }
    renderLogin();
  });
}
function renderSetup() {
  show('<p>首次使用，请设置管理员密码：</p>' +
       '<input id="pw" type="password" placeholder="新密码">' +
       '<button onclick="setup()">设置</button><p id="msg"></p>');
  window.setup = function () {
    var password = document.getElementById('pw').value;
    api('/op/api/set-admin-pw', { method: 'POST', body: JSON.stringify({ password: password }) }).then(function (r) {
      document.getElementById('msg').innerText = r.status === 200 ? '已设置，请登录' : ((r.data.error && r.data.error.message) || '失败');
      if (r.status === 200) { renderLogin(); }
    });
  };
}
function renderLogin() {
  show('<input id="pw" type="password" placeholder="密码">' +
       '<button onclick="login()">登录</button><p id="msg"></p>');
  window.login = function () {
    var password = document.getElementById('pw').value;
    api('/op/api/login', { method: 'POST', body: JSON.stringify({ password: password }) }).then(function (r) {
      if (r.status === 200 && r.data.token) { setToken(r.data.token); renderPanel(); }
      else { document.getElementById('msg').innerText = (r.data.error && r.data.error.message) || '登录失败'; }
    });
  };
}
function renderPanel() {
  api('/op/api/protected').then(function (r) {
    if (r.status !== 200) { setToken(null); renderLogin(); return; }
    show('<p>登录状态：' + esc(r.data.status || '') + '</p><hr>' +
         '<p>修改密码：</p>' +
         '<input id="old" type="password" placeholder="原密码">' +
         '<input id="new" type="password" placeholder="新密码">' +
         '<button onclick="changePw()">修改</button><p id="msg"></p>' +
         '<button onclick="logout()">退出登录</button>');
    window.changePw = function () {
      var oldPassword = document.getElementById('old').value;
      var newPassword = document.getElementById('new').value;
      api('/op/api/change-admin-pw', { method: 'POST', body: JSON.stringify({ oldPassword: oldPassword, newPassword: newPassword }) }).then(function (res) {
        document.getElementById('msg').innerText = res.status === 200 ? '已修改' : ((res.data.error && res.data.error.message) || '失败');
      });
    };
    window.logout = function () { setToken(null); renderLogin(); };
  });
}
init();
</script>
</body>
</html>`;

// KV 未绑定时的 Admin 提示页面
const ADMIN_UNAVAILABLE_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Admin Dashboard</title></head>
<body>
<h1>功能不可用</h1>
<p>未绑定 KV 存储，管理功能暂不可用。</p>
</body>
</html>`;

async function handleAdminApi(
  request: Request,
  url: URL,
  kv: KVNamespace,
  cors: Headers,
): Promise<Response> {
  const subpath = url.pathname.replace("/op/api", "");
  if (subpath === "/status" && request.method === "GET") {
    const existing = await kv.get("ADMIN_PASSWORD");
    return new Response(JSON.stringify({ initialized: existing !== null }), {
      headers: cors,
      status: 200,
    });
  }
  if (subpath === "/set-admin-pw" && request.method === "POST") {
    const body = (await request.json()) as { password?: string };
    const plainPwd = body.password;
    if (!plainPwd) {
      return jsonError(400, "Password required");
    }
    const hashed = await md5Hash(plainPwd);
    const existing = await kv.get("ADMIN_PASSWORD");
    if (existing) {
      return jsonError(409, "Admin password already set");
    }
    await kv.put("ADMIN_PASSWORD", hashed);
    return new Response(JSON.stringify({ status: "ok" }), { headers: cors, status: 200 });
  }
  if (subpath === "/change-admin-pw" && request.method === "POST") {
    const token = request.headers.get("X-Admin-Token");
    if (!token) return jsonError(401, "Missing admin token");
    const tokenExists = await kv.get(token);
    if (!tokenExists) return jsonError(403, "Invalid token");
    const body = (await request.json()) as { oldPassword?: string; newPassword?: string };
    const oldPwd = body.oldPassword;
    const newPwd = body.newPassword;
    if (!oldPwd || !newPwd) {
      return jsonError(400, "Old and new passwords required");
    }
    const oldHashed = await md5Hash(oldPwd);
    const stored = await kv.get("ADMIN_PASSWORD");
    if (oldHashed !== stored) return jsonError(403, "Old password incorrect");
    const newHashed = await md5Hash(newPwd);
    await kv.put("ADMIN_PASSWORD", newHashed);
    return new Response(JSON.stringify({ status: "ok" }), { headers: cors, status: 200 });
  }
  if (subpath === "/login" && request.method === "POST") {
    const body = (await request.json()) as { password?: string };
    const pwd = body.password;
    if (!pwd) return jsonError(400, "Password required");
    const hashed = await md5Hash(pwd);
    const stored = await kv.get("ADMIN_PASSWORD");
    if (hashed !== stored) return jsonError(401, "Invalid password");
    const uuid = crypto.randomUUID();
    await kv.put(uuid, "admin");
    return new Response(JSON.stringify({ token: uuid }), { headers: cors, status: 200 });
  }
  if (subpath === "/protected" && request.method === "GET") {
    const token = request.headers.get("X-Admin-Token");
    if (!token) return jsonError(401, "Missing token");
    const tokenExists = await kv.get(token);
    if (!tokenExists) return jsonError(403, "Invalid token");
    return new Response(JSON.stringify({ status: "access granted" }), {
      headers: cors,
      status: 200,
    });
  }
  return jsonError(404, "API endpoint not found");
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  }

  const cors = corsHeaders(request, env);

  // Serve admin dashboard
  if (url.pathname.startsWith("/op/admin")) {
    if (!getKv(env)) {
      return new Response(ADMIN_UNAVAILABLE_PAGE, { headers: cors, status: 503 });
    }
    return new Response(ADMIN_PAGE, { headers: cors, status: 200 });
  }

  // Admin API
  if (url.pathname.startsWith("/op/api")) {
    const kv = getKv(env);
    if (!kv) {
      return jsonError(503, "功能不可用");
    }
    return handleAdminApi(request, url, kv, cors);
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
  headers.set("Authorization", "Bearer " + nimKey);
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
