#!/usr/bin/env node
import { OpenAiCompatProxy } from '../dist/openai-proxy.js';
import { MetaAiSidecar } from '../dist/sidecar.js';

const host = process.env.META_AI_PROXY_HOST || '127.0.0.1';
const openAiProxyPort = Number(process.env.META_AI_OPENAI_PROXY_PORT || '18795');
const sidecarPortRaw = process.env.META_AI_SIDECAR_PORT;
const sidecarPort = sidecarPortRaw ? Number(sidecarPortRaw) : undefined;
const pythonBin = process.env.META_AI_PYTHON_BIN || '/home/ubuntu/.openclaw/workspace/openclaw-metaai-auth/.venv/bin/python';

const logger = {
  info: (msg) => console.log(new Date().toISOString(), '[metaai-standalone]', msg),
  warn: (msg) => console.warn(new Date().toISOString(), '[metaai-standalone]', msg),
  error: (msg) => console.error(new Date().toISOString(), '[metaai-standalone]', msg),
  debug: (msg) => {
    if (process.env.META_AI_DEBUG === '1') console.log(new Date().toISOString(), '[metaai-standalone:debug]', msg);
  },
};

const sidecar = new MetaAiSidecar({
  pythonBin,
  host,
  port: Number.isFinite(sidecarPort) ? sidecarPort : undefined,
  idleShutdownMs: Number(process.env.META_AI_IDLE_SHUTDOWN_MS || '300000'),
  startupTimeoutMs: Number(process.env.META_AI_STARTUP_TIMEOUT_MS || '45000'),
  requestTimeoutMs: Number(process.env.META_AI_REQUEST_TIMEOUT_MS || '90000'),
  logger,
});

const proxy = new OpenAiCompatProxy({
  host,
  port: openAiProxyPort,
  logger,
  clientFactory: () => sidecar.ensureRunning(),
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`received ${signal}; stopping`);
  try { await proxy.close(); } catch (err) { logger.warn(`proxy close failed: ${err?.message || err}`); }
  try { await sidecar.stop(); } catch (err) { logger.warn(`sidecar stop failed: ${err?.message || err}`); }
  process.exit(0);
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error(`uncaught exception: ${err?.stack || err}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logger.error(`unhandled rejection: ${err?.stack || err}`);
  process.exit(1);
});

const binding = await proxy.listen();
logger.info(`OpenAI-compatible proxy listening at ${binding.baseUrl}`);
logger.info('MetaAI Python sidecar will start lazily on first chat/image/video request.');
