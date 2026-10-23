import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "./index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ...overrides };
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
      makeEnv({ NIM_API_KEY: "configured-test-key" }),
    );

    expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer configured-test-key",
    );
  });

  it("forwards chat requests and streams the upstream response", async () => {
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
          Authorization: "Bearer client-test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "meta/llama-3.1-8b-instruct", stream: true }),
      }),
      makeEnv({ NIM_API_KEY: "configured-test-key" }),
    );

    const [target, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions?trace=1",
    );
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer configured-test-key",
    );
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });

  it("preserves upstream error statuses, headers, and response bodies", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { "Content-Type": "application/json", "X-Request-Id": "upstream-id" },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/v1/models"),
      makeEnv({ NIM_API_KEY: "configured-test-key" }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("X-Request-Id")).toBe("upstream-id");
    expect(await response.text()).toBe('{"error":"rate limited"}');
  });

  it.each(["/v1/completions", "/v1/embeddings"])(
    "forwards supported endpoint %s",
    async (path) => {
      const upstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", upstream);

      const response = await handleRequest(
        new Request(`https://proxy.example${path}`, {
          method: "POST",
          headers: {
            Authorization: "Bearer client-test-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "test-model" }),
        }),
        makeEnv(),
      );

      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledOnce();
      const [target, init] = upstream.mock.calls[0] as [URL, RequestInit];
      expect(target.toString()).toBe(`https://integrate.api.nvidia.com${path}`);
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer client-test-key",
      );
    },
  );

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

  it("forwards a configured NIM_BASE_URL while keeping the upstream origin fixed", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", upstream);

    await handleRequest(
      new Request("https://proxy.example/v1/models"),
      makeEnv({
        NIM_API_KEY: "configured-test-key",
        NIM_BASE_URL: "https://nim.example",
      }),
    );

    const [target] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("https://nim.example/v1/models");
  });

  it("rejects an invalid upstream configuration without making a request", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/v1/models"),
      makeEnv({
        NIM_API_KEY: "configured-test-key",
        NIM_BASE_URL: "https://nim.example/custom-path",
      }),
    );

    expect(response.status).toBe(500);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "/anything",
    "/op/admin",
    "/op/admin/anything",
    "/op/api/status",
    "/op/api/protected",
  ])("does not proxy unsupported path %s", async (path) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request(`https://proxy.example${path}`),
      makeEnv({ NIM_API_KEY: "configured-test-key" }),
    );

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/v1/models"],
    ["GET", "/v1/chat/completions"],
    ["POST", "/health"],
  ])("rejects unsupported method %s %s", async (method, path) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request(`https://proxy.example${path}`, { method }),
      makeEnv({ NIM_API_KEY: "configured-test-key" }),
    );

    expect(response.status).toBe(405);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers health checks without revealing credential configuration", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/health"),
      makeEnv({ NIM_API_KEY: "configured-test-key" }),
    );

    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });
});
