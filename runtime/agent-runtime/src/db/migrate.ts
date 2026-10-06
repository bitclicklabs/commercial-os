import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { createDb, type Db } from './client.js';

/** Folder with drizzle-kit generated SQL; works from src/ (tsx) and dist/ (node). */
export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const config = loadConfig();
  const handle = createDb(config.databaseUrl);
  runMigrations(handle.db)
    .then(() => console.log(`migrations applied from ${MIGRATIONS_FOLDER}`))
    .catch((err: unknown) => {
      console.error('migration failed', err);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
