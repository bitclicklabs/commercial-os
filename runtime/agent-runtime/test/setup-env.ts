/**
 * Vitest setup: loads runtime/agent-runtime/.env (gitignored) if it exists, without
 * overriding variables already set in the environment. This is how the Twenty
 * integration tests get TWENTY_API_KEY / TWENTY_BASE_URL locally.
 *
 * It also installs the shared-database guard (helpers/shared-db-guard.ts): every test file,
 * unit or integration, refuses PostgreSQL connections to the database `agentos`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { installSharedDbGuard } from './helpers/shared-db-guard.js';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envPath)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, 'utf8')))) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}

// Hermetic unit tests: without an explicit RENDERER_URL (env or .env), render_url is
// "not configured" instead of trying to reach http://pxos-renderer:3000.
process.env.RENDERER_URL ??= 'off';

// Hermetic Prospector tests (tanda 20): the suites script the StubProvider answers one by one, so
// the domain resolver (one extra grounded call per relevant exhibitor without a domain) is off
// unless a test turns it on (ProspectorAgentDeps.domainResolver / DOMAIN_RESOLVER_ENABLED).
process.env.DOMAIN_RESOLVER_ENABLED ??= 'false';

// Shared-database guard (incident 2026-10-12): no test may connect to the database named
// `agentos` (the DATABASE_URL default) unless ALLOW_SHARED_TEST_DB=1. Installed after the .env
// load on purpose: a DATABASE_URL coming from .env is checked too. See helpers/shared-db-guard.ts.
installSharedDbGuard(pg);
