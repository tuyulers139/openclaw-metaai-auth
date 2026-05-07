import { describe, expect, it, vi } from "vitest";

import { MetaAiError } from "../errors.js";
import { MetaAiClient } from "../metaai-client.js";

function makeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    return impl(url, init ?? {});
  }) as unknown as typeof globalThis.fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MetaAiClient", () => {
  it("refuses non-loopback baseUrls", () => {
    expect(() => new MetaAiClient({ baseUrl: "http://example.com" })).toThrow();
    expect(() => new MetaAiClient({ baseUrl: "http://10.0.0.1" })).toThrow();
  });

  it("accepts 127.0.0.1, ::1, and localhost", () => {
    const fetchImpl = makeFetch(async () => jsonResponse(200, { status: "ok" }));
    expect(() => new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl })).not.toThrow();
    expect(() => new MetaAiClient({ baseUrl: "http://localhost:1234", fetchImpl })).not.toThrow();
  });

  it("calls /healthz and parses the status field", async () => {
    const fetchImpl = makeFetch(async (url) => {
      expect(url.endsWith("/healthz")).toBe(true);
      return jsonResponse(200, { status: "ok", cookies_configured: true });
    });
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    const result = await client.health(1_000);
    expect(result.status).toBe("ok");
    expect(result.cookiesConfigured).toBe(true);
  });

  it("posts /chat with a JSON body and returns the message field", async () => {
    let captured: { body?: string; method?: string; url?: string } = {};
    const fetchImpl = makeFetch(async (url, init) => {
      captured = { url, method: init.method, body: init.body as string };
      return jsonResponse(200, { message: "hi from meta" });
    });
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    const result = await client.chat({ prompt: "hello" });
    expect(captured.method).toBe("POST");
    expect(captured.url?.endsWith("/chat")).toBe(true);
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ prompt: "hello", stream: false });
    expect(result.message).toBe("hi from meta");
  });

  it("falls back to alternative response keys", async () => {
    const fetchImpl = makeFetch(async () => jsonResponse(200, { text: "hi" }));
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    const result = await client.chat({ prompt: "hello" });
    expect(result.message).toBe("hi");
  });

  it("throws upstreamError for empty chat payloads", async () => {
    const fetchImpl = makeFetch(async () => jsonResponse(200, {}));
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    await expect(client.chat({ prompt: "x" })).rejects.toThrow(MetaAiError);
  });

  it("translates 429 into rate_limited", async () => {
    const fetchImpl = makeFetch(async () => jsonResponse(429, { error: "slow down" }));
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    await expect(client.chat({ prompt: "x" })).rejects.toMatchObject({ kind: "rate_limited", status: 429 });
  });

  it("translates 5xx into upstream errors with the status preserved", async () => {
    const fetchImpl = makeFetch(async () => jsonResponse(503, { error: "boom" }));
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    await expect(client.chat({ prompt: "x" })).rejects.toMatchObject({ kind: "upstream", status: 503 });
  });

  it("redacts cookie values in upstream error messages", async () => {
    const fetchImpl = makeFetch(async () => jsonResponse(500, "datr=BAD-VALUE-12345; ecto_1_sess=SESSION"));
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    try {
      await client.chat({ prompt: "x" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("BAD-VALUE-12345");
      expect((err as Error).message).not.toContain("SESSION");
    }
  });

  it("translates AbortError into sidecar_timeout", async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal as AbortSignal | null;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl, timeoutMs: 50 });
    await expect(client.chat({ prompt: "x" })).rejects.toMatchObject({ kind: "sidecar_timeout" });
  });

  it("calls /image and extracts a urls array", async () => {
    const fetchImpl = makeFetch(async (url, init) => {
      expect(url.endsWith("/image")).toBe(true);
      expect(JSON.parse(init.body as string)).toEqual({ prompt: "a cat", orientation: "square" });
      return jsonResponse(200, { urls: ["https://meta/cat.png"] });
    });
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    const result = await client.image({ prompt: "a cat", orientation: "square" });
    expect(result.urls).toEqual(["https://meta/cat.png"]);
  });

  it("calls /video and extracts the url field", async () => {
    const fetchImpl = makeFetch(async (url, init) => {
      expect(url.endsWith("/video")).toBe(true);
      expect(JSON.parse(init.body as string)).toEqual({ prompt: "a wave", duration_seconds: 5 });
      return jsonResponse(200, { url: "https://meta/wave.mp4" });
    });
    const client = new MetaAiClient({ baseUrl: "http://127.0.0.1:1234", fetchImpl });
    const result = await client.video({ prompt: "a wave", durationSeconds: 5 });
    expect(result.url).toBe("https://meta/wave.mp4");
  });
});
