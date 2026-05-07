import { describe, expect, it, vi } from "vitest";

import { buildStatusReport } from "../../commands/status.js";
import type { MetaAiSidecar } from "../../sidecar.js";

function fakeSidecar(overrides: Partial<MetaAiSidecar>): MetaAiSidecar {
  return {
    baseUrl: () => null,
    health: vi.fn(async () => false),
    ...overrides,
  } as unknown as MetaAiSidecar;
}

describe("status command", () => {
  it("reports MISSING for cookies that are not configured", async () => {
    const out = await buildStatusReport({
      sidecar: fakeSidecar({}),
      envSource: {},
    });
    expect(out).toContain("META_AI_DATR=MISSING");
    expect(out).toContain("META_AI_ECTO_1_SESS=MISSING");
    expect(out).toContain("/metaai-login");
  });

  it("reports the loopback baseUrl and health when running", async () => {
    const out = await buildStatusReport({
      sidecar: fakeSidecar({
        baseUrl: () => "http://127.0.0.1:8742",
        health: vi.fn(async () => true),
      }),
      envSource: {
        META_AI_DATR: "d",
        META_AI_ECTO_1_SESS: "e",
      },
    });
    expect(out).toContain("http://127.0.0.1:8742");
    expect(out).toContain("loopback only");
    expect(out).toContain("OK");
  });

  it("reports DEGRADED when the sidecar health probe returns false", async () => {
    const out = await buildStatusReport({
      sidecar: fakeSidecar({
        baseUrl: () => "http://127.0.0.1:8742",
        health: vi.fn(async () => false),
      }),
      envSource: {
        META_AI_DATR: "d",
        META_AI_ECTO_1_SESS: "e",
      },
    });
    expect(out).toContain("DEGRADED");
  });

  it("does not echo cookie values", async () => {
    const out = await buildStatusReport({
      sidecar: fakeSidecar({}),
      envSource: {
        META_AI_DATR: "ultra-secret-datr",
        META_AI_ECTO_1_SESS: "ultra-secret-ecto",
      },
    });
    expect(out).not.toContain("ultra-secret-datr");
    expect(out).not.toContain("ultra-secret-ecto");
  });
});
