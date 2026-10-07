/**
 * pxos-renderer entry point.
 *
 * HOST / PORT: 127.0.0.1:4030 by default (pnpm dev on a workstation). The container
 * sets HOST=0.0.0.0 PORT=3000 and publishes NO port: only pxos-net reaches it.
 * Host policy: FETCH_URL_ALLOWLIST / FETCH_URL_DENYLIST / FETCH_URL_ALLOWED_PORTS, the
 * same variables (and rules) as the runtime's fetch_url.
 */
import type { FastifyInstance } from 'fastify';
import { Renderer } from './render.js';
import { buildServer } from './server.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4030);
const maxConcurrency = Math.max(1, Math.min(2, Number(process.env.RENDER_MAX_CONCURRENCY ?? 2) || 2));

let server: FastifyInstance | null = null;
const renderer = new Renderer({ maxConcurrency, log: (msg, meta) => server?.log.info(meta ?? {}, msg) });
server = buildServer(renderer, { logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const shutdown = async (signal: string) => {
  server?.log.info({ signal }, 'shutting down');
  await server?.close().catch(() => undefined);
  await renderer.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await server.listen({ host, port });
server.log.info({ host, port, maxConcurrency }, 'pxos-renderer listening');
