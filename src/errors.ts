import { redactSensitive } from "./redact.js";

/**
 * Stable error categories surfaced to the OpenClaw runtime. These categories
 * map to retry-ability and to user-facing messaging in command handlers.
 */
export type MetaAiErrorKind =
  | "config"
  | "auth"
  | "sidecar_unavailable"
  | "sidecar_timeout"
  | "rate_limited"
  | "upstream"
  | "transport"
  | "internal";

const RETRYABLE: ReadonlySet<MetaAiErrorKind> = new Set([
  "sidecar_timeout",
  "rate_limited",
  "transport",
]);

export interface MetaAiErrorOptions {
  kind: MetaAiErrorKind;
  message: string;
  status?: number;
  cause?: unknown;
  details?: Record<string, unknown>;
}

/**
 * Typed error class with auto-redaction. Construct via the factory helpers
 * below; {@link MetaAiError.message} is always pre-redacted so it is safe to
 * forward to OpenClaw's logger or return to a user.
 */
export class MetaAiError extends Error {
  readonly kind: MetaAiErrorKind;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(opts: MetaAiErrorOptions) {
    super(redactSensitive(opts.message));
    this.name = "MetaAiError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.details = opts.details;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  isRetryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export function configError(message: string, details?: Record<string, unknown>): MetaAiError {
  return new MetaAiError({ kind: "config", message, details });
}

export function authError(message: string, details?: Record<string, unknown>): MetaAiError {
  return new MetaAiError({ kind: "auth", message, details });
}

export function sidecarUnavailable(message: string, cause?: unknown): MetaAiError {
  return new MetaAiError({ kind: "sidecar_unavailable", message, cause });
}

export function sidecarTimeout(message: string, cause?: unknown): MetaAiError {
  return new MetaAiError({ kind: "sidecar_timeout", message, cause });
}

export function rateLimited(message: string, status?: number): MetaAiError {
  return new MetaAiError({ kind: "rate_limited", message, status });
}

export function upstreamError(message: string, status?: number, cause?: unknown): MetaAiError {
  return new MetaAiError({ kind: "upstream", message, status, cause });
}

export function transportError(message: string, cause?: unknown): MetaAiError {
  return new MetaAiError({ kind: "transport", message, cause });
}

export function internalError(message: string, cause?: unknown): MetaAiError {
  return new MetaAiError({ kind: "internal", message, cause });
}

/**
 * Convert any thrown value into a {@link MetaAiError} with redacted message.
 * Pass-through if the value is already a MetaAiError.
 */
export function toMetaAiError(err: unknown, fallbackKind: MetaAiErrorKind = "internal"): MetaAiError {
  if (err instanceof MetaAiError) return err;
  if (err instanceof Error) {
    return new MetaAiError({ kind: fallbackKind, message: err.message, cause: err });
  }
  return new MetaAiError({ kind: fallbackKind, message: String(err) });
}
