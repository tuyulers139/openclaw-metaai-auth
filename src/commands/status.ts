import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Derived from OpenClawPluginApi to avoid reaching into internal SDK paths.
type OpenClawPluginCommandDefinition = Parameters<OpenClawPluginApi["registerCommand"]>[0];

import { inspectCookieEnv } from "../cookies.js";
import type { MetaAiSidecar } from "../sidecar.js";
import { toMetaAiError } from "../errors.js";
import { redactSensitive } from "../redact.js";

export interface StatusCommandDeps {
  sidecar: MetaAiSidecar;
  envSource?: Readonly<Record<string, string | undefined>>;
}

/**
 * Render a textual summary of the plugin's auth/sidecar state without
 * leaking cookie values or other secrets. Exposed both as a {@link makeStatusCommand}
 * OpenClaw chat command and as a unit-testable function.
 */
export async function buildStatusReport(deps: StatusCommandDeps): Promise<string> {
  const presence = inspectCookieEnv(deps.envSource);
  const lines: string[] = ["*Meta AI plugin status*"];

  lines.push(
    `• Cookies: META_AI_DATR=${presence.datr ? "set" : "MISSING"}` +
      `, META_AI_ECTO_1_SESS=${presence.ectoSess ? "set" : "MISSING"}` +
      `, META_AI_ABRA_SESS=${presence.abraSess ? "set" : "absent (optional)"}`,
  );

  const baseUrl = deps.sidecar.baseUrl();
  if (!presence.ready) {
    lines.push(
      "• Sidecar: NOT READY — required cookies are missing. Run `/metaai-login` for setup steps.",
    );
    return lines.join("\n");
  }

  if (!baseUrl) {
    lines.push("• Sidecar: not yet started (will boot lazily on first chat call).");
  } else {
    lines.push(`• Sidecar URL: ${baseUrl} (loopback only)`);
    try {
      const healthy = await deps.sidecar.health();
      lines.push(`• Sidecar health: ${healthy ? "OK" : "DEGRADED"}`);
    } catch (err) {
      lines.push(
        `• Sidecar health: ERROR — ${redactSensitive(toMetaAiError(err).message)}`,
      );
    }
  }
  return lines.join("\n");
}

export function makeStatusCommand(deps: StatusCommandDeps): OpenClawPluginCommandDefinition {
  return {
    name: "metaai-status",
    description: "Show Meta AI plugin auth + sidecar status without exposing secrets.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const text = await buildStatusReport(deps);
      return { text };
    },
  };
}
