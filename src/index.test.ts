import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, KV_NAMESPACE, type Env } from "./index";

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    [KV_NAMESPACE]: makeKv(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NVIDIA NIM OpenAI-compatible proxy", () => {
  it("uses the configured NIM_API_KEY without requiring client auth", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: "list", data: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/v1/models"),
      makeEnv({ NIM_API_KEY: "nim-secret" }),
    );

    expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer nim-secret");
  });

  it("forwards authorized chat requests and streams the upstream response", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const upstream = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/v1/chat/completions?trace=1", {
        method: "POST",
        headers: {
          Authorization: "Bearer client-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "meta/llama-3.1-8b-instruct", stream: true }),
      }),
      makeEnv({ NIM_API_KEY: "nim-secret" }),
    );

    const [target, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions?trace=1",
    );
    // The client-supplied Authorization is replaced by the configured NIM key.
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer nim-secret");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });

  it("rejects requests without a usable key when NIM_API_KEY is not configured", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const missing = await handleRequest(
      new Request("https://proxy.example/v1/models"),
      makeEnv(),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: { message: "Missing API key" },
    });

    const malformed = await handleRequest(
      new Request("https://proxy.example/v1/models", {
        headers: { Authorization: "Basic not-a-bearer-token" },
      }),
      makeEnv(),
    );
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toMatchObject({
      error: { message: "Invalid API key format" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards the client-supplied key when NIM_API_KEY is not configured", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", upstream);

    await handleRequest(
      new Request("https://proxy.example/v1/models", {
        headers: { Authorization: "Bearer client-nim-key" },
      }),
      makeEnv(),
    );

    const [target, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer client-nim-key");
  });

  it("does not expose arbitrary upstream paths", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/anything"),
      makeEnv({ NIM_API_KEY: "nim-secret" }),
    );

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers health checks without revealing credential configuration", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/health"),
      makeEnv({ NIM_API_KEY: "nim-secret" }),
    );

    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("admin panel", () => {
  it("returns 503 for admin API routes when the KV binding is missing", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/op/api/protected"),
      makeEnv({ [KV_NAMESPACE]: undefined }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: "功能不可用" },
    });
  });

  it("shows an unavailable page for /op/admin when the KV binding is missing", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/op/admin"),
      makeEnv({ [KV_NAMESPACE]: undefined }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("功能不可用");
  });

  it("serves the dashboard page when the KV binding exists", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/op/admin"),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Admin Dashboard");
    expect(html).toContain("/op/api/login");
    expect(html).toContain("/op/api/status");
  });

  it("reports whether the admin password is initialized", async () => {
    const fresh = await handleRequest(
      new Request("https://proxy.example/op/api/status"),
      makeEnv(),
    );
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ initialized: false });

    const env = makeEnv();
    await (env[KV_NAMESPACE] as KVNamespace).put("ADMIN_PASSWORD", "hash");
    const ready = await handleRequest(
      new Request("https://proxy.example/op/api/status"),
      env,
    );
    expect(await ready.json()).toEqual({ initialized: true });
  });

  it("rejects admin API calls with an invalid or missing token", async () => {
    const noToken = await handleRequest(
      new Request("https://proxy.example/op/api/protected"),
      makeEnv(),
    );
    expect(noToken.status).toBe(401);

    const badToken = await handleRequest(
      new Request("https://proxy.example/op/api/protected", {
        headers: { "X-Admin-Token": "not-a-real-token" },
      }),
      makeEnv(),
    );
    expect(badToken.status).toBe(403);
  });
});
