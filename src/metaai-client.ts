import {
  rateLimited,
  sidecarTimeout,
  sidecarUnavailable,
  toMetaAiError,
  upstreamError,
} from "./errors.js";
import { redactSensitive } from "./redact.js";

/**
 * Subset of the metaai-api FastAPI surface that the plugin uses today.
 * The sidecar binds to 127.0.0.1 only; callers must supply a `baseUrl` that
 * uses a loopback host.
 */
export interface MetaAiClientOptions {
  /** Base URL of the metaai-api sidecar, e.g. `http://127.0.0.1:8742`. */
  baseUrl: string;
  /** Default per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Optional `fetch` override (used by tests). Defaults to the global fetch.
   */
  fetchImpl?: typeof globalThis.fetch;
}

export interface ChatRequestPayload {
  prompt: string;
  /** Whether to ask the upstream sidecar to stream. The plugin currently does not consume streams. */
  stream?: boolean;
  /** Free-form Meta AI mode label; sidecar passes this to the underlying SDK. */
  mode?: string;
}

export interface ChatResponsePayload {
  message: string;
  raw?: unknown;
}

export interface ImageRequestPayload {
  prompt: string;
  orientation?: "square" | "portrait" | "landscape";
}

export interface ImageResponsePayload {
  urls: string[];
  raw?: unknown;
}

export interface VideoRequestPayload {
  prompt: string;
  durationSeconds?: number;
}

export interface VideoResponsePayload {
  url: string;
  raw?: unknown;
}

export interface HealthPayload {
  status: "ok" | string;
  cookiesConfigured?: boolean;
  raw?: unknown;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Loopback-only HTTP client for the metaai-api FastAPI sidecar.
 *
 * The client refuses any non-loopback `baseUrl`, never echoes cookie values,
 * and converts non-2xx upstream responses into typed {@link MetaAiError}s
 * with redacted messages.
 */
export class MetaAiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: MetaAiClientOptions) {
    const url = new URL(opts.baseUrl);
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(
        "MetaAiClient refuses non-loopback baseUrl; sidecars must bind to 127.0.0.1.",
      );
    }
    // Strip trailing slash for predictable join semantics.
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async health(timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS): Promise<HealthPayload> {
    const data = await this.request<Record<string, unknown>>("GET", "/healthz", undefined, timeoutMs);
    const status = typeof data.status === "string" ? data.status : "ok";
    const cookiesConfigured =
      typeof data.cookies_configured === "boolean"
        ? data.cookies_configured
        : typeof data.cookiesConfigured === "boolean"
          ? data.cookiesConfigured
          : undefined;
    return { status, cookiesConfigured, raw: data };
  }

  async chat(payload: ChatRequestPayload, timeoutMs?: number): Promise<ChatResponsePayload> {
    const body = {
      prompt: payload.prompt,
      stream: payload.stream === true,
      ...(payload.mode ? { mode: payload.mode } : {}),
    };
    const data = await this.request<Record<string, unknown>>("POST", "/chat", body, timeoutMs);
    const message = pickFirstString(data, ["message", "text", "response", "completion"]);
    if (!message) {
      throw upstreamError("Meta AI sidecar returned an empty chat response.");
    }
    return { message, raw: data };
  }

  async image(payload: ImageRequestPayload, timeoutMs?: number): Promise<ImageResponsePayload> {
    const body = {
      prompt: payload.prompt,
      ...(payload.orientation ? { orientation: payload.orientation } : {}),
    };
    const data = await this.request<Record<string, unknown>>(
      "POST",
      "/image",
      body,
      timeoutMs ?? Math.max(this.timeoutMs, 180_000),
    );
    const urls = pickStringArray(data, ["urls", "images", "image_urls"]);
    if (urls.length === 0) {
      throw upstreamError("Meta AI sidecar returned no image URLs.");
    }
    return { urls, raw: data };
  }

  async video(payload: VideoRequestPayload, timeoutMs?: number): Promise<VideoResponsePayload> {
    const body = {
      prompt: payload.prompt,
      ...(payload.durationSeconds ? { duration_seconds: payload.durationSeconds } : {}),
    };
    const data = await this.request<Record<string, unknown>>(
      "POST",
      "/video",
      body,
      timeoutMs ?? Math.max(this.timeoutMs, 240_000),
    );
    const url = pickFirstString(data, ["url", "video_url"]);
    if (!url) {
      throw upstreamError("Meta AI sidecar returned no video URL.");
    }
    return { url, raw: data };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || /abort/i.test(err.message));
      if (isAbort) {
        throw sidecarTimeout(`Meta AI sidecar timed out after ${timeoutMs ?? this.timeoutMs}ms.`, err);
      }
      throw sidecarUnavailable(
        `Meta AI sidecar transport error: ${redactSensitive(toMetaAiError(err).message)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw rateLimited("Meta AI sidecar reported rate limit.", 429);
    }
    if (response.status >= 500) {
      const text = await safeReadText(response);
      throw upstreamError(
        `Meta AI sidecar error ${response.status}: ${redactSensitive(text)}`,
        response.status,
      );
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      throw upstreamError(
        `Meta AI sidecar returned ${response.status}: ${redactSensitive(text)}`,
        response.status,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw upstreamError("Meta AI sidecar returned a non-JSON response.", undefined, err);
    }
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false;
  return (
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.toLowerCase() === "localhost"
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2_000);
  } catch {
    return "";
  }
}

function pickFirstString(data: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function pickStringArray(data: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      const strings = value.filter((v): v is string => typeof v === "string" && v.length > 0);
      if (strings.length > 0) return strings;
    } else if (typeof value === "string" && value.length > 0) {
      return [value];
    }
  }
  return [];
}
