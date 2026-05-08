import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type Manifest = {
  activation?: {
    onStartup?: boolean;
    onProviders?: string[];
    onCommands?: string[];
    onCapabilities?: string[];
  };
  commandAliases?: string[];
  providers?: string[];
  setup?: {
    providers?: Array<{ id?: string; envVars?: string[] }>;
  };
};

function loadManifest(): Manifest {
  return JSON.parse(
    readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as Manifest;
}

describe("openclaw.plugin.json", () => {
  it("declares runtime activation metadata for the Meta AI provider", () => {
    const manifest = loadManifest();

    expect(manifest.activation?.onStartup).toBe(true);
    expect(manifest.activation?.onProviders).toContain("metaai");
    expect(manifest.activation?.onCapabilities).toContain("provider");
    expect(manifest.providers).toEqual(["metaai"]);
  });

  it("declares command aliases and setup env vars", () => {
    const manifest = loadManifest();

    expect(manifest.commandAliases).toEqual([
      "metaai-status",
      "metaai-login",
      "metaai-image",
      "metaai-video",
    ]);
    expect(manifest.activation?.onCommands).toEqual(manifest.commandAliases);
    expect(manifest.setup?.providers?.find((provider) => provider.id === "metaai")?.envVars).toEqual([
      "META_AI_DATR",
      "META_AI_ECTO_1_SESS",
      "META_AI_ABRA_SESS",
    ]);
  });
});
