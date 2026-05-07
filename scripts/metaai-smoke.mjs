#!/usr/bin/env node
/**
 * Smoke test for the standalone Meta AI proxy.
 *
 * Sends one OpenAI-compatible chat completion request to the local proxy and
 * prints status + body so you can see whether the upstream Meta GraphQL chat
 * call succeeded, failed with a transport/auth error, or failed with a
 * GraphQL persisted-query schema mismatch (the well-known
 * `Unknown type "RewriteOptionsInput"` symptom — see
 * docs/META_AI_DOC_ID_RECOVERY.md).
 *
 * Cookies and access tokens are never read or printed by this script.
 *
 * Usage:
 *   node scripts/metaai-smoke.mjs
 *   META_AI_PROXY_URL=http://127.0.0.1:18795 node scripts/metaai-smoke.mjs
 *   META_AI_SMOKE_MODEL=metaai/muse-spark node scripts/metaai-smoke.mjs
 */

const baseUrl = (process.env.META_AI_PROXY_URL || 'http://127.0.0.1:18795').replace(/\/$/, '');
const model = process.env.META_AI_SMOKE_MODEL || 'metaai/muse-spark';
const prompt = process.env.META_AI_SMOKE_PROMPT || 'Reply with exactly OK.';

function log(label, value) {
  console.log(`[metaai-smoke] ${label}: ${value}`);
}

async function probeHealth() {
  const url = `${baseUrl}/healthz`;
  const res = await fetch(url);
  const body = await res.text();
  log('GET ' + url, `${res.status} ${body.slice(0, 200)}`);
  return res.ok;
}

async function probeChat() {
  const url = `${baseUrl}/v1/chat/completions`;
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const elapsed = Date.now() - started;
  log('POST ' + url, `HTTP ${res.status} in ${elapsed}ms`);
  log('payload', JSON.stringify(payload));
  // Truncate to avoid dumping huge payloads
  const trimmed = text.length > 4000 ? text.slice(0, 4000) + '…[truncated]' : text;
  console.log(trimmed);

  // Heuristic: surface the well-known persisted-query schema-drift symptom
  if (text.includes('RewriteOptionsInput') || text.includes('GRAPHQL_VALIDATION_FAILED')) {
    log('diagnosis', 'Upstream Meta GraphQL persisted-query schema drift detected.');
    log('next-step', 'Capture a fresh chat doc_id from a logged-in www.meta.ai browser session and set META_AI_CHAT_DOC_ID. See docs/META_AI_DOC_ID_RECOVERY.md');
    process.exitCode = 2;
    return;
  }
  if (!res.ok) {
    process.exitCode = 1;
  }
}

(async () => {
  log('baseUrl', baseUrl);
  log('model', model);
  try {
    const healthy = await probeHealth();
    if (!healthy) {
      log('error', 'Proxy /healthz returned non-2xx; is metaai-proxy.service running?');
      process.exit(1);
    }
    await probeChat();
  } catch (err) {
    log('fatal', err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();
