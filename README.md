# openclaw-metaai-auth

Native [OpenClaw](https://github.com/openclaw/openclaw) provider plugin for Meta AI
(Muse Spark / Llama family), backed by the
[`mir-ashiq/metaai-api`](https://github.com/mir-ashiq/metaai-api) Python
FastAPI sidecar.

The plugin gives OpenClaw three native capabilities:

| Capability | How it surfaces |
| --- | --- |
| Chat / model provider | OpenClaw provider id `metaai` (default `metaai/muse-spark`) routed through an in-process OpenAI-compatible proxy. |
| Image generation | `/metaai-image <prompt> [--orientation=...]` chat command. |
| Video generation | `/metaai-video <prompt> [--duration=<seconds>]` chat command. |

A guided login walkthrough and a redacted status view are also wired up:

- `/metaai-login` — explains how to extract Meta AI cookies and validates them
  against the sidecar without ever echoing values.
- `/metaai-status` — prints the cookie / sidecar / proxy state at a glance.

## Architecture in one paragraph

1. The plugin lazily spawns a Python `metaai-api` server (`uvicorn metaai_api.api_server:app`) bound to **127.0.0.1** on a random port.
2. A small in-process Node HTTP server (`OpenAiCompatProxy`) listens on a second loopback port and translates between the OpenAI Chat Completions schema (which OpenClaw routes via `api: "openai-completions"`) and metaai-api's `/chat` endpoint.
3. OpenClaw's model registry sees a normal OpenAI-compatible provider with `baseUrl: http://127.0.0.1:<proxy-port>/v1`, so existing OpenAI-compat agents work with no plugin-specific code paths.
4. Cookies are read from `process.env` (which OpenClaw populates from its secret store) and forwarded only to the metaai-api child process. Cookies are never written to plugin config, never echoed in logs, and never persisted by this plugin.

## Provider / model IDs exposed

| Id | Notes |
| --- | --- |
| `metaai/muse-spark` | **Default**, canonical Muse Spark backend. |
| `metaai/meta-ai`    | Alias → routes through the same chat backend. |
| `metaai/llama`      | Alias → routes through the same chat backend (server-side routing). |
| `metaai/llama-3`    | Alias → routes through the same chat backend (server-side routing). |

> Meta AI's public web endpoints do **not** expose explicit model selection.
> All four ids resolve to the same upstream chat call; Meta decides the
> backend model server-side. The labels are preserved through the proxy as
> descriptive names so OpenClaw routing/logging stays consistent.

## Installation

This plugin requires:

- **OpenClaw** ≥ `2026.2.0` (peer dependency `openclaw` providing the
  `plugin-sdk` exports used here).
- **Node.js** ≥ 22.
- **Python** ≥ 3.10 with `metaai-sdk[api]` available on the same machine
  (the plugin spawns a sidecar via `python3 -m uvicorn metaai_api.api_server:app`).

Install once on the host that runs OpenClaw:

```bash
# Plugin
npm install --save openclaw-metaai-auth

# Python sidecar runtime — recommended target: a project-local venv
python3 -m pip install --user "metaai-sdk[api]"
# or, if you maintain a dedicated venv for OpenClaw:
#   python3 -m venv /opt/openclaw/venv && /opt/openclaw/venv/bin/pip install "metaai-sdk[api]"
```

Then load the plugin from your OpenClaw config (the `openclaw` field in
`package.json` already points at the entry; refer to OpenClaw docs for
loading external plugins).

> The plugin does **not** vendor or require its own copy of the
> `mir-ashiq/metaai-api` source. It uses it as an external runtime
> dependency — see "Pinning a specific version" below if you need to lock
> down a commit.

## Configuration

Plugin config keys (all optional) — see `openclaw.plugin.json` for the JSON
schema. Cookie values must **not** be set here; they belong in OpenClaw's
secret store.

```jsonc
{
  "metaai": {
    "defaultModel": "metaai/muse-spark",
    "allowedModels": ["metaai/muse-spark", "metaai/meta-ai"],
    "sidecar": {
      "pythonBin": "/opt/openclaw/venv/bin/python",
      "host": "127.0.0.1",
      "port": 0,
      "openAiProxyPort": 0,
      "idleShutdownMs": 300000,
      "startupTimeoutMs": 30000,
      "requestTimeoutMs": 60000,
      "extraEnv": {
        "METAAI_DEBUG": "1"
      }
    }
  }
}
```

The `host` field is locked to a loopback host (`127.0.0.1`, `::1`, or
`localhost`); any other value causes the plugin to refuse to start.

## How to obtain Meta AI cookies

Meta AI uses **browser cookies** for authentication, not API keys. To set the
plugin up:

1. Sign in to <https://meta.ai> in a regular browser session.
2. Open DevTools → Application → Cookies → `meta.ai`.
3. Copy these cookie values:
   - `datr` (required)
   - `xs` or `ecto_1_sess` (required — Meta has used both names; the value
     in the `xs` cookie is what the metaai-api sidecar reads as
     `META_AI_ECTO_1_SESS`)
   - `abra_sess` (optional — secondary session cookie used by some Meta
     properties)
4. Store them in OpenClaw's secret store under these env-var names, **not**
   in plugin config:

   | Env var | Required | Purpose |
   | --- | --- | --- |
   | `META_AI_DATR` | yes | Browser device tracking cookie. |
   | `META_AI_ECTO_1_SESS` | yes | Meta AI session cookie (sometimes also named `xs`). |
   | `META_AI_ABRA_SESS` | no | Optional secondary session cookie. |

5. Restart OpenClaw so the plugin picks up the new env values.

Run `/metaai-login` from any OpenClaw channel to see this guide and trigger
a live health check that does not echo cookie values.

## Examples

### Chat (OpenAI-compatible client)

Every OpenClaw consumer that already speaks the OpenAI Chat Completions API
can use Meta AI by selecting one of the plugin's model ids:

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "<your OpenClaw gateway>/v1",
  apiKey: "<gateway key>",
});

const response = await openai.chat.completions.create({
  model: "metaai/muse-spark", // or metaai/meta-ai, metaai/llama, metaai/llama-3
  messages: [
    { role: "system", content: "Be terse." },
    { role: "user", content: "Summarise the OpenClaw plugin SDK in one sentence." },
  ],
});

console.log(response.choices[0].message.content);
```

### Image generation

```text
/metaai-image a watercolour of a coastal village at sunset --orientation=landscape
```

Returns:

```text
Generated 1 image:
https://meta.ai/.../generated.png
```

### Video generation

```text
/metaai-video a slow zoom across a coral reef --duration=5
```

Returns the resulting video URL produced by the sidecar.

## Testing

Mocked unit tests run with no live cookies and no Python interpreter — the
suite stubs out `fetch`, `spawn`, and the metaai-api client.

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run build
```

Tests that **would** require live Meta AI cookies are intentionally not
present in this repo — they would be flaky against Meta's anti-automation
defences and would risk leaking real cookies into CI logs.

If you want to run an end-to-end smoke test locally:

1. Install `metaai-sdk[api]` in a venv as described above.
2. Export `META_AI_DATR`, `META_AI_ECTO_1_SESS`, and (optionally)
   `META_AI_ABRA_SESS` in the same shell.
3. Use OpenClaw's plugin loader to point at this package, then call
   `/metaai-status` and a tiny chat completion against `metaai/muse-spark`.

## Pinning a specific version of `mir-ashiq/metaai-api`

If upstream changes break compatibility, pin a known-good commit at install
time instead of forking:

```bash
python3 -m pip install --user \
  "metaai-sdk[api] @ git+https://github.com/mir-ashiq/metaai-api@<commit-sha>"
```

## Limitations and risks

- **Cookie auth is fragile.** Meta rotates `xs`/`ecto_1_sess` aggressively; expect
  to re-extract cookies periodically. Long-lived sessions can be invalidated
  silently — `/metaai-status` will surface a degraded sidecar in that case.
- **ToS sensitivity.** Meta AI's web frontend is not a public API. Using it
  programmatically is governed by Meta's Terms of Service, which prohibit
  automated access in many jurisdictions. You are responsible for ensuring
  your usage is compliant. See `SECURITY.md` for a longer note.
- **Model selection is best-effort.** As called out above, the alias table
  is semantic only — Meta picks the actual backend.
- **Streaming chat is approximate.** When `stream: true` is requested, the
  proxy emits a single delta chunk plus a `[DONE]` terminator instead of
  token-by-token streaming, because metaai-api currently exposes a JSON
  `/chat` endpoint, not SSE. Token timing therefore won't match what an
  OpenAI client sees from a real OpenAI server.
- **Image/video timings are slow.** Image generation typically takes ~2
  minutes and video generation 40–60 seconds; OpenClaw's command timeouts
  may need adjustment.
- **No multi-tenant cookie pool.** Cookies are read from a single set of
  env vars per process. If you need different identities per OpenClaw user,
  run a separate OpenClaw instance per identity.

## License

[MIT](./LICENSE)
