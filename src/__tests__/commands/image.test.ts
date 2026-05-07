import { describe, expect, it, vi } from "vitest";

import { parseImageArgs, runImageCommand } from "../../commands/image.js";
import type { MetaAiClient } from "../../metaai-client.js";
import type { MetaAiSidecar } from "../../sidecar.js";

function fakeSidecar(client: MetaAiClient): MetaAiSidecar {
  return {
    ensureRunning: vi.fn(async () => client),
    baseUrl: () => "http://127.0.0.1:1234",
    health: vi.fn(async () => true),
  } as unknown as MetaAiSidecar;
}

function fakeClient(impl: MetaAiClient["image"]): MetaAiClient {
  return {
    image: vi.fn(impl),
  } as unknown as MetaAiClient;
}

describe("parseImageArgs", () => {
  it("extracts orientation and preserves the prompt", () => {
    expect(parseImageArgs("a cat --orientation=landscape")).toEqual({
      prompt: "a cat",
      orientation: "landscape",
    });
  });

  it("ignores unknown orientation values", () => {
    expect(parseImageArgs("a cat --orientation=foo")).toEqual({ prompt: "a cat --orientation=foo" });
  });

  it("returns an empty prompt when input is blank", () => {
    expect(parseImageArgs("")).toEqual({ prompt: "" });
  });
});

describe("runImageCommand", () => {
  it("returns a usage message when no prompt is provided", async () => {
    const out = await runImageCommand("", {
      sidecar: fakeSidecar(fakeClient(async () => ({ urls: [] }))),
      envSource: { META_AI_DATR: "d", META_AI_ECTO_1_SESS: "e" },
    });
    expect(out).toContain("Usage:");
  });

  it("blocks when cookies are missing", async () => {
    const out = await runImageCommand("a cat", {
      sidecar: fakeSidecar(fakeClient(async () => ({ urls: [] }))),
      envSource: {},
    });
    expect(out).toContain("requires META_AI_DATR");
  });

  it("renders generated image URLs", async () => {
    const client = fakeClient(async () => ({
      urls: ["https://meta/img1.png", "https://meta/img2.png"],
    }));
    const out = await runImageCommand("a cat --orientation=square", {
      sidecar: fakeSidecar(client),
      envSource: { META_AI_DATR: "d", META_AI_ECTO_1_SESS: "e" },
    });
    expect(out).toContain("Generated 2 images");
    expect(out).toContain("https://meta/img1.png");
    expect(out).toContain("https://meta/img2.png");
    expect(client.image).toHaveBeenCalledWith({ prompt: "a cat", orientation: "square" });
  });

  it("redacts errors thrown by the sidecar", async () => {
    const client = fakeClient(async () => {
      throw new Error("Bearer abcdef0123456789 leaked");
    });
    const out = await runImageCommand("a cat", {
      sidecar: fakeSidecar(client),
      envSource: { META_AI_DATR: "d", META_AI_ECTO_1_SESS: "e" },
    });
    expect(out).toContain("failed");
    expect(out).not.toContain("abcdef0123456789");
  });
});
