import { fileURLToPath, pathToFileURL } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { createDatabase, type DatabaseHandle } from './index.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Apply pending Drizzle migrations to an open database.
 *
 * Drizzle records applied migrations in `__drizzle_migrations`, so repeated runs
 * are safe: already-applied migrations are skipped rather than re-executed.
 */
export function runMigrations(handle: DatabaseHandle, migrationsFolder = MIGRATIONS_FOLDER): void {
  migrate(handle.db, { migrationsFolder });
}

/**
 * CLI entry point: `npm run db:migrate`.
 *
 * Opens the configured database (or a path given as the first argument),
 * applies migrations, and closes the connection.
 */
function main(): void {
  const databasePath = process.argv[2];
  const handle = databasePath === undefined ? createDatabase() : createDatabase(databasePath);

  try {
    runMigrations(handle);
    console.log(`[db] migrations applied to ${databasePath ?? 'configured database path'}`);
  } finally {
    handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
