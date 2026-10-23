export interface Env {
  NIM_API_KEY?: string;
  NIM_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
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
    if (request.method !== "GET") {
      return jsonError(405, "Method not allowed");
    }
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  }

  const methods = ALLOWED_ROUTES.get(url.pathname);
  if (!methods) {
    return jsonError(404, "Endpoint not found");
  }

  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") {
    if (env.ALLOWED_ORIGIN && request.headers.get("Origin") !== env.ALLOWED_ORIGIN) {
      return jsonError(403, "Origin not allowed");
    }
    return new Response(null, { status: 204, headers: cors });
  }

  if (!methods.includes(request.method)) {
    return jsonError(405, "Method not allowed");
  }

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
