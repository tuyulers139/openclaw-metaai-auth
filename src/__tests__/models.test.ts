import { describe, expect, it } from "vitest";

import {
  buildModelProviderConfig,
  DEFAULT_MODEL_ID,
  KNOWN_MODEL_IDS,
  listExposedModelIds,
  META_AI_PROVIDER_ID,
  MODEL_ALIASES,
  resolveModelAlias,
} from "../models.js";

describe("model registry", () => {
  it("exposes the provider id and default model the user requested", () => {
    expect(META_AI_PROVIDER_ID).toBe("metaai");
    expect(DEFAULT_MODEL_ID).toBe("metaai/muse-spark");
  });

  it("registers all four documented model ids", () => {
    expect(new Set(KNOWN_MODEL_IDS)).toEqual(
      new Set(["metaai/muse-spark", "metaai/meta-ai", "metaai/llama", "metaai/llama-3"]),
    );
  });

  it("resolves every alias to the canonical Muse Spark id", () => {
    expect(MODEL_ALIASES["metaai/muse-spark"]).toBe("metaai/muse-spark");
    expect(MODEL_ALIASES["metaai/meta-ai"]).toBe("metaai/muse-spark");
    expect(MODEL_ALIASES["metaai/llama"]).toBe("metaai/muse-spark");
    expect(MODEL_ALIASES["metaai/llama-3"]).toBe("metaai/muse-spark");
  });
});

describe("resolveModelAlias", () => {
  it("returns null for empty input", () => {
    expect(resolveModelAlias("")).toBeNull();
  });

  it("resolves prefixed canonical ids", () => {
    expect(resolveModelAlias("metaai/muse-spark")).toBe("metaai/muse-spark");
  });

  it("resolves prefixed alias ids", () => {
    expect(resolveModelAlias("metaai/meta-ai")).toBe("metaai/muse-spark");
    expect(resolveModelAlias("metaai/llama")).toBe("metaai/muse-spark");
    expect(resolveModelAlias("metaai/llama-3")).toBe("metaai/muse-spark");
  });

  it("resolves bare ids by adding the metaai/ prefix", () => {
    expect(resolveModelAlias("muse-spark")).toBe("metaai/muse-spark");
    expect(resolveModelAlias("meta-ai")).toBe("metaai/muse-spark");
    expect(resolveModelAlias("llama")).toBe("metaai/muse-spark");
  });

  it("trims whitespace before resolving", () => {
    expect(resolveModelAlias("   metaai/llama   ")).toBe("metaai/muse-spark");
  });

  it("returns null for unknown ids", () => {
    expect(resolveModelAlias("openai/gpt-4")).toBeNull();
    expect(resolveModelAlias("metaai/unknown")).toBeNull();
  });
});

describe("buildModelProviderConfig", () => {
  it("uses openai-completions as the api with a loopback baseUrl", () => {
    const cfg = buildModelProviderConfig({ baseUrl: "http://127.0.0.1:8742/v1" });
    expect(cfg.api).toBe("openai-completions");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8742/v1");
    expect(cfg.authHeader).toBe(false);
  });

  it("registers all four models by default", () => {
    const cfg = buildModelProviderConfig({ baseUrl: "http://127.0.0.1:1/v1" });
    const ids = cfg.models.map((m) => m.id);
    expect(new Set(ids)).toEqual(new Set(listExposedModelIds()));
  });

  it("filters models by allowedModels", () => {
    const cfg = buildModelProviderConfig({
      baseUrl: "http://127.0.0.1:1/v1",
      allowedModels: ["metaai/muse-spark", "metaai/llama-3"],
    });
    expect(cfg.models.map((m) => m.id)).toEqual(["metaai/muse-spark", "metaai/llama-3"]);
  });

  it("falls back to all models when allowedModels filters everything out", () => {
    const cfg = buildModelProviderConfig({
      baseUrl: "http://127.0.0.1:1/v1",
      allowedModels: ["openai/gpt-4"],
    });
    expect(cfg.models.length).toBeGreaterThan(0);
    expect(cfg.models.map((m) => m.id)).toContain("metaai/muse-spark");
  });
});
