import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./index";

const env = {
  GATEWAY_API_KEY: "client-secret",
  NIM_API_KEY: "nim-secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NVIDIA NIM OpenAI-compatible proxy", () => {
  it("requires the gateway key and does not contact NIM when unauthorized", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/v1/models"),
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { message: "Invalid or missing API key" },
    });
    expect(upstream).not.toHaveBeenCalled();
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
      env,
    );

    const [target, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions?trace=1",
    );
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer nim-secret");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });

  it("does not expose arbitrary upstream paths", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(
      new Request("https://proxy.example/anything"),
      env,
    );

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers health checks without revealing credential configuration", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/health"),
      env,
    );

    expect(await response.json()).toEqual({ status: "ok" });
  });
});
