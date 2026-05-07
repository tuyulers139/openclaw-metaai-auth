import { describe, expect, it } from "vitest";

import { resolvePluginConfig } from "../config.js";
import { MetaAiError } from "../errors.js";

describe("resolvePluginConfig", () => {
  it("applies defaults when given an empty object", () => {
    const cfg = resolvePluginConfig({});
    expect(cfg.sidecar.host).toBe("127.0.0.1");
    expect(cfg.sidecar.pythonBin).toBe("python3");
    expect(cfg.sidecar.idleShutdownMs).toBeGreaterThan(0);
    expect(cfg.sidecar.startupTimeoutMs).toBeGreaterThan(0);
    expect(cfg.sidecar.requestTimeoutMs).toBeGreaterThan(0);
    expect(cfg.defaultModel).toBe("metaai/muse-spark");
    expect(cfg.allowedModels).toBeUndefined();
    expect(cfg.sidecar.port).toBeUndefined();
  });

  it("rejects a non-loopback sidecar.host", () => {
    expect(() =>
      resolvePluginConfig({ sidecar: { host: "0.0.0.0" } }),
    ).toThrow(MetaAiError);
  });

  it("rejects out-of-range ports", () => {
    expect(() => resolvePluginConfig({ sidecar: { port: 0 } })).toThrow(MetaAiError);
    expect(() => resolvePluginConfig({ sidecar: { port: 70_000 } })).toThrow(MetaAiError);
  });

  it("rejects negative timeouts and idle windows", () => {
    expect(() => resolvePluginConfig({ sidecar: { idleShutdownMs: -1 } })).toThrow(MetaAiError);
    expect(() => resolvePluginConfig({ sidecar: { startupTimeoutMs: 0 } })).toThrow(MetaAiError);
    expect(() => resolvePluginConfig({ sidecar: { requestTimeoutMs: -1 } })).toThrow(MetaAiError);
  });

  it("enforces string-only extraEnv", () => {
    expect(() =>
      resolvePluginConfig({ sidecar: { extraEnv: { FOO: 42 } } }),
    ).toThrow(MetaAiError);
  });

  it("accepts loopback variants", () => {
    expect(resolvePluginConfig({ sidecar: { host: "::1" } }).sidecar.host).toBe("::1");
    expect(resolvePluginConfig({ sidecar: { host: "localhost" } }).sidecar.host).toBe("localhost");
  });

  it("preserves allowedModels and extraEnv when valid", () => {
    const cfg = resolvePluginConfig({
      defaultModel: "metaai/llama",
      allowedModels: ["metaai/muse-spark"],
      sidecar: {
        port: 8742,
        openAiProxyPort: 8743,
        extraEnv: { METAAI_DEBUG: "1" },
      },
    });
    expect(cfg.defaultModel).toBe("metaai/llama");
    expect(cfg.allowedModels).toEqual(["metaai/muse-spark"]);
    expect(cfg.sidecar.port).toBe(8742);
    expect(cfg.sidecar.openAiProxyPort).toBe(8743);
    expect(cfg.sidecar.extraEnv).toEqual({ METAAI_DEBUG: "1" });
  });
});
