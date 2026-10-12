import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuth, type Auth } from '../../src/db/auth.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';

/** Deterministic test secret. Long enough for Better Auth; never used in production. */
export const TEST_AUTH_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
export const TEST_AUTH_BASE_URL = 'http://localhost:3000';

export interface TempDatabase {
  handle: DatabaseHandle;
  auth: Auth;
  /** The isolated temp directory holding this database; safe for test fixtures. */
  directory: string;
  dispose(): void;
}

/**
 * Create an isolated, migrated SQLite database with its own auth instance.
 *
 * Tests must never touch the development database at `data/nav.sqlite`.
 */
/**
 * Create an isolated, migrated SQLite database with its own auth instance.
 *
 * Tests must never touch the development database at `data/nav.sqlite`.
 *
 * @param options.baseURL - Override the auth base URL (e.g. an HTTPS origin to
 *   exercise secure-cookie behavior). Defaults to `TEST_AUTH_BASE_URL`.
 * @param options.useSecureCookies - Force the `Secure` cookie attribute, as the
 *   production runtime does. Omitted by default so tests keep the
 *   origin-derived behavior.
 */
export function createTempDatabase(
  options: { baseURL?: string; useSecureCookies?: boolean } = {},
): TempDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'bnp-api-'));
  const handle = createDatabase(join(directory, 'test.sqlite'));
  runMigrations(handle);

  const auth = createAuth({
    db: handle.db,
    secret: TEST_AUTH_SECRET,
    baseURL: options.baseURL ?? TEST_AUTH_BASE_URL,
    ...(options.useSecureCookies === undefined
      ? {}
      : { useSecureCookies: options.useSecureCookies }),
  });

  return {
    handle,
    auth,
    directory,
    dispose(): void {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
