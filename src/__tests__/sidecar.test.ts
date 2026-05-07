import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { MetaAiError } from "../errors.js";
import { MetaAiSidecar } from "../sidecar.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeFakeChild(overrides: { exitCode?: number | null } = {}) {
  const child = new EventEmitter() as unknown as {
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => boolean;
    exitCode: number | null;
    once: EventEmitter["once"];
    on: EventEmitter["on"];
    emit: EventEmitter["emit"];
  };
  Object.assign(child, {
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    kill: vi.fn(() => true),
    exitCode: overrides.exitCode ?? null,
  });
  return child;
}

describe("MetaAiSidecar", () => {
  it("rejects non-loopback host", () => {
    expect(() => new MetaAiSidecar({ host: "0.0.0.0" })).toThrow(MetaAiError);
  });

  it("propagates auth errors when cookies are missing", async () => {
    const sidecar = new MetaAiSidecar({
      logger: silentLogger,
      envSource: {},
      spawnImpl: vi.fn(() => makeFakeChild()) as unknown as MetaAiSidecar["spawnImpl"],
    } as unknown as ConstructorParameters<typeof MetaAiSidecar>[0]);
    await expect(sidecar.ensureRunning()).rejects.toMatchObject({ kind: "auth" });
    expect(sidecar.isRunning()).toBe(false);
  });

  it("filters ambient env to a small allowlist before spawning", async () => {
    const captured: { command?: string; args?: readonly string[]; env?: Record<string, string | undefined> } = {};
    const fakeChild = makeFakeChild();
    const spawnImpl = vi.fn((command: string, args: readonly string[], options: { env?: Record<string, string | undefined> }) => {
      captured.command = command;
      captured.args = args;
      captured.env = options.env;
      // Fail health probe quickly so the test resolves without a real Python process.
      setTimeout(() => {
        (fakeChild as unknown as EventEmitter).emit("exit", 1, null);
        (fakeChild as { exitCode: number | null }).exitCode = 1;
      }, 5);
      return fakeChild as unknown as ReturnType<NonNullable<MetaAiSidecar["spawnImpl"]>>;
    });

    const sidecar = new MetaAiSidecar({
      logger: silentLogger,
      port: 9999,
      startupTimeoutMs: 200,
      idleShutdownMs: 0,
      envSource: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        UNRELATED_SECRET: "should-not-leak",
        AWS_SECRET_ACCESS_KEY: "should-not-leak",
        META_AI_DATR: "datr-value",
        META_AI_ECTO_1_SESS: "ecto-value",
      },
      spawnImpl: spawnImpl as unknown as MetaAiSidecar["spawnImpl"],
    } as unknown as ConstructorParameters<typeof MetaAiSidecar>[0]);

    await expect(sidecar.ensureRunning()).rejects.toBeDefined();

    expect(captured.command).toBe("python3");
    expect(captured.args?.[0]).toBe("-m");
    expect(captured.args).toContain("uvicorn");
    // Sidecar must be told to bind only to the requested loopback host
    expect(captured.args).toContain("--host");
    expect(captured.args).toContain("127.0.0.1");

    // Ambient env: cookies present, unrelated secrets dropped
    expect(captured.env?.META_AI_DATR).toBe("datr-value");
    expect(captured.env?.META_AI_ECTO_1_SESS).toBe("ecto-value");
    expect(captured.env?.PATH).toBe("/usr/bin");
    expect(captured.env?.HOME).toBe("/home/test");
    expect(captured.env?.UNRELATED_SECRET).toBeUndefined();
    expect(captured.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // Defensive UVICORN_HOST is set
    expect(captured.env?.UVICORN_HOST).toBe("127.0.0.1");
  });

  it("reports baseUrl as null until startup is attempted", () => {
    const sidecar = new MetaAiSidecar({ logger: silentLogger });
    expect(sidecar.baseUrl()).toBeNull();
    expect(sidecar.isRunning()).toBe(false);
  });

  it("refuses to restart after stop()", async () => {
    const sidecar = new MetaAiSidecar({ logger: silentLogger });
    await sidecar.stop();
    await expect(sidecar.ensureRunning()).rejects.toMatchObject({ kind: "config" });
  });
});
