import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";

// Derive the types that the public plugin-sdk index does not re-export
// directly from the API surface we already have access to. This avoids
// reaching into internal subpaths of the openclaw package.
type ProviderPlugin = Parameters<OpenClawPluginApi["registerProvider"]>[0];

/** Subset of `OpenClawPluginDefinition` we care about. The SDK itself does
 *  not re-export the full definition type from its public entrypoint, so we
 *  declare the shape we actually populate. The plugin loader reads `register`
 *  by name, so this is shape-compatible with the SDK's loader. */
export type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void | Promise<void>;
};

import { makeImageCommand } from "./commands/image.js";
import { makeLoginCommand } from "./commands/login.js";
import { makeStatusCommand } from "./commands/status.js";
import { makeVideoCommand } from "./commands/video.js";
import { resolvePluginConfig } from "./config.js";
import { ALL_COOKIE_ENV_VARS } from "./cookies.js";
import { toMetaAiError } from "./errors.js";
import {
  buildModelProviderConfig,
  DEFAULT_MODEL_ID,
  META_AI_PROVIDER_ID,
} from "./models.js";
import { OpenAiCompatProxy } from "./openai-proxy.js";
import { redactSensitive } from "./redact.js";
import { MetaAiSidecar } from "./sidecar.js";

/**
 * OpenClaw plugin entrypoint.
 *
 * Architecture:
 *  - {@link MetaAiSidecar} manages a Python `metaai-api` (uvicorn) process
 *    bound to 127.0.0.1, started lazily on first chat/image/video call.
 *  - {@link OpenAiCompatProxy} listens on a separate loopback port and
 *    translates between OpenAI Chat Completions schema and the metaai-api
 *    `/chat` endpoint. OpenClaw's model registry talks to the proxy via
 *    `api: "openai-completions"`, so existing OpenAI-compat agents just work.
 *  - Cookies are read from process.env (which OpenClaw populates from its
 *    secret store) — never from plugin config and never logged.
 */
export default function register(api: OpenClawPluginApi): void {
  api.logger.info("metaai: register() invoked — resolving plugin config");
  const cfg = resolvePluginConfig(api.pluginConfig);
  api.logger.info(
    `metaai: register() resolved cfg (host=${cfg.sidecar.host} sidecarPort=${cfg.sidecar.port ?? "ephemeral"} openAiProxyPort=${cfg.sidecar.openAiProxyPort ?? "ephemeral"} defaultModel=${cfg.defaultModel})`,
  );

  const sidecar = new MetaAiSidecar({
    pythonBin: cfg.sidecar.pythonBin,
    host: cfg.sidecar.host,
    port: cfg.sidecar.port,
    idleShutdownMs: cfg.sidecar.idleShutdownMs,
    startupTimeoutMs: cfg.sidecar.startupTimeoutMs,
    requestTimeoutMs: cfg.sidecar.requestTimeoutMs,
    extraEnv: cfg.sidecar.extraEnv,
    logger: api.logger,
  });

  const proxy = new OpenAiCompatProxy({
    host: cfg.sidecar.host,
    port: cfg.sidecar.openAiProxyPort,
    logger: api.logger,
    clientFactory: () => sidecar.ensureRunning(),
  });

  let providerRegistered = false;
  let runtimeStartPromise: Promise<void> | undefined;

  const startRuntime = async (source: string): Promise<void> => {
    if (runtimeStartPromise) return runtimeStartPromise;
    runtimeStartPromise = (async () => {
      api.logger.info(`metaai: runtime start requested by ${source} — binding openai-compat proxy`);
      try {
        const { baseUrl } = await proxy.listen();
        if (!providerRegistered) {
          const provider = buildProviderPlugin({
            baseUrl,
            allowedModels: cfg.allowedModels,
            defaultModel: cfg.defaultModel,
          });
          api.registerProvider(provider);
          providerRegistered = true;
          api.logger.info(
            `metaai: registered provider '${META_AI_PROVIDER_ID}' (default ${cfg.defaultModel}) at ${baseUrl}`,
          );
        }
      } catch (err) {
        runtimeStartPromise = undefined;
        const e = toMetaAiError(err);
        api.logger.error(`metaai: failed to start runtime — ${redactSensitive(e.message)}`);
        throw e;
      }
    })();
    return runtimeStartPromise;
  };

  const service: OpenClawPluginService = {
    id: "metaai-runtime",
    start: async (_ctx: OpenClawPluginServiceContext) => {
      api.logger.info("metaai: service 'metaai-runtime' start() called");
      await startRuntime("plugin service");
    },
    stop: async () => {
      try {
        await proxy.close();
      } catch (err) {
        api.logger.warn(`metaai: openai-proxy close failed — ${redactSensitive(toMetaAiError(err).message)}`);
      }
      try {
        await sidecar.stop();
      } catch (err) {
        api.logger.warn(`metaai: sidecar stop failed — ${redactSensitive(toMetaAiError(err).message)}`);
      }
    },
  };
  api.registerService(service);
  api.logger.info("metaai: registered service 'metaai-runtime' (start() runs on Gateway boot)");

  void startRuntime("plugin register fallback").catch((err) => {
    api.logger.error(`metaai: runtime fallback start failed — ${redactSensitive(toMetaAiError(err).message)}`);
  });

  api.registerCommand(makeStatusCommand({ sidecar }));
  api.registerCommand(makeLoginCommand({ sidecar }));
  api.registerCommand(makeImageCommand({ sidecar }));
  api.registerCommand(makeVideoCommand({ sidecar }));
}

/** Exported for tests; constructs the provider plugin that gets registered. */
export function buildProviderPlugin(params: {
  baseUrl: string;
  allowedModels: readonly string[] | undefined;
  defaultModel: string;
}): ProviderPlugin {
  const models = buildModelProviderConfig({
    baseUrl: params.baseUrl,
    allowedModels: params.allowedModels,
  });
  return {
    id: META_AI_PROVIDER_ID,
    label: "Meta AI (Muse Spark)",
    aliases: ["meta-ai", "muse-spark"],
    envVars: [...ALL_COOKIE_ENV_VARS],
    models,
    auth: [
      {
        id: "metaai-cookies",
        label: "Meta AI browser cookies",
        kind: "custom",
        hint: "Set META_AI_DATR / META_AI_ECTO_1_SESS env vars (and optionally META_AI_ABRA_SESS).",
        run: async () => ({
          profiles: [],
          notes: [
            "Meta AI is authenticated via browser cookies stored in OpenClaw secrets.",
            "No interactive auth flow — run /metaai-login from a connected channel for the cookie acquisition guide.",
            `Default model: ${params.defaultModel}`,
          ],
        }),
      },
    ],
  };
}

/**
 * Plugin definition export. Tools that look at a default-exported function
 * call it with the OpenClaw API; tools that look at a default-exported
 * object read the metadata first. Returning both at once is awkward in
 * TypeScript, so we follow the same pattern as the bundled `llm-task`
 * extension and rely on `register` plus the JSON manifest.
 */
export const definition: OpenClawPluginDefinition = {
  id: META_AI_PROVIDER_ID,
  name: "Meta AI",
  description:
    "Native OpenClaw provider for Meta AI chat (Muse Spark / Llama) backed by the mir-ashiq/metaai-api FastAPI sidecar.",
  register,
};

export {
  DEFAULT_MODEL_ID,
  META_AI_PROVIDER_ID,
  buildModelProviderConfig,
  resolvePluginConfig,
};
