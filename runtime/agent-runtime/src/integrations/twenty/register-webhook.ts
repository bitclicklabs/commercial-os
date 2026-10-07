/**
 * `pnpm register:webhook [--url <targetUrl>] [--operations a,b] [--pause] [--dry-run]`
 *
 * Creates or updates (idempotent) the Twenty webhook that feeds the HUMAN evaluator.
 * Uses the metadata REST API of Twenty 2.45 (`/rest/metadata/webhooks`). The webhook is
 * identified by its description marker, so re-running updates it in place.
 *
 * - Default target: http://pxos-runtime:4020/webhooks/twenty (the runtime as seen from the
 *   Twenty containers on pxos-net). For a runtime on the host use
 *   --url http://host.docker.internal:<port>/webhooks/twenty.
 * - The secret (TWENTY_WEBHOOK_SECRET) is stored as the webhook `secret`: Twenty signs each
 *   delivery with it (HMAC). It is never put in the URL (Twenty logs target URLs).
 * - Twenty has no "active" flag: --pause sets `operations` to [] so no event matches.
 *   Nothing is ever deleted.
 *
 * Twenty blocks private targets (SSRF guard) unless the host is listed in
 * OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS on the Twenty server and worker.
 */
import { parseArgs } from 'node:util';

export const WEBHOOK_MARKER = 'pxos-runtime:human-feedback';
export const DEFAULT_WEBHOOK_URL = 'http://pxos-runtime:4020/webhooks/twenty';
export const DEFAULT_OPERATIONS = ['commercialHypothesis.updated'];

export interface TwentyWebhook {
  id: string;
  targetUrl: string;
  operations: string[];
  description?: string | null;
  secret?: string | null;
}

export interface RegisterOptions {
  baseUrl: string;
  apiKey: string;
  secret: string;
  targetUrl: string;
  operations: string[];
  dryRun?: boolean;
  fetch?: typeof fetch;
}

export type RegisterResult = { action: 'created' | 'updated' | 'unchanged' | 'dry-run'; webhook: Omit<TwentyWebhook, 'secret'> | null };

/** Accepts both envelopes of the metadata list (`data: [...]` or `data: { webhooks: [...] }`). */
export function extractWebhooks(json: unknown): TwentyWebhook[] {
  if (Array.isArray(json)) return json as TwentyWebhook[];
  const data = (json as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data as TwentyWebhook[];
  const nested = (data as { webhooks?: unknown } | null)?.webhooks;
  return Array.isArray(nested) ? (nested as TwentyWebhook[]) : [];
}

function extractOne(json: unknown): TwentyWebhook {
  const data = (json as { data?: unknown } | null)?.data ?? json;
  if (data && typeof data === 'object' && 'id' in data) return data as TwentyWebhook;
  const inner = data && typeof data === 'object' ? Object.values(data as Record<string, unknown>)[0] : undefined;
  if (inner && typeof inner === 'object' && 'id' in inner) return inner as TwentyWebhook;
  throw new Error('unexpected webhook response from Twenty');
}

const redact = (w: TwentyWebhook): Omit<TwentyWebhook, 'secret'> => {
  const { secret: _secret, ...rest } = w;
  return rest;
};

export async function registerWebhook(opts: RegisterOptions): Promise<RegisterResult> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/rest/metadata/webhooks`;
  const headers = { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const call = async (url: string, init: RequestInit = {}) => {
    const res = await f(url, { ...init, headers, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twenty ${init.method ?? 'GET'} ${url} failed with ${res.status}: ${text.slice(0, 300)}`);
    return text.length > 0 ? (JSON.parse(text) as unknown) : null;
  };

  const all = extractWebhooks(await call(`${base}?limit=200`));
  const existing = all.find((w) => (w.description ?? '').includes(WEBHOOK_MARKER));
  const desired = {
    targetUrl: opts.targetUrl,
    operations: opts.operations,
    description: `${WEBHOOK_MARKER} (evaluador HUMAN, gestionado por pnpm register:webhook)`,
    secret: opts.secret,
  };
  if (!existing) {
    if (opts.dryRun) return { action: 'dry-run', webhook: null };
    return { action: 'created', webhook: redact(extractOne(await call(base, { method: 'POST', body: JSON.stringify(desired) }))) };
  }
  const same =
    existing.targetUrl === desired.targetUrl &&
    JSON.stringify(existing.operations ?? []) === JSON.stringify(desired.operations) &&
    existing.description === desired.description &&
    (existing.secret === undefined || existing.secret === desired.secret);
  if (same) return { action: 'unchanged', webhook: redact(existing) };
  if (opts.dryRun) return { action: 'dry-run', webhook: redact(existing) };
  const updated = extractOne(await call(`${base}/${existing.id}`, { method: 'PATCH', body: JSON.stringify(desired) }));
  return { action: 'updated', webhook: redact(updated) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      operations: { type: 'string' },
      pause: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const apiKey = process.env.TWENTY_API_KEY;
  const secret = process.env.TWENTY_WEBHOOK_SECRET;
  if (!apiKey) throw new Error('TWENTY_API_KEY is not set');
  if (!secret || secret.length < 16) throw new Error('TWENTY_WEBHOOK_SECRET is not set (min 16 characters)');
  const operations = values.pause
    ? []
    : values.operations
      ? values.operations.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_OPERATIONS;
  const result = await registerWebhook({
    baseUrl: process.env.TWENTY_BASE_URL || 'http://localhost:3020',
    apiKey,
    secret,
    targetUrl: values.url ?? process.env.TWENTY_WEBHOOK_TARGET_URL ?? DEFAULT_WEBHOOK_URL,
    operations,
    dryRun: values['dry-run'],
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly = process.argv[1] !== undefined && /register-webhook\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
