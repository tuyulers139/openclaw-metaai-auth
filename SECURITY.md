# Security notes

This plugin authenticates against Meta AI using **browser session cookies**.
That has serious implications you must understand before deploying it.

## Threat model

- Meta AI cookies (`datr`, `xs` / `ecto_1_sess`, `abra_sess`) are equivalent
  to a logged-in browser session for the underlying Meta account. Anyone
  who obtains them can read and act in chats associated with that account
  until the session expires.
- This plugin treats those cookies as **secrets at rest, in transit, and in
  logs**. Treat them at least as carefully as a password — never paste
  them into shared chat channels, never commit them to source control,
  and never set them as repo-level CI secrets unless absolutely required.

## Plugin guarantees

- Cookies are read from `process.env` (populated by OpenClaw's secret store)
  and forwarded **only** to the spawned `metaai-api` child process. They
  are not written to plugin config, JSON state, or any persistent file by
  this plugin.
- The `metaai-api` sidecar binds to `127.0.0.1` (or another loopback host)
  only. The plugin refuses to launch the sidecar against any non-loopback
  host. The accompanying OpenAI-compatible proxy applies the same
  restriction.
- All log output passes through `redactSensitive()`, which masks `datr` /
  `ecto_1_sess` / `abra_sess` cookie pairs, `Bearer` tokens,
  `access_token` / `refresh_token` JSON values, and `fb_dtsg` anti-CSRF
  tokens before reaching the OpenClaw logger.
- The child-process environment is built from a **small allowlist** plus
  the cookie env-vars. Unrelated ambient secrets (e.g. AWS keys, other
  API tokens in the parent process) are not inherited.
- Errors thrown by the plugin are wrapped in a typed `MetaAiError` whose
  `message` field is pre-redacted, so they are safe to surface in chat
  command output.

## Operational guidance

- Store cookies in OpenClaw's organisational secret store with the env-var
  names listed in `README.md`. Avoid putting them on a developer laptop's
  `.env` file unchecked into a personal vault.
- Periodically rotate the cookies (Meta does too, asynchronously). When
  `/metaai-status` reports `DEGRADED`, refresh the cookies and restart the
  OpenClaw process.
- If cookies leak, sign out of `meta.ai` in the source browser session
  immediately. That invalidates the session-bound cookies (notably
  `xs`/`ecto_1_sess`). Then issue new cookies and update OpenClaw secrets.
- Do **not** expose the `metaai-api` sidecar or the OpenAI-compatible
  proxy to the public internet — there is no per-tenant authentication on
  those endpoints. They are intentionally loopback-only.

## Terms of Service note

`meta.ai` is Meta's product surface and is not advertised as a public API.
Using its web endpoints from automation may violate Meta's Terms of Service
or local computer-misuse statutes depending on jurisdiction. This plugin is
provided for **interoperability research and personal use** only. You are
responsible for ensuring your deployment is compliant with Meta's ToS, your
employer's policies, and applicable law. The maintainers of this plugin
provide no warranty and accept no liability for ToS-related consequences.

## Reporting a vulnerability

Open a GitHub issue marked `security:` describing the impact, steps to
reproduce, and any cookie-leak vector. Please **do not** include actual
cookie values in the report — provide a sanitised reproduction or a
redacted log excerpt. The maintainers will respond within a reasonable
window and coordinate disclosure as appropriate.
