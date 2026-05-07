# Recovering from `Unknown type "RewriteOptionsInput"`

## What this error means

`metaai-api` (the Python FastAPI sidecar this plugin spawns) calls Meta's
`https://www.meta.ai/api/graphql` endpoint using a **persisted query**, i.e.
the request payload only carries:

```json
{ "doc_id": "<32-char hex>", "variables": { ... } }
```

The actual GraphQL operation text (including its variable signature like
`$rewriteOptions: RewriteOptionsInput`) is stored on Meta's edge keyed by
`doc_id`. When Meta evolves their schema and removes an input type, the
**stored** persisted query for an old `doc_id` becomes invalid and the server
responds with:

```
GraphQL error (GRAPHQL_VALIDATION_FAILED): Unknown type "RewriteOptionsInput".
```

This is **not** something we can fix by changing the variables we send. The
operation text — the bit that references `RewriteOptionsInput` — lives in
Meta's persisted-query store. The only durable fix is to use a current
`doc_id` that was minted against the current schema.

This is tracked upstream as
[`mir-ashiq/metaai-api#16`](https://github.com/mir-ashiq/metaai-api/issues/16)
and was reproduced by this plugin against `metaai-sdk` 4.4.0.

The two `doc_id`s that `metaai-api` 4.4.0 falls back to (both are currently
broken on Meta's side):

- `ac0bad4b9787a393e160fb39f43404c1`
- `2f707e4a86f4b01adba97e1376cbdc14`

## Override path supported by this plugin

The sidecar reads three env-vars from `metaai-api`:

| Env var                                    | Position in fallback chain                          |
| ------------------------------------------ | --------------------------------------------------- |
| `META_AI_CHAT_DOC_ID`                      | First — preferred fresh doc_id from your capture.   |
| `META_AI_CHAT_DOC_ID_ALT`                  | Second — optional secondary doc_id.                 |
| `META_AI_CHAT_DOC_ID_UNIFIED_FALLBACK`     | Last — defaults to the unified fallback baked in.   |

This plugin's sidecar wrapper (`src/sidecar.ts`) explicitly forwards these
into the Python child process, so setting them in the environment of
whatever launches the proxy (`metaai-proxy.service`, `npm run dev`, the
OpenClaw host process, etc.) is enough; **no edits to the venv are
required.**

Two related routing fields can be overridden the same way:

- `META_AI_CHAT_ENTRY_POINT` (default `KADABRA__UNKNOWN`)
- `META_AI_CHAT_BRANCH_PATH` (default `0`)

## How to capture a fresh `doc_id` from a browser HAR

You need a logged-in `www.meta.ai` session in a desktop browser.
Cookies, tokens, and HAR contents are sensitive — **do not paste full HARs
into chat or share them publicly.** Extract only the field values listed
below and treat them like passwords.

### Steps

1. Open Chrome / Edge / Firefox and sign in to <https://www.meta.ai>.
2. Open DevTools → **Network** tab.
3. In the network filter, type `graphql`. Make sure "Preserve log" is on.
4. In the chat composer on meta.ai, send a short message like `hi`.
5. Find the request:
   - **Method:** `POST`
   - **URL:** `https://www.meta.ai/api/graphql`
   - **Form data / Payload** contains `fb_api_req_friendly_name` matching
     one of:
     - `useAbraSendMessageMutation`
     - `useAbraSendMessageStreamMutation`
     - `useAbraSendMessageRevampedMutation`
   - **Response** is a streamed `text/event-stream` containing assistant
     deltas (no `errors` array).

   That is the persisted query you want to mirror.

6. From the **Payload** tab, record:
   - `doc_id` → set as `META_AI_CHAT_DOC_ID`.
   - `variables.entryPoint` (e.g. `KADABRA__HOMEPAGE`) → optional, set as
     `META_AI_CHAT_ENTRY_POINT` if it differs from `KADABRA__UNKNOWN`.
   - `variables.currentBranchPath` → optional, set as
     `META_AI_CHAT_BRANCH_PATH`.

7. (Optional but recommended) Capture a **second** working `doc_id` with a
   slightly different friendly name (e.g. the streaming vs non-streaming
   variant) and set it as `META_AI_CHAT_DOC_ID_ALT` so the sidecar has a
   fallback.

### What you do **not** need to share

- `fb_dtsg`, `lsd`, `jazoest` tokens — `metaai-api` mints these per-session.
- Cookie values (`datr`, `abra_sess`, `ecto_1_sess`) — these are already
  configured separately as `META_AI_DATR`, `META_AI_ABRA_SESS`,
  `META_AI_ECTO_1_SESS`.
- The full GraphQL response body.

## Applying the override

For the systemd standalone proxy:

```ini
# /etc/systemd/system/metaai-proxy.service.d/override.conf
[Service]
Environment=META_AI_CHAT_DOC_ID=<32-char hex from your capture>
# Optional:
Environment=META_AI_CHAT_DOC_ID_ALT=<second 32-char hex>
Environment=META_AI_CHAT_ENTRY_POINT=KADABRA__HOMEPAGE
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart metaai-proxy.service
node scripts/metaai-smoke.mjs
```

For an interactive run:

```bash
META_AI_CHAT_DOC_ID=<hex> \
META_AI_DATR=… META_AI_ABRA_SESS=… META_AI_ECTO_1_SESS=… \
node scripts/metaai-proxy-standalone.mjs
```

## Verifying

Run the smoke script:

```bash
node scripts/metaai-smoke.mjs
```

- HTTP 200 with assistant text → success, override is good.
- HTTP 502 + `Unknown type "…Input"` → the new `doc_id` is also stale or
  invalid; recapture from a fresh meta.ai session.
- HTTP 502 + `Authentication failed` → cookies have expired; refresh the
  three cookie env-vars and retry.
