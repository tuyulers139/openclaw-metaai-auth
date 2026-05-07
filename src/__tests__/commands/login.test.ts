import { describe, expect, it, vi } from "vitest";

import { buildLoginGuide, listLoginEnvVars } from "../../commands/login.js";
import type { MetaAiClient } from "../../metaai-client.js";
import type { MetaAiSidecar } from "../../sidecar.js";

function fakeSidecar(overrides: Partial<MetaAiSidecar> = {}): MetaAiSidecar {
  return {
    baseUrl: () => null,
    health: vi.fn(async () => false),
    ensureRunning: vi.fn(async () => ({
      health: vi.fn(async () => ({ status: "ok", cookiesConfigured: true })),
    } as unknown as MetaAiClient)),
    ...overrides,
  } as unknown as MetaAiSidecar;
}

describe("login command", () => {
  it("lists the canonical env-var names", () => {
    expect(listLoginEnvVars()).toEqual([
      "META_AI_DATR",
      "META_AI_ECTO_1_SESS",
      "META_AI_ABRA_SESS",
    ]);
  });

  it("explains how to acquire cookies when missing", async () => {
    const guide = await buildLoginGuide({
      sidecar: fakeSidecar(),
      envSource: {},
    });
    expect(guide).toContain("DevTools");
    expect(guide).toContain("META_AI_DATR");
    expect(guide).toContain("META_AI_ECTO_1_SESS");
    expect(guide).toContain("missing");
    expect(guide).not.toContain("Validating cookies");
  });

  it("validates against the sidecar when both required cookies are present", async () => {
    const ensureRunning = vi.fn(async () => ({
      health: vi.fn(async () => ({ status: "ok", cookiesConfigured: true })),
    } as unknown as MetaAiClient));
    const guide = await buildLoginGuide({
      sidecar: fakeSidecar({ ensureRunning }),
      envSource: {
        META_AI_DATR: "d",
        META_AI_ECTO_1_SESS: "e",
      },
    });
    expect(guide).toContain("Validating cookies");
    expect(guide).toContain("Sidecar health: OK");
    expect(ensureRunning).toHaveBeenCalled();
  });

  it("surfaces sidecar errors with redacted messages", async () => {
    const ensureRunning = vi.fn(async () => {
      throw new Error("Bearer abcdef0123456789 leaked");
    });
    const guide = await buildLoginGuide({
      sidecar: fakeSidecar({ ensureRunning }),
      envSource: {
        META_AI_DATR: "d",
        META_AI_ECTO_1_SESS: "e",
      },
    });
    expect(guide).toContain("FAILED");
    expect(guide).not.toContain("abcdef0123456789");
  });

  it("never echoes cookie values, even when present", async () => {
    const guide = await buildLoginGuide({
      sidecar: fakeSidecar({
        ensureRunning: vi.fn(async () => ({
          health: vi.fn(async () => ({ status: "ok" })),
        } as unknown as MetaAiClient)),
      }),
      envSource: {
        META_AI_DATR: "very-secret-datr-value",
        META_AI_ECTO_1_SESS: "very-secret-ecto-value",
      },
    });
    expect(guide).not.toContain("very-secret-datr-value");
    expect(guide).not.toContain("very-secret-ecto-value");
  });
});
