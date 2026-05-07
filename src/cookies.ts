import { authError } from "./errors.js";

/**
 * Required cookie names for Meta AI auth, normalised to environment-variable
 * style. The plugin reads these from `process.env` (which OpenClaw populates
 * from its secret store at plugin-load time) — never from plugin config.
 */
export const META_AI_DATR = "META_AI_DATR";
export const META_AI_ECTO_1_SESS = "META_AI_ECTO_1_SESS";
export const META_AI_ABRA_SESS = "META_AI_ABRA_SESS";

export const REQUIRED_COOKIE_ENV_VARS = [META_AI_DATR, META_AI_ECTO_1_SESS] as const;
export const OPTIONAL_COOKIE_ENV_VARS = [META_AI_ABRA_SESS] as const;
export const ALL_COOKIE_ENV_VARS = [
  ...REQUIRED_COOKIE_ENV_VARS,
  ...OPTIONAL_COOKIE_ENV_VARS,
] as const;

export interface MetaAiCookies {
  /** Required: Meta browser device tracking cookie. */
  datr: string;
  /** Required: Meta AI session cookie. */
  ectoSess: string;
  /** Optional: secondary Meta session cookie. Empty string if not configured. */
  abraSess: string;
}

export interface CookiePresence {
  datr: boolean;
  ectoSess: boolean;
  abraSess: boolean;
  /** Whether the required (datr + ectoSess) cookies are both present. */
  ready: boolean;
}

/**
 * Inspect the supplied env (defaults to `process.env`) to determine which
 * Meta AI cookies are configured, *without* exposing their values. Useful for
 * health checks, login wizards, and debug output.
 */
export function inspectCookieEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CookiePresence {
  const datr = Boolean(env[META_AI_DATR]?.trim());
  const ectoSess = Boolean(env[META_AI_ECTO_1_SESS]?.trim());
  const abraSess = Boolean(env[META_AI_ABRA_SESS]?.trim());
  return {
    datr,
    ectoSess,
    abraSess,
    ready: datr && ectoSess,
  };
}

/**
 * Read Meta AI cookies from the supplied env. Throws a typed auth error if
 * any required cookie is missing. Cookie values are not logged or echoed —
 * the returned object is intended only for direct use in HTTP requests.
 */
export function readCookiesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MetaAiCookies {
  const datr = env[META_AI_DATR]?.trim() ?? "";
  const ectoSess = env[META_AI_ECTO_1_SESS]?.trim() ?? "";
  const abraSess = env[META_AI_ABRA_SESS]?.trim() ?? "";

  const missing: string[] = [];
  if (!datr) missing.push(META_AI_DATR);
  if (!ectoSess) missing.push(META_AI_ECTO_1_SESS);

  if (missing.length > 0) {
    throw authError(
      `Meta AI cookies are not configured: missing ${missing.join(", ")}. ` +
        `Set them via OpenClaw secrets or environment variables.`,
      { missing },
    );
  }

  return { datr, ectoSess, abraSess };
}

/**
 * Build the subset of environment variables that the metaai-api sidecar
 * needs. Intentionally returns ONLY the cookie env-vars so callers can
 * pass them to a child process without leaking unrelated ambient secrets.
 */
export function buildSidecarCookieEnv(cookies: MetaAiCookies): Record<string, string> {
  const env: Record<string, string> = {
    [META_AI_DATR]: cookies.datr,
    [META_AI_ECTO_1_SESS]: cookies.ectoSess,
  };
  if (cookies.abraSess) env[META_AI_ABRA_SESS] = cookies.abraSess;
  return env;
}
