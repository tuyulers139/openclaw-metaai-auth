import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Derived from OpenClawPluginApi to avoid reaching into internal SDK paths.
type OpenClawPluginCommandDefinition = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type CommandHandlerContext = Parameters<OpenClawPluginCommandDefinition["handler"]>[0];

import { inspectCookieEnv } from "../cookies.js";
import { toMetaAiError } from "../errors.js";
import { redactSensitive } from "../redact.js";
import type { MetaAiSidecar } from "../sidecar.js";

export interface VideoCommandDeps {
  sidecar: MetaAiSidecar;
  envSource?: Readonly<Record<string, string | undefined>>;
}

interface ParsedVideoArgs {
  prompt: string;
  durationSeconds?: number;
}

/**
 * Parse `--duration=<seconds>` out of a free-form video command arg string.
 * The remaining text is treated as the prompt. Invalid duration values are
 * silently dropped (the prompt still runs with the sidecar's default).
 */
export function parseVideoArgs(input: string): ParsedVideoArgs {
  if (!input) return { prompt: "" };
  const tokens = input.split(/\s+/);
  const remaining: string[] = [];
  let durationSeconds: number | undefined;
  for (const token of tokens) {
    const m = /^--duration[=:](\d+)$/i.exec(token);
    if (m && m[1] !== undefined) {
      const value = Number.parseInt(m[1], 10);
      if (Number.isFinite(value) && value > 0 && value <= 60) {
        durationSeconds = value;
        continue;
      }
    }
    remaining.push(token);
  }
  return {
    prompt: remaining.join(" ").trim(),
    ...(durationSeconds ? { durationSeconds } : {}),
  };
}

export async function runVideoCommand(
  args: string,
  deps: VideoCommandDeps,
): Promise<string> {
  const presence = inspectCookieEnv(deps.envSource);
  if (!presence.ready) {
    return "Meta AI video generation requires META_AI_DATR and META_AI_ECTO_1_SESS to be configured. Run /metaai-login for setup.";
  }
  const parsed = parseVideoArgs(args);
  if (!parsed.prompt) {
    return "Usage: /metaai-video <prompt> [--duration=<seconds 1..60>]";
  }
  try {
    const client = await deps.sidecar.ensureRunning();
    const result = await client.video({
      prompt: parsed.prompt,
      durationSeconds: parsed.durationSeconds,
    });
    return `Generated video:\n${result.url}`;
  } catch (err) {
    return `Meta AI video generation failed: ${redactSensitive(toMetaAiError(err).message)}`;
  }
}

export function makeVideoCommand(deps: VideoCommandDeps): OpenClawPluginCommandDefinition {
  return {
    name: "metaai-video",
    description: "Generate a short video with Meta AI. Supports `--duration=<seconds>`.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: CommandHandlerContext) => {
      const text = await runVideoCommand(ctx.args ?? "", deps);
      return { text };
    },
  };
}
