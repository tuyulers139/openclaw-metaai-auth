import { describe, expect, it } from "vitest";

import { buildProviderPlugin, definition, META_AI_PROVIDER_ID } from "../index.js";

describe("buildProviderPlugin", () => {
  it("returns a ProviderPlugin with the metaai id and required env vars", () => {
    const provider = buildProviderPlugin({
      baseUrl: "http://127.0.0.1:8742/v1",
      allowedModels: undefined,
      defaultModel: "metaai/muse-spark",
    });
    expect(provider.id).toBe(META_AI_PROVIDER_ID);
    expect(provider.envVars).toEqual([
      "META_AI_DATR",
      "META_AI_ECTO_1_SESS",
      "META_AI_ABRA_SESS",
    ]);
    expect(provider.aliases).toEqual(["meta-ai", "muse-spark"]);
    expect(provider.models?.api).toBe("openai-completions");
    expect(provider.models?.baseUrl).toBe("http://127.0.0.1:8742/v1");
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]?.kind).toBe("custom");
  });

  it("auth.run returns notes that mention the default model", async () => {
    const provider = buildProviderPlugin({
      baseUrl: "http://127.0.0.1:8742/v1",
      allowedModels: undefined,
      defaultModel: "metaai/muse-spark",
    });
    const authEntry = provider.auth[0];
    if (!authEntry) throw new Error("expected provider.auth[0] to be defined");
    const result = await authEntry.run({} as never);
    expect(result.profiles).toEqual([]);
    expect(result.notes?.some((n) => n.includes("metaai/muse-spark"))).toBe(true);
  });
});

describe("plugin definition", () => {
  it("exports id, name, and a register function", () => {
    expect(definition.id).toBe("metaai");
    expect(definition.name).toBe("Meta AI");
    expect(typeof definition.register).toBe("function");
  });
});
