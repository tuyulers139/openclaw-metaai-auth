import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Derived from OpenClawPluginApi to avoid reaching into internal SDK paths.
type OpenClawPluginCommandDefinition = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type CommandHandlerContext = Parameters<OpenClawPluginCommandDefinition["handler"]>[0];

import { inspectCookieEnv } from "../cookies.js";
import { toMetaAiError } from "../errors.js";
import { redactSensitive } from "../redact.js";
import type { MetaAiSidecar } from "../sidecar.js";

export interface ImageCommandDeps {
  sidecar: MetaAiSidecar;
  envSource?: Readonly<Record<string, string | undefined>>;
}

const KNOWN_ORIENTATIONS: ReadonlySet<string> = new Set(["square", "portrait", "landscape"]);

interface ParsedImageArgs {
  prompt: string;
  orientation?: "square" | "portrait" | "landscape";
}

/**
 * Parse `--orientation=<value>` flags out of a free-form image command arg
 * string, returning the remaining text as the prompt. Unknown flags are
 * preserved in the prompt verbatim — this is meant to be lenient.
 */
export function parseImageArgs(input: string): ParsedImageArgs {
  if (!input) return { prompt: "" };
  const tokens = input.split(/\s+/);
  const remaining: string[] = [];
  let orientation: ParsedImageArgs["orientation"];
  for (const token of tokens) {
    const orient = matchOrientationFlag(token);
    if (orient) {
      orientation = orient;
      continue;
    }
    remaining.push(token);
  }
  return {
    prompt: remaining.join(" ").trim(),
    ...(orientation ? { orientation } : {}),
  };
}

function matchOrientationFlag(token: string): ParsedImageArgs["orientation"] | undefined {
  const m = /^--orientation[=:](\w+)$/i.exec(token);
  if (!m || m[1] === undefined) return undefined;
  const value = m[1].toLowerCase();
  if (KNOWN_ORIENTATIONS.has(value)) return value as ParsedImageArgs["orientation"];
  return undefined;
}

export async function runImageCommand(
  args: string,
  deps: ImageCommandDeps,
): Promise<string> {
  const presence = inspectCookieEnv(deps.envSource);
  if (!presence.ready) {
    return "Meta AI image generation requires META_AI_DATR and META_AI_ECTO_1_SESS to be configured. Run /metaai-login for setup.";
  }
  const parsed = parseImageArgs(args);
  if (!parsed.prompt) {
    return "Usage: /metaai-image <prompt> [--orientation=square|portrait|landscape]";
  }
  try {
    const client = await deps.sidecar.ensureRunning();
    const result = await client.image({ prompt: parsed.prompt, orientation: parsed.orientation });
    if (result.urls.length === 1) {
      return `Generated 1 image:\n${result.urls[0]}`;
    }
    return `Generated ${result.urls.length} images:\n${result.urls.join("\n")}`;
  } catch (err) {
    return `Meta AI image generation failed: ${redactSensitive(toMetaAiError(err).message)}`;
  }
}

export function makeImageCommand(deps: ImageCommandDeps): OpenClawPluginCommandDefinition {
  return {
    name: "metaai-image",
    description: "Generate an image with Meta AI. Supports `--orientation=square|portrait|landscape`.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: CommandHandlerContext) => {
      const text = await runImageCommand(ctx.args ?? "", deps);
      return { text };
    },
  };
}
