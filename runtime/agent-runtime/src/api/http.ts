import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

export const IdParams = z.object({ id: z.uuid() });

const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

/** Tenant resolution (C6): `x-tenant-id` header, falling back to the configured default. */
export function tenantOf(req: FastifyRequest, defaultTenantId: string): string {
  const header = req.headers['x-tenant-id'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '') return defaultTenantId;
  if (!TENANT_RE.test(value)) throw new HttpError(400, 'invalid_tenant', 'invalid x-tenant-id header');
  return value;
}

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Shallow camelCase -> snake_case for DB rows (JSON payload columns are left untouched). */
export function serialize<T extends Record<string, unknown>>(row: T): Record<string, unknown>;
export function serialize<T extends Record<string, unknown>>(row: T | null | undefined): Record<string, unknown> | null;
export function serialize<T extends Record<string, unknown>>(row: T | null | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[toSnake(k)] = v;
  return out;
}

/** PostgreSQL error code, also when wrapped by drizzle (DrizzleQueryError.cause). */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let i = 0; i < 3 && current && typeof current === 'object'; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_error', message: 'invalid request', issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply
        .status(err.statusCode)
        .send({ error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
    }
    if (pgErrorCode(err) === '23505') {
      return reply.status(409).send({ error: 'conflict', message: 'unique constraint violation' });
    }
    const statusCode = (err as FastifyError).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: 'bad_request', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'internal server error' });
  });
}
