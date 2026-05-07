import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// The plugin-sdk exposes `OpenClawPluginApi` from its public entrypoint, but
// `ProviderPlugin` / `ModelProviderConfig` are not directly re-exported there.
// Derive them from the API surface we already have access to so we never
// reach into internal subpaths.
type ProviderPluginType = Parameters<OpenClawPluginApi["registerProvider"]>[0];
export type ModelProviderConfig = NonNullable<ProviderPluginType["models"]>;
export type ModelDefinitionConfig = ModelProviderConfig["models"][number];

/**
 * Provider id surfaced to OpenClaw. Follows the standard `<provider>/<model>`
 * scheme — see README.md for the full alias table.
 */
export const META_AI_PROVIDER_ID = "metaai";

/** Default Meta AI model id surfaced to OpenClaw. */
export const DEFAULT_MODEL_ID = "metaai/muse-spark";

/**
 * OpenClaw-facing model ids. Meta AI does not expose explicit model selection
 * via its public web endpoints; all of these route through the same Meta AI
 * chat backend. The id is preserved through the OpenAI-compat proxy as a
 * descriptive label, but the upstream backend is decided server-side by Meta.
 */
export const KNOWN_MODEL_IDS = [
  "metaai/muse-spark",
  "metaai/meta-ai",
  "metaai/llama",
  "metaai/llama-3",
] as const;

export type KnownModelId = (typeof KNOWN_MODEL_IDS)[number];

/**
 * Alias table — every alias resolves to the same upstream chat backend.
 * `metaai/muse-spark` is the canonical label.
 */
export const MODEL_ALIASES: Readonly<Record<string, KnownModelId>> = Object.freeze({
  "metaai/meta-ai": "metaai/muse-spark",
  "metaai/llama": "metaai/muse-spark",
  "metaai/llama-3": "metaai/muse-spark",
  "metaai/muse-spark": "metaai/muse-spark",
});

/**
 * Resolve an OpenClaw model id (with or without the `metaai/` prefix) to a
 * canonical Meta AI model id. Returns `null` if the id is not registered.
 */
export function resolveModelAlias(modelId: string): KnownModelId | null {
  if (!modelId) return null;
  const trimmed = modelId.trim();
  if (trimmed in MODEL_ALIASES) return MODEL_ALIASES[trimmed] ?? null;
  // Bare ids without provider prefix
  const prefixed = `${META_AI_PROVIDER_ID}/${trimmed}`;
  if (prefixed in MODEL_ALIASES) return MODEL_ALIASES[prefixed] ?? null;
  return null;
}

/**
 * Model definitions registered against the OpenClaw model registry. The
 * `cost` numbers are zeroed out because Meta AI does not bill API consumers
 * directly — the provider is cookie-authed against meta.ai.
 */
const META_AI_MODELS: readonly ModelDefinitionConfig[] = [
  {
    id: "muse-spark",
    name: "Meta AI — Muse Spark",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  },
  {
    id: "meta-ai",
    name: "Meta AI (alias → Muse Spark)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  },
  {
    id: "llama",
    name: "Meta AI — Llama (alias → Muse Spark, server-side routing)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  },
  {
    id: "llama-3",
    name: "Meta AI — Llama 3 (alias → Muse Spark, server-side routing)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  },
] as const;

export interface BuildModelProviderConfigParams {
  baseUrl: string;
  allowedModels?: readonly string[];
}

/**
 * Build the `ModelProviderConfig` consumed by `OpenClawPluginApi.registerProvider`.
 *
 * `baseUrl` must be the OpenAI-compat proxy that fronts the metaai-api sidecar
 * (e.g. `http://127.0.0.1:<port>/v1`). When `allowedModels` is supplied, the
 * returned config is filtered to that subset.
 */
export function buildModelProviderConfig(
  params: BuildModelProviderConfigParams,
): ModelProviderConfig {
  const { baseUrl, allowedModels } = params;
  const allow = allowedModels && allowedModels.length > 0
    ? new Set(allowedModels)
    : null;
  const models = allow
    ? META_AI_MODELS.filter((m) => allow.has(m.id) || allow.has(`${META_AI_PROVIDER_ID}/${m.id}`))
    : META_AI_MODELS;
  if (models.length === 0) {
    // Defensive: never register an empty model list.
    return {
      baseUrl,
      api: "openai-completions",
      authHeader: false,
      models: [...META_AI_MODELS],
    };
  }
  return {
    baseUrl,
    api: "openai-completions",
    authHeader: false,
    models: [...models],
  };
}

/** Returns the canonical, human-readable list of model ids exposed by this plugin. */
export function listExposedModelIds(): readonly string[] {
  return META_AI_MODELS.map((m) => m.id);
}
