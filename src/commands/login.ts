import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Derived from OpenClawPluginApi to avoid reaching into internal SDK paths.
type OpenClawPluginCommandDefinition = Parameters<OpenClawPluginApi["registerCommand"]>[0];

import {
  ALL_COOKIE_ENV_VARS,
  inspectCookieEnv,
  META_AI_ABRA_SESS,
  META_AI_DATR,
  META_AI_ECTO_1_SESS,
} from "../cookies.js";
import type { MetaAiSidecar } from "../sidecar.js";
import { toMetaAiError } from "../errors.js";
import { redactSensitive } from "../redact.js";

export interface LoginCommandDeps {
  sidecar: MetaAiSidecar;
  envSource?: Readonly<Record<string, string | undefined>>;
}

/**
 * Build the textual login walkthrough. Doubles as the unit-testable core of
 * {@link makeLoginCommand}; never echoes cookie values.
 */
export async function buildLoginGuide(deps: LoginCommandDeps): Promise<string> {
  const presence = inspectCookieEnv(deps.envSource);
  const lines: string[] = [
    "*Meta AI login*",
    "",
    "Meta AI authenticates with browser cookies, NOT API keys. To enable this plugin:",
    "",
    "1. Sign in to https://meta.ai in your browser.",
    "2. Open DevTools → Application → Cookies → meta.ai.",
    `3. Copy the values of cookies named \`datr\` and \`xs\`/\`ecto_1_sess\` ` +
      `(and optionally \`abra_sess\`).`,
    "4. Store them in OpenClaw's secret store as the following env-var names:",
    `   • ${META_AI_DATR}`,
    `   • ${META_AI_ECTO_1_SESS}`,
    `   • ${META_AI_ABRA_SESS} (optional)`,
    "5. Restart OpenClaw so the plugin picks up the new env values.",
    "",
    "Treat these cookies like passwords — they grant chat-level access to your",
    "Meta account. Never commit them to version control or paste them into",
    "untrusted shells.",
    "",
    "*Current state*:",
    `• ${META_AI_DATR}: ${presence.datr ? "configured" : "missing"}`,
    `• ${META_AI_ECTO_1_SESS}: ${presence.ectoSess ? "configured" : "missing"}`,
    `• ${META_AI_ABRA_SESS}: ${presence.abraSess ? "configured" : "absent (optional)"}`,
  ];

  if (!presence.ready) {
    lines.push("", "Required cookies are missing — sidecar will not be started.");
    return lines.join("\n");
  }

  lines.push("", "Validating cookies against the metaai-api sidecar…");
  try {
    const client = await deps.sidecar.ensureRunning();
    const health = await client.health(5_000);
    lines.push(`• Sidecar health: ${health.status === "ok" ? "OK" : `degraded (${health.status})`}`);
    if (health.cookiesConfigured === false) {
      lines.push(
        "• Sidecar reports cookies as not configured — double-check the env-var names above.",
      );
    }
  } catch (err) {
    const message = redactSensitive(toMetaAiError(err).message);
    lines.push(`• Sidecar health: FAILED — ${message}`);
  }
  return lines.join("\n");
}

/** Lists the env-var names this plugin reads. Used by docs and tests. */
export function listLoginEnvVars(): readonly string[] {
  return ALL_COOKIE_ENV_VARS;
}

export function makeLoginCommand(deps: LoginCommandDeps): OpenClawPluginCommandDefinition {
  return {
    name: "metaai-login",
    description: "Show the Meta AI cookie acquisition guide and validate the current configuration.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const text = await buildLoginGuide(deps);
      return { text };
    },
  };
}
