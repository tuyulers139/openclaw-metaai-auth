import { configError } from "./errors.js";

/**
 * Resolved plugin configuration after merging defaults, environment, and the
 * raw `pluginConfig` object provided by OpenClaw.
 */
export interface ResolvedPluginConfig {
  sidecar: {
    pythonBin: string;
    host: string;
    port: number | undefined;
    openAiProxyPort: number | undefined;
    idleShutdownMs: number;
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    extraEnv: Readonly<Record<string, string>>;
  };
  defaultModel: string;
  allowedModels: readonly string[] | undefined;
}

const DEFAULTS = {
  pythonBin: "python3",
  host: "127.0.0.1",
  idleShutdownMs: 5 * 60_000,
  startupTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
  defaultModel: "metaai/muse-spark",
} as const;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Validate and normalise the raw `pluginConfig` object surfaced by
 * `OpenClawPluginApi.pluginConfig`. Throws a typed config error on bad input.
 */
export function resolvePluginConfig(raw: unknown): ResolvedPluginConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sidecarRaw = (cfg.sidecar && typeof cfg.sidecar === "object" ? cfg.sidecar : {}) as Record<string, unknown>;

  const host = stringOrDefault(sidecarRaw.host, DEFAULTS.host);
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw configError(
      `metaai plugin refuses non-loopback sidecar.host '${host}'. Use 127.0.0.1, ::1, or localhost.`,
    );
  }

  const port = optionalPort(sidecarRaw.port, "sidecar.port");
  const openAiProxyPort = optionalPort(sidecarRaw.openAiProxyPort, "sidecar.openAiProxyPort");
  const idleShutdownMs = nonNegativeNumber(sidecarRaw.idleShutdownMs, DEFAULTS.idleShutdownMs, "sidecar.idleShutdownMs");
  const startupTimeoutMs = positiveNumber(sidecarRaw.startupTimeoutMs, DEFAULTS.startupTimeoutMs, "sidecar.startupTimeoutMs");
  const requestTimeoutMs = positiveNumber(sidecarRaw.requestTimeoutMs, DEFAULTS.requestTimeoutMs, "sidecar.requestTimeoutMs");
  const extraEnv = stringRecord(sidecarRaw.extraEnv, "sidecar.extraEnv");

  const defaultModel = stringOrDefault(cfg.defaultModel, DEFAULTS.defaultModel);
  const allowedModels = optionalStringArray(cfg.allowedModels, "allowedModels");

  return {
    sidecar: {
      pythonBin: stringOrDefault(sidecarRaw.pythonBin, DEFAULTS.pythonBin),
      host,
      port,
      openAiProxyPort,
      idleShutdownMs,
      startupTimeoutMs,
      requestTimeoutMs,
      extraEnv,
    },
    defaultModel,
    allowedModels,
  };
}

function stringOrDefault(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallback;
}

function optionalPort(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw configError(`${label} must be an integer port in [1, 65535].`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw configError(`${label} must be a non-negative number.`);
  }
  return value;
}

function positiveNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw configError(`${label} must be a positive number.`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw configError(`${label} must be an array of strings.`);
  }
  return value as string[];
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) {
    throw configError(`${label} must be an object of string values.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw configError(`${label}.${k} must be a string.`);
    }
    out[k] = v;
  }
  return Object.freeze(out);
}
