/**
 * Redaction helpers — never log raw cookie values, access tokens, or full
 * Cookie/Authorization headers. Always run user-supplied strings through
 * {@link redactSensitive} before passing to a logger.
 *
 * The masking style mirrors openclaw-antigravity-auth's redaction posture:
 * Bearer/refresh tokens are masked; cookie values are masked while keeping
 * the cookie *name* visible so operators can confirm presence.
 */

const MASK = "[REDACTED]";

/** Names of cookies that this plugin treats as sensitive. */
export const SENSITIVE_COOKIE_NAMES = [
  "datr",
  "ecto_1_sess",
  "abra_sess",
  "META_AI_DATR",
  "META_AI_ECTO_1_SESS",
  "META_AI_ABRA_SESS",
] as const;

// Match cookie pairs whose name is at a word boundary so we catch cookies
// preceded by any non-word character (start-of-string, `;`, `,`, whitespace,
// quote, paren, etc.). The value runs until the next delimiter we expect to
// see in either raw cookie headers ("a=b; datr=...") or free-form log lines
// ("Cookie: datr=..." / 'sidecar 500: "datr=..."').
const COOKIE_PAIR_RE = new RegExp(
  `(\\b(?:${SENSITIVE_COOKIE_NAMES.join("|")})\\s*=)([^;\\s,"']+)`,
  "gi",
);

const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._\-+/=]{8,})/g;
const ACCESS_TOKEN_RE = /("?access_token"?\s*[:=]\s*"?)([A-Za-z0-9._\-+/=]{8,})/g;
const REFRESH_TOKEN_RE = /("?refresh_token"?\s*[:=]\s*"?)([A-Za-z0-9._\-+/=]{8,})/g;
const FB_DTSG_RE = /("?fb_dtsg"?\s*[:=]\s*"?)([A-Za-z0-9._\-+/=:]{4,})/g;

/**
 * Replace any sensitive substrings in `input` with a fixed mask. Safe to call
 * on arbitrary log strings; non-sensitive content is returned unchanged.
 */
export function redactSensitive(input: string): string {
  if (!input) return input;
  return input
    .replace(COOKIE_PAIR_RE, (_match, prefix: string) => `${prefix}${MASK}`)
    .replace(BEARER_RE, (_match, prefix: string) => `${prefix}${MASK}`)
    .replace(ACCESS_TOKEN_RE, (_match, prefix: string) => `${prefix}${MASK}"`)
    .replace(REFRESH_TOKEN_RE, (_match, prefix: string) => `${prefix}${MASK}"`)
    .replace(FB_DTSG_RE, (_match, prefix: string) => `${prefix}${MASK}"`);
}

/**
 * Returns a value-redacted view of an env-style key/value map. The keys are
 * preserved verbatim; values for sensitive keys are replaced with a fixed
 * mask, and non-sensitive values are passed through {@link redactSensitive}.
 */
export function redactEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(env)) {
    if (rawValue === undefined) continue;
    const upper = key.toUpperCase();
    const sensitive =
      upper.startsWith("META_AI_") ||
      upper.endsWith("_TOKEN") ||
      upper.endsWith("_SECRET") ||
      upper.endsWith("_KEY") ||
      upper.includes("COOKIE") ||
      upper.includes("PASSWORD");
    out[key] = sensitive ? MASK : redactSensitive(rawValue);
  }
  return out;
}

/**
 * Mask used by {@link redactSensitive}. Exported for tests and downstream
 * helpers that want consistent masking.
 */
export const REDACTION_MASK = MASK;
