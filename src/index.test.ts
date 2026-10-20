import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "./index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  // Proxy routes never touch the KV bindings; stubs keep the type honest.
  const kv = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  } as unknown as KVNamespace;
  return {
    ADMIN_KV: kv,
    ADMIN_TEMP_KV: kv,
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

  it("returns 503 for admin routes when KV storage is not configured", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/op/api/protected"),
      makeEnv({ ADMIN_KV: undefined }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: "Admin storage not configured" },
    });
  });

  it("answers health checks without revealing credential configuration", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/health"),
      makeEnv({ NIM_API_KEY: "nim-secret" }),
    );

    expect(await response.json()).toEqual({ status: "ok" });
  });
});
