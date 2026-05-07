import { describe, expect, it, vi } from "vitest";

import { parseVideoArgs, runVideoCommand } from "../../commands/video.js";
import type { MetaAiClient } from "../../metaai-client.js";
import type { MetaAiSidecar } from "../../sidecar.js";

function fakeSidecar(client: MetaAiClient): MetaAiSidecar {
  return {
    ensureRunning: vi.fn(async () => client),
    baseUrl: () => "http://127.0.0.1:1234",
    health: vi.fn(async () => true),
  } as unknown as MetaAiSidecar;
}

function fakeClient(impl: MetaAiClient["video"]): MetaAiClient {
  return {
    video: vi.fn(impl),
  } as unknown as MetaAiClient;
}

describe("parseVideoArgs", () => {
  it("extracts a positive duration", () => {
    expect(parseVideoArgs("a wave --duration=5")).toEqual({ prompt: "a wave", durationSeconds: 5 });
  });

  it("ignores out-of-range durations and leaves the token in the prompt", () => {
    expect(parseVideoArgs("clip --duration=999")).toEqual({ prompt: "clip --duration=999" });
  });

  it("returns an empty prompt for blank input", () => {
    expect(parseVideoArgs("")).toEqual({ prompt: "" });
  });
});

describe("runVideoCommand", () => {
  it("returns a usage message when no prompt is provided", async () => {
    const out = await runVideoCommand("", {
      sidecar: fakeSidecar(fakeClient(async () => ({ url: "" }))),
      envSource: { META_AI_DATR: "d", META_AI_ECTO_1_SESS: "e" },
    });
    expect(out).toContain("Usage:");
  });

  it("blocks when cookies are missing", async () => {
    const out = await runVideoCommand("a wave", {
      sidecar: fakeSidecar(fakeClient(async () => ({ url: "" }))),
      envSource: {},
    });
    expect(out).toContain("requires META_AI_DATR");
  });

  it("renders the generated video URL", async () => {
    const client = fakeClient(async () => ({ url: "https://meta/wave.mp4" }));
    const out = await runVideoCommand("a wave --duration=5", {
      sidecar: fakeSidecar(client),
      envSource: { META_AI_DATR: "d", META_AI_ECTO_1_SESS: "e" },
    });
    expect(out).toContain("https://meta/wave.mp4");
    expect(client.video).toHaveBeenCalledWith({ prompt: "a wave", durationSeconds: 5 });
  });

  it("redacts errors thrown by the sidecar", async () => {
    const client = fakeClient(async () => {
      throw new Error("Bearer abcdef0123456789 leaked");
    });
    const out = await runVideoCommand("a wave", {
      sidecar: fakeSidecar(client),
      envSource: { META_AI_DATR: "d", META_AI_ECTO_1_SESS: "e" },
    });
    expect(out).toContain("failed");
    expect(out).not.toContain("abcdef0123456789");
  });
});
