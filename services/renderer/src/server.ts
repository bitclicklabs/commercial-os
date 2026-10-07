/**
 * HTTP API of pxos-renderer (internal network only, no port published to the host).
 *
 * POST /render  { url, wait_ms?, max_chars?, min_text_chars?, wait_until? }
 *               -> 200 { text, title, links[], final_url, status, truncated, render_ms, blocked_requests, hydration_ms, hydrated }
 *               errors -> 4xx/5xx { error: { code, message } }
 * GET  /health  -> 200 { status: 'ok', active, queued }
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RENDER_MAX_CHARS, RENDER_MAX_MIN_TEXT_CHARS, RENDER_MAX_WAIT_MS, RenderError, WAIT_UNTIL, type RenderRequest, type RenderResult } from './render.js';

export interface RenderService {
  render(req: RenderRequest): Promise<RenderResult>;
  readonly stats: { active: number; queued: number };
}

export const RenderBody = z.object({
  url: z.string().min(1).max(2048),
  wait_ms: z.number().int().min(0).max(RENDER_MAX_WAIT_MS).optional(),
  max_chars: z.number().int().min(500).max(RENDER_MAX_CHARS).optional(),
  min_text_chars: z.number().int().min(0).max(RENDER_MAX_MIN_TEXT_CHARS).optional(),
  wait_until: z.enum(WAIT_UNTIL as [string, ...string[]]).optional(),
});

export function buildServer(service: RenderService, opts: { logger?: boolean | object } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024, requestTimeout: 60_000 });

  app.get('/health', async () => ({ status: 'ok', ...service.stats }));

  app.post('/render', async (request, reply) => {
    const parsed = RenderBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
    }
    const started = Date.now();
    try {
      const result = await service.render({
        url: parsed.data.url,
        waitMs: parsed.data.wait_ms,
        maxChars: parsed.data.max_chars,
        minTextChars: parsed.data.min_text_chars,
        waitUntil: parsed.data.wait_until as RenderRequest['waitUntil'],
      });
      request.log.info(
        { host: safeHost(parsed.data.url), ms: Date.now() - started, chars: result.text.length, blocked: result.blocked_requests, hydrated: result.hydrated, hydration_ms: result.hydration_ms },
        'rendered',
      );
      return result;
    } catch (err) {
      if (err instanceof RenderError) {
        request.log.info({ host: safeHost(parsed.data.url), code: err.code, ms: Date.now() - started }, 'render refused or failed');
        return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message } });
      }
      request.log.error({ err }, 'unexpected render error');
      return reply.code(500).send({ error: { code: 'RENDER_FAILED', message: 'unexpected renderer error' } });
    }
  });

  return app;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
