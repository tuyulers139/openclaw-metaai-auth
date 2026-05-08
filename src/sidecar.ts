import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { buildSidecarCookieEnv, readCookiesFromEnv } from "./cookies.js";
import {
  configError,
  internalError,
  sidecarTimeout,
  sidecarUnavailable,
  toMetaAiError,
} from "./errors.js";
import { MetaAiClient } from "./metaai-client.js";
import { redactSensitive } from "./redact.js";

/**
 * Logger interface compatible with `OpenClawPluginApi.logger`. Tests pass a
 * stub instead of pulling in the OpenClaw runtime.
 */
export interface SidecarLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

export interface SidecarOptions {
  /** Python interpreter (default `python3`). */
  pythonBin?: string;
  /** Loopback host the sidecar binds to (default `127.0.0.1`). */
  host?: string;
  /** Fixed port; if omitted, a random free port is reserved at startup. */
  port?: number;
  /** Idle shutdown delay in ms; 0 disables. Default: 5 minutes. */
  idleShutdownMs?: number;
  /** Timeout in ms for the initial healthz probe. Default: 30 seconds. */
  startupTimeoutMs?: number;
  /** Per-request timeout for the `MetaAiClient` returned by {@link ensureRunning}. */
  requestTimeoutMs?: number;
  /** Optional extra env to pass to the sidecar. */
  extraEnv?: Readonly<Record<string, string>>;
  /** Logger surface. */
  logger?: SidecarLogger;
  /** Process-spawn override for tests. */
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /** Optional override of `process.env` for tests. */
  envSource?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PYTHON = "python3";
const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 250;

const SIDECAR_MODULE = "metaai_api.api_server";

/**
 * Manages the lifecycle of the metaai-api FastAPI sidecar.
 *
 * Guarantees:
 *  - the child process is bound to a loopback host (default 127.0.0.1)
 *  - the parent's environment is filtered to a minimal allowlist plus the
 *    required cookie env-vars; other ambient secrets are NOT inherited
 *  - the sidecar is started lazily on first {@link ensureRunning} and shut
 *    down after {@link SidecarOptions.idleShutdownMs} of inactivity
 *  - cookie values are never logged; spawn details and stdout/stderr are
 *    redacted before being forwarded to the logger
 */
export class MetaAiSidecar {
  private readonly host: string;
  private readonly pythonBin: string;
  private readonly idleShutdownMs: number;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly extraEnv: Readonly<Record<string, string>>;
  private readonly logger: SidecarLogger;
  private readonly spawnImpl: SidecarOptions["spawnImpl"];
  private readonly envSource: Readonly<Record<string, string | undefined>>;
  private readonly pinnedPort: number | undefined;

  private child: ChildProcess | null = null;
  private port: number | null = null;
  private client: MetaAiClient | null = null;
  private starting: Promise<MetaAiClient> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: SidecarOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    if (!isLoopbackHost(this.host)) {
      throw configError(
        `Meta AI sidecar refused non-loopback host '${this.host}'. Only 127.0.0.1, ::1, or localhost are allowed.`,
      );
    }
    this.pythonBin = opts.pythonBin ?? DEFAULT_PYTHON;
    this.idleShutdownMs = opts.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.extraEnv = opts.extraEnv ?? {};
    this.logger = opts.logger ?? consoleLogger();
    this.spawnImpl = opts.spawnImpl;
    this.envSource = opts.envSource ?? process.env;
    this.pinnedPort = opts.port;
  }

  /** Returns true while the sidecar process is alive. */
  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Resolved base URL once the sidecar has started, or `null` before then. */
  baseUrl(): string | null {
    if (this.port === null) return null;
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Ensure the sidecar is running and return a {@link MetaAiClient} for it.
   * Concurrent callers share a single startup promise.
   */
  async ensureRunning(): Promise<MetaAiClient> {
    if (this.stopped) {
      throw configError("Meta AI sidecar has been stopped and cannot be restarted on this instance.");
    }
    if (this.client && this.isRunning()) {
      this.scheduleIdleShutdown();
      return this.client;
    }
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Run a single health probe against the sidecar without touching idle
   * shutdown semantics. Returns `false` if the sidecar is not yet started or
   * the probe fails.
   */
  async health(): Promise<boolean> {
    if (!this.client || !this.isRunning()) return false;
    try {
      const result = await this.client.health(2_000);
      return result.status === "ok";
    } catch {
      return false;
    }
  }

  /** Stop the sidecar and tear down all timers. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.client = null;
    this.port = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch (err) {
      this.logger.warn(`metaai sidecar SIGTERM failed: ${redactSensitive(toMetaAiError(err).message)}`);
    }
    // Best-effort: give the process a brief grace period before SIGKILL.
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(2_000),
    ]);
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — child already exited
      }
    }
  }

  private async start(): Promise<MetaAiClient> {
    const cookies = readCookiesFromEnv(this.envSource);
    const port = this.pinnedPort ?? (await findFreePort(this.host));
    const env = this.buildSpawnEnv(cookies);
    const args = [
      "-m",
      "uvicorn",
      `${SIDECAR_MODULE}:app`,
      "--host",
      this.host,
      "--port",
      String(port),
      "--log-level",
      "warning",
    ];
    this.logger.info(
      `metaai sidecar: starting (host=${this.host} port=${port} python=${this.pythonBin})`,
    );

    const spawnFn = this.spawnImpl ?? spawn;
    const child = spawnFn(this.pythonBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Detach=false: keep child tied to this process group for graceful shutdown.
    });

    child.on("error", (err) => {
      this.logger.error(
        `metaai sidecar spawn failed: ${redactSensitive(toMetaAiError(err).message)}`,
      );
    });
    child.on("exit", (code, signal) => {
      this.logger.info(`metaai sidecar exited (code=${code} signal=${signal ?? "none"})`);
      if (this.child === child) {
        this.child = null;
        this.client = null;
        this.port = null;
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.logger.debug?.(`metaai sidecar stdout: ${redactSensitive(chunk.toString().trim())}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // uvicorn writes startup info to stderr; downgrade to debug for normal lines.
      const line = redactSensitive(chunk.toString().trim());
      if (/error|exception|traceback/i.test(line)) {
        this.logger.warn(`metaai sidecar stderr: ${line}`);
      } else {
        this.logger.debug?.(`metaai sidecar stderr: ${line}`);
      }
    });

    this.child = child;
    this.port = port;
    const baseUrl = `http://${this.host}:${port}`;
    const client = new MetaAiClient({ baseUrl, timeoutMs: this.requestTimeoutMs });

    try {
      await this.waitForHealthy(client, child);
    } catch (err) {
      this.logger.error(`metaai sidecar failed to become healthy: ${redactSensitive(toMetaAiError(err).message)}`);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.child = null;
      this.client = null;
      this.port = null;
      throw err;
    }

    this.client = client;
    this.scheduleIdleShutdown();
    this.logger.info(`metaai sidecar: ready at ${baseUrl}`);
    return client;
  }

  private async waitForHealthy(client: MetaAiClient, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw sidecarUnavailable(
          `Meta AI sidecar exited with code ${child.exitCode} before becoming healthy.`,
        );
      }
      try {
        const result = await client.health(2_000);
        if (result.status === "ok") return;
      } catch (err) {
        lastError = err;
      }
      await delay(HEALTH_POLL_INTERVAL_MS);
    }
    throw sidecarTimeout(
      `Meta AI sidecar did not become healthy within ${this.startupTimeoutMs}ms.`,
      lastError,
    );
  }

  private scheduleIdleShutdown(): void {
    if (this.idleShutdownMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.logger.info(`metaai sidecar: idle shutdown after ${this.idleShutdownMs}ms`);
      void this.stopForIdle().catch((err) => {
        this.logger.warn(`metaai sidecar idle shutdown failed: ${redactSensitive(toMetaAiError(err).message)}`);
      });
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  /** Internal: stop the sidecar but do NOT mark it as permanently stopped. */
  private async stopForIdle(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.client = null;
    this.port = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!child || child.exitCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch (err) {
      throw internalError("Failed to send SIGTERM to metaai sidecar.", err);
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(2_000),
    ]);
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  }

  private buildSpawnEnv(cookies: ReturnType<typeof readCookiesFromEnv>): Record<string, string> {
    // Allowlist of ambient env vars that are safe to inherit. We do NOT pass
    // arbitrary process.env into the child — that would risk leaking unrelated
    // secrets configured for the host process.
    const ambient: Record<string, string> = {};
    const allowList = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "HOME", "TMPDIR", "TZ"];
    for (const key of allowList) {
      const value = this.envSource[key];
      if (typeof value === "string" && value.length > 0) ambient[key] = value;
    }
    // Forward upstream metaai-api tuning knobs so operators can override the
    // GraphQL persisted-query doc_id and related routing fields without
    // editing the venv. These are non-secret tuning values; the actual
    // secrets (cookies, access token) flow through buildSidecarCookieEnv.
    // META_AI_ACCESS_TOKEN is treated as sensitive but is a documented
    // metaai-api passthrough so we forward it when the operator sets it.
    const metaAiPassthrough = [
      "META_AI_CHAT_DOC_ID",
      "META_AI_CHAT_DOC_ID_ALT",
      "META_AI_CHAT_DOC_ID_UNIFIED_FALLBACK",
      "META_AI_CHAT_ENTRY_POINT",
      "META_AI_CHAT_BRANCH_PATH",
      "META_AI_ACCESS_TOKEN",
      // Facebook cross-site session cookies, used by the Playwright sidecar
      // when the operator authenticates to meta.ai via Facebook. All four
      // are sensitive and must be redacted from logs (handled in redact.ts
      // via the `META_AI_` prefix masking rule).
      "META_AI_FB_C_USER",
      "META_AI_FB_XS",
      "META_AI_FB_FR",
      "META_AI_FB_DATR",
      // Playwright sidecar runtime knobs (non-sensitive). Forwarded so the
      // operator can flip them without re-installing the venv.
      "META_AI_HEADLESS",
      "META_AI_DEBUG_DIR",
      "META_AI_SEND_TIMEOUT_MS",
      "META_AI_STORAGE_STATE",
      "META_AI_AUTO_LOGIN_TIMEOUT_MS",
    ];
    for (const key of metaAiPassthrough) {
      const value = this.envSource[key];
      if (typeof value === "string" && value.length > 0) ambient[key] = value;
    }
    return {
      ...ambient,
      ...this.extraEnv,
      ...buildSidecarCookieEnv(cookies),
      // Force unbuffered I/O so we surface stdout/stderr promptly.
      PYTHONUNBUFFERED: "1",
      // Defensive: tell uvicorn it must not bind to non-loopback even if the
      // user-supplied uvicorn args were tampered with downstream.
      UVICORN_HOST: this.host,
      UVICORN_PORT: String(this.pinnedPort ?? this.port ?? ""),
    };
  }
}

function consoleLogger(): SidecarLogger {
  /* eslint-disable no-console */
  return {
    info: (m) => console.log(`[metaai] ${m}`),
    warn: (m) => console.warn(`[metaai] ${m}`),
    error: (m) => console.error(`[metaai] ${m}`),
    debug: (m) => {
      if (process.env.METAAI_DEBUG === "1") console.log(`[metaai:debug] ${m}`);
    },
  };
  /* eslint-enable no-console */
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.toLowerCase() === "localhost"
  );
}

/**
 * Reserve a free port on the supplied host by binding to port 0 and reading
 * the assigned port. The returned port is then released, so callers race
 * with the kernel — but in practice the kernel reuses the just-released
 * port for the very next bind.
 */
async function findFreePort(host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(internalError("Failed to determine free port for metaai sidecar."));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
