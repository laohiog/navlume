import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

/** Repository-local development database path, used when `DATABASE_PATH` is unset. */
export const DEFAULT_DATABASE_PATH = 'data/nav.sqlite';

/**
 * Resolve the SQLite file location.
 *
 * Docker deployments set `DATABASE_PATH=/data/nav.sqlite`; local development
 * falls back to a repository-local file. No environment framework is used.
 */
export function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_DATABASE_PATH;
}

export interface DatabaseHandle {
  /** Drizzle query interface bound to the P1 schema. */
  db: BetterSQLite3Database<typeof schema>;
  /** Raw better-sqlite3 connection, used for PRAGMA inspection and close(). */
  sqlite: Database.Database;
  close(): void;
}

const IN_MEMORY_PATHS = new Set([':memory:', 'file::memory:']);

/**
 * Open a SQLite database and enable foreign-key enforcement.
 *
 * Deliberately a factory with no import-time side effects: importing this module
 * never creates, opens, or migrates a database.
 */
export function createDatabase(databasePath: string = resolveDatabasePath()): DatabaseHandle {
  if (!IN_MEMORY_PATHS.has(databasePath)) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath);

  // SQLite foreign keys are per-connection; declare them here so enforcement
  // does not depend on a build-time compile option or a default we do not own.
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close(): void {
      sqlite.close();
    },
  };
}
