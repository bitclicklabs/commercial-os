import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import type { Db } from '../../src/db/client.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

/** Requests that are rejected before touching the database: no DB needed. */
describe('API validation (no database)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const unreachableDb = new Proxy({} as Db, {
      get() {
        throw new Error('database must not be touched in this test');
      },
    });
    app = await buildServer({
      db: unreachableDb,
      queue: new MemoryRunQueue(),
      config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an invalid task body with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/tasks', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });

  it('rejects non-uuid ids with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/executions/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed tenant headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/agents', headers: { 'x-tenant-id': 'bad tenant!' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_tenant' });
  });

  it('exposes no DELETE routes', async () => {
    for (const url of ['/tasks/6f1c2a0e-1111-4c2b-9a8e-0a0b0c0d0e0f', '/agents/6f1c2a0e-1111-4c2b-9a8e-0a0b0c0d0e0f']) {
      const res = await app.inject({ method: 'DELETE', url });
      expect(res.statusCode).toBe(404);
    }
  });

  it('answers 501 for endpoints pending later MVPs', async () => {
    const id = '6f1c2a0e-1111-4c2b-9a8e-0a0b0c0d0e0f';
    expect((await app.inject({ method: 'POST', url: `/agents/${id}/promote` })).statusCode).toBe(501);
    expect((await app.inject({ method: 'POST', url: `/executions/${id}/pause` })).statusCode).toBe(501);
  });
});
