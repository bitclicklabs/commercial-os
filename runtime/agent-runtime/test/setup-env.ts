/**
 * Vitest setup: loads runtime/agent-runtime/.env (gitignored) if it exists, without
 * overriding variables already set in the environment. This is how the Twenty
 * integration tests get TWENTY_API_KEY / TWENTY_BASE_URL locally.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envPath)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, 'utf8')))) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}
