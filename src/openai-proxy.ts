import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { authError, configError, toMetaAiError } from "./errors.js";
import type { MetaAiClient } from "./metaai-client.js";
import { resolveModelAlias } from "./models.js";
import { redactSensitive } from "./redact.js";
import type { SidecarLogger } from "./sidecar.js";

export interface OpenAiProxyOptions {
  /** Loopback host (default 127.0.0.1). */
  host?: string;
  /** Fixed port; default ephemeral. */
  port?: number;
  /** Async resolver for the underlying metaai-api client. Lazy on purpose so the sidecar starts only on first call. */
  clientFactory: () => Promise<MetaAiClient>;
  logger?: SidecarLogger;
}

const DEFAULT_HOST = "127.0.0.1";

interface OpenAiChatMessage {
  role: string;
  content: unknown;
}

interface OpenAiChatRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
}

/**
 * Tiny OpenAI-compatible chat-completions proxy that fronts the metaai-api
 * sidecar.
 *
 * The proxy listens on a loopback host so that OpenClaw's model registry can
 * register a `baseUrl` like `http://127.0.0.1:<port>/v1`, and uses
 * `api: "openai-completions"` to route inference through it. We intentionally
 * implement only the minimum surface OpenClaw needs today:
 *
 *  - `POST /v1/chat/completions` (non-streaming + naive SSE pseudo-stream)
 *  - `GET /v1/models`
 *  - `GET /healthz`
 */
export class OpenAiCompatProxy {
  private readonly host: string;
  private readonly desiredPort: number;
  private readonly clientFactory: () => Promise<MetaAiClient>;
  private readonly logger: SidecarLogger;
  private server: Server | null = null;
  private bound: { host: string; port: number } | null = null;

  constructor(opts: OpenAiProxyOptions) {
    this.host = opts.host ?? DEFAULT_HOST;
    if (!isLoopbackHost(this.host)) {
      throw configError(
        `OpenAI-compat proxy refused non-loopback host '${this.host}'. Only loopback hosts are allowed.`,
      );
    }
    this.desiredPort = opts.port ?? 0;
    this.clientFactory = opts.clientFactory;
    this.logger = opts.logger ?? defaultLogger();
  }

  /** Bind the HTTP server. Idempotent — returns the cached binding on repeat calls. */
  async listen(): Promise<{ host: string; port: number; baseUrl: string }> {
    if (this.bound) return { ...this.bound, baseUrl: this.baseUrl() };
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const e = toMetaAiError(err);
        this.logger.warn(`metaai openai-proxy unhandled error: ${redactSensitive(e.message)}`);
        if (!res.headersSent) {
          writeJson(res, 500, { error: { message: e.message, type: e.kind } });
        } else {
          try { res.end(); } catch { /* ignore */ }
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.desiredPort, this.host, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw configError("OpenAI-compat proxy failed to determine bound address.");
    }
    this.bound = { host: this.host, port: address.port };
    this.logger.info(`metaai openai-proxy: listening on ${this.baseUrl()}`);
    return { ...this.bound, baseUrl: this.baseUrl() };
  }

  /** Fully qualified base URL ending in `/v1`, suitable for `ModelProviderConfig.baseUrl`. */
  baseUrl(): string {
    if (!this.bound) throw configError("OpenAI-compat proxy is not yet listening.");
    return `http://${this.bound.host}:${this.bound.port}/v1`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.bound = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    if (method === "GET" && url === "/healthz") {
      writeJson(res, 200, { status: "ok" });
      return;
    }
    if (method === "GET" && (url === "/v1/models" || url === "/models")) {
      writeJson(res, 200, {
        object: "list",
        data: [
          { id: "metaai/muse-spark", object: "model", owned_by: "metaai" },
          { id: "metaai/meta-ai", object: "model", owned_by: "metaai" },
          { id: "metaai/llama", object: "model", owned_by: "metaai" },
          { id: "metaai/llama-3", object: "model", owned_by: "metaai" },
        ],
      });
      return;
    }
    if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      await this.handleChatCompletions(req, res);
      return;
    }
    writeJson(res, 404, { error: { message: `Unknown route ${method} ${url}`, type: "not_found" } });
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: OpenAiChatRequest;
    try {
      parsed = (await readJsonBody(req)) as OpenAiChatRequest;
    } catch (err) {
      const e = toMetaAiError(err);
      writeJson(res, 400, { error: { message: e.message, type: "bad_request" } });
      return;
    }
    let payload: NormalizedChatPayload;
    try {
      payload = normalizeChatRequest(parsed);
    } catch (err) {
      const e = toMetaAiError(err);
      writeJson(res, 400, { error: { message: e.message, type: e.kind } });
      return;
    }

    let client: MetaAiClient;
    try {
      client = await this.clientFactory();
    } catch (err) {
      const e = toMetaAiError(err);
      const status = e.kind === "auth" ? 401 : 503;
      writeJson(res, status, { error: { message: e.message, type: e.kind } });
      return;
    }

    let chatResult: Awaited<ReturnType<MetaAiClient["chat"]>>;
    try {
      chatResult = await client.chat({ prompt: payload.prompt, stream: false });
    } catch (err) {
      const e = toMetaAiError(err);
      const status =
        e.status ??
        (e.kind === "auth"
          ? 401
          : e.kind === "rate_limited"
            ? 429
            : e.kind === "sidecar_timeout"
              ? 504
              : 502);
      writeJson(res, status, { error: { message: e.message, type: e.kind } });
      return;
    }

    const completionId = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const responseBody = buildOpenAiCompletion({
      id: completionId,
      created,
      modelId: payload.modelId,
      content: chatResult.message,
    });

    if (payload.stream) {
      this.writeSseStream(res, responseBody, payload.modelId, chatResult.message, completionId, created);
      return;
    }
    writeJson(res, 200, responseBody);
  }

  private writeSseStream(
    res: ServerResponse,
    finalBody: ReturnType<typeof buildOpenAiCompletion>,
    modelId: string,
    content: string,
    completionId: string,
    created: number,
  ): void {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    const writeChunk = (delta: Record<string, unknown>) => {
      const chunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    writeChunk({ role: "assistant" });
    writeChunk({ content });
    const finalChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: finalBody.usage,
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

interface NormalizedChatPayload {
  prompt: string;
  modelId: string;
  stream: boolean;
}

/**
 * Validate and flatten an OpenAI chat-completions payload into a single
 * prompt string for metaai-api. Rejects payloads that do not name a Meta AI
 * model the plugin recognises.
 */
export function normalizeChatRequest(req: OpenAiChatRequest): NormalizedChatPayload {
  if (!req || typeof req !== "object") {
    throw new Error("Request body must be a JSON object.");
  }
  const modelRaw = typeof req.model === "string" ? req.model : "";
  const resolved = resolveModelAlias(modelRaw);
  if (!resolved) {
    throw authError(
      `Unknown model '${modelRaw || "<missing>"}'. Use one of: metaai/muse-spark, metaai/meta-ai, metaai/llama, metaai/llama-3.`,
      { model: modelRaw },
    );
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new Error("Request must include a non-empty `messages` array.");
  }
  const lines: string[] = [];
  for (const messageUnknown of req.messages) {
    const message = messageUnknown as OpenAiChatMessage | null;
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "user";
    const text = extractMessageText(message.content);
    if (!text) continue;
    if (role === "system") {
      lines.push(`[System]\n${text}`);
    } else if (role === "assistant") {
      lines.push(`[Assistant]\n${text}`);
    } else if (role === "tool" || role === "function") {
      lines.push(`[Tool result]\n${text}`);
    } else {
      lines.push(`[User]\n${text}`);
    }
  }
  if (lines.length === 0) {
    throw new Error("Request `messages` did not contain any non-empty text content.");
  }
  return {
    prompt: lines.join("\n\n"),
    modelId: modelRaw || "metaai/muse-spark",
    stream: req.stream === true,
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const obj = part as { type?: unknown; text?: unknown };
      const type = typeof obj.type === "string" ? obj.type : "text";
      if (type === "text" && typeof obj.text === "string") {
        parts.push(obj.text);
      }
      // image_url / input_audio etc. are intentionally ignored — Meta AI's
      // chat sidecar is text-only at this MVP layer.
    }
    return parts.join("\n").trim();
  }
  return "";
}

/**
 * Build a minimal OpenAI Chat Completions response. Token counts are
 * estimates; OpenClaw uses them for accounting but Meta AI does not return
 * authoritative counts.
 */
export function buildOpenAiCompletion(params: {
  id: string;
  created: number;
  modelId: string;
  content: string;
}): {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
} {
  const completionTokens = estimateTokens(params.content);
  return {
    id: params.id,
    object: "chat.completion",
    created: params.created,
    model: params.modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: params.content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  };
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough heuristic: 4 chars per token. Good enough for accounting headers.
  return Math.max(1, Math.ceil(text.length / 4));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = 1 * 1024 * 1024; // 1 MiB cap — chat payloads should be tiny
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limit) {
      throw new Error("Chat completion payload exceeds 1 MiB cap.");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Chat completion payload is not valid JSON: ${(err as Error).message}`,
    );
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.toLowerCase() === "localhost"
  );
}

function defaultLogger(): SidecarLogger {
  /* eslint-disable no-console */
  return {
    info: (m) => console.log(`[metaai-proxy] ${m}`),
    warn: (m) => console.warn(`[metaai-proxy] ${m}`),
    error: (m) => console.error(`[metaai-proxy] ${m}`),
  };
  /* eslint-enable no-console */
}
