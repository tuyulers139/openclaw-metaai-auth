import { afterEach, describe, expect, it, vi } from "vitest";

import { MetaAiError, sidecarTimeout } from "../errors.js";
import type { ChatRequestPayload, MetaAiClient } from "../metaai-client.js";
import {
  buildOpenAiCompletion,
  normalizeChatRequest,
  OpenAiCompatProxy,
} from "../openai-proxy.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeClient(reply: { message: string } | { error: MetaAiError }): MetaAiClient {
  return {
    chat: vi.fn(async (payload: ChatRequestPayload) => {
      if ("error" in reply) throw reply.error;
      expect(payload.stream).toBe(false);
      return { message: reply.message };
    }),
  } as unknown as MetaAiClient;
}

describe("normalizeChatRequest", () => {
  it("rejects non-object payloads", () => {
    expect(() => normalizeChatRequest(null as unknown as Record<string, unknown>)).toThrow();
  });

  it("rejects unknown model ids", () => {
    expect(() =>
      normalizeChatRequest({
        model: "openai/gpt-4",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toThrow(MetaAiError);
  });

  it("accepts each registered alias", () => {
    for (const m of ["metaai/muse-spark", "metaai/meta-ai", "metaai/llama", "metaai/llama-3"]) {
      const out = normalizeChatRequest({
        model: m,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(out.modelId).toBe(m);
    }
  });

  it("flattens multi-turn messages into a labelled prompt", () => {
    const out = normalizeChatRequest({
      model: "metaai/muse-spark",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "what is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "and 3+3?" },
      ],
    });
    expect(out.prompt).toContain("[System]");
    expect(out.prompt).toContain("[User]");
    expect(out.prompt).toContain("[Assistant]");
    expect(out.prompt).toContain("be terse");
    expect(out.prompt).toContain("what is 2+2?");
    expect(out.prompt).toContain("and 3+3?");
  });

  it("extracts text parts from array content and ignores image_url parts", () => {
    const out = normalizeChatRequest({
      model: "metaai/muse-spark",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: "data:..." } },
          ],
        },
      ],
    });
    expect(out.prompt).toContain("describe this");
    expect(out.prompt).not.toContain("data:");
  });

  it("propagates the stream flag", () => {
    const out = normalizeChatRequest({
      model: "metaai/muse-spark",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(out.stream).toBe(true);
  });
});

describe("buildOpenAiCompletion", () => {
  it("matches the OpenAI Chat Completions response envelope", () => {
    const body = buildOpenAiCompletion({
      id: "chatcmpl_x",
      created: 1700000000,
      modelId: "metaai/muse-spark",
      content: "hi",
    });
    expect(body.object).toBe("chat.completion");
    expect(body.choices).toHaveLength(1);
    const choice = body.choices[0];
    if (!choice) throw new Error("expected at least one choice");
    expect(choice.message.role).toBe("assistant");
    expect(choice.message.content).toBe("hi");
    expect(choice.finish_reason).toBe("stop");
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
  });
});

describe("OpenAiCompatProxy", () => {
  let proxy: OpenAiCompatProxy | null = null;

  afterEach(async () => {
    if (proxy) {
      await proxy.close();
      proxy = null;
    }
  });

  it("rejects non-loopback hosts at construction", () => {
    expect(
      () =>
        new OpenAiCompatProxy({
          host: "0.0.0.0",
          clientFactory: async () => fakeClient({ message: "x" }),
        }),
    ).toThrow();
  });

  it("returns 404 for unknown routes", async () => {
    proxy = new OpenAiCompatProxy({
      clientFactory: async () => fakeClient({ message: "x" }),
      logger: silentLogger,
    });
    const { baseUrl } = await proxy.listen();
    const res = await fetch(`${baseUrl.replace("/v1", "")}/v1/unknown`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("serves /healthz with status ok", async () => {
    proxy = new OpenAiCompatProxy({
      clientFactory: async () => fakeClient({ message: "x" }),
      logger: silentLogger,
    });
    const { baseUrl } = await proxy.listen();
    const res = await fetch(`${baseUrl.replace("/v1", "")}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("lists known model ids on /v1/models", async () => {
    proxy = new OpenAiCompatProxy({
      clientFactory: async () => fakeClient({ message: "x" }),
      logger: silentLogger,
    });
    const { baseUrl } = await proxy.listen();
    const res = await fetch(`${baseUrl}/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        "metaai/muse-spark",
        "metaai/meta-ai",
        "metaai/llama",
        "metaai/llama-3",
      ]),
    );
  });

  it("translates a chat completion through the metaai client", async () => {
    const client = fakeClient({ message: "Pong from Meta" });
    proxy = new OpenAiCompatProxy({
      clientFactory: async () => client,
      logger: silentLogger,
    });
    const { baseUrl } = await proxy.listen();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "metaai/llama",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const choice = body.choices[0];
    if (!choice) throw new Error("expected at least one choice");
    expect(choice.message.content).toBe("Pong from Meta");
    expect(client.chat).toHaveBeenCalled();
  });

  it("returns 401 when the request names an unknown model", async () => {
    proxy = new OpenAiCompatProxy({
      clientFactory: async () => fakeClient({ message: "x" }),
      logger: silentLogger,
    });
    const { baseUrl } = await proxy.listen();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 504 when the underlying client times out", async () => {
    proxy = new OpenAiCompatProxy({
      clientFactory: async () => fakeClient({ error: sidecarTimeout("timed out") }),
      logger: silentLogger,
    });
    const { baseUrl } = await proxy.listen();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "metaai/muse-spark",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.status).toBe(504);
  });

  it("returns SSE chunks ending with [DONE] when stream=true", async () => {
    proxy = new OpenAiCompatProxy({
      clientFactory: async () => fakeClient({ message: "Streamed Pong" }),
      logger: silentLogger,
    });
    const { baseUrl } = await proxy.listen();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "metaai/muse-spark",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("Streamed Pong");
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
