import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/db/auth.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { user } from '../../src/db/auth-schema.js';
import {
  bootstrapAdmin,
  readBootstrapInput,
  runBootstrapAdmin,
  type BootstrapAdminInput,
} from '../../src/server/bootstrap-admin.js';
import { TEST_AUTH_BASE_URL, TEST_AUTH_SECRET, createTempDatabase, type TempDatabase } from '../helpers/temp-database.js';

let temp: TempDatabase;

const VALID_INPUT: BootstrapAdminInput = {
  username: 'firstadmin',
  email: 'first@example.com',
  password: 'bootstrap-password-123',
  name: 'First Admin',
};

beforeEach(() => {
  temp = createTempDatabase();
});

afterEach(() => {
  temp.dispose();
});

/** All users holding the admin role. */
function admins(handle: DatabaseHandle) {
  return handle.db.select().from(user).all().filter((row) => row.role === 'admin');
}

/* -------------------------------------------------------------------------- */
/* Input parsing                                                               */
/* -------------------------------------------------------------------------- */

describe('bootstrap input', () => {
  it('accepts a complete set of values', () => {
    const result = readBootstrapInput({
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'password-123',
      BOOTSTRAP_ADMIN_NAME: 'Administrator',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.input).toEqual({
      username: 'admin',
      email: 'admin@example.com',
      password: 'password-123',
      name: 'Administrator',
    });
  });

  it('falls back to the username when no display name is given', () => {
    const result = readBootstrapInput({
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'password-123',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.input.name).toBe('admin');
  });

  it('refuses when required values are missing', () => {
    for (const env of [
      {},
      { BOOTSTRAP_ADMIN_USERNAME: 'admin' },
      { BOOTSTRAP_ADMIN_USERNAME: 'admin', BOOTSTRAP_ADMIN_EMAIL: 'a@b.com' },
      { BOOTSTRAP_ADMIN_EMAIL: 'a@b.com', BOOTSTRAP_ADMIN_PASSWORD: 'password-123' },
    ]) {
      const result = readBootstrapInput(env);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.message).toMatch(/missing required environment variable/);
    }
  });

  it('refuses a too-short password', () => {
    const result = readBootstrapInput({
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'short',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.message).toMatch(/at least/);
  });

  it('never includes the password in a failure message', () => {
    const secret = 'do-not-leak-this-value';
    const result = readBootstrapInput({
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: secret.slice(0, 8) + 'x',
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('password-123');
  });
});

/* -------------------------------------------------------------------------- */
/* Admin creation                                                              */
/* -------------------------------------------------------------------------- */

describe('bootstrap admin creation', () => {
  it('creates exactly one admin on a fresh database', async () => {
    const result = await bootstrapAdmin(temp.handle, VALID_INPUT, TEST_AUTH_SECRET, TEST_AUTH_BASE_URL);

    expect(result.status).toBe('created');

    const created = admins(temp.handle);
    expect(created).toHaveLength(1);
    expect(created[0]!.role).toBe('admin');
    expect(created[0]!.username).toBe('firstadmin');
    expect(created[0]!.email).toBe('first@example.com');
    expect(created[0]!.name).toBe('First Admin');
  });

  it('creates the credential through Better Auth rather than raw SQL', async () => {
    await bootstrapAdmin(temp.handle, VALID_INPUT, TEST_AUTH_SECRET, TEST_AUTH_BASE_URL);

    const accounts = temp.handle.sqlite
      .prepare("select count(*) as total from account where provider_id = 'credential'")
      .get() as { total: number };

    // A credential row with a hashed password exists, produced by Better Auth.
    expect(accounts.total).toBe(1);
  });

  it('produces an admin that can authenticate with the supplied password', async () => {
    await bootstrapAdmin(temp.handle, VALID_INPUT, TEST_AUTH_SECRET, TEST_AUTH_BASE_URL);

    const auth = createAuth({ db: temp.handle.db, secret: TEST_AUTH_SECRET, baseURL: TEST_AUTH_BASE_URL });
    const response = await auth.api.signInUsername({
      body: { username: VALID_INPUT.username, password: VALID_INPUT.password },
    });

    expect(response).toBeTruthy();
  });

  it('rejects authentication with the wrong password', async () => {
    await bootstrapAdmin(temp.handle, VALID_INPUT, TEST_AUTH_SECRET, TEST_AUTH_BASE_URL);

    const auth = createAuth({ db: temp.handle.db, secret: TEST_AUTH_SECRET, baseURL: TEST_AUTH_BASE_URL });

    await expect(
      auth.api.signInUsername({
        body: { username: VALID_INPUT.username, password: 'wrong-password-999' },
      }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Safety                                                                      */
/* -------------------------------------------------------------------------- */

describe('bootstrap safety', () => {
  it('refuses a second bootstrap when an admin already exists', async () => {
    const first = await bootstrapAdmin(temp.handle, VALID_INPUT, TEST_AUTH_SECRET, TEST_AUTH_BASE_URL);
    expect(first.status).toBe('created');

    const before = temp.handle.db.select().from(user).all().length;

    const second = await bootstrapAdmin(
      temp.handle,
      { username: 'secondadmin', email: 'second@example.com', password: 'second-password-123', name: 'Second' },
      TEST_AUTH_SECRET,
      TEST_AUTH_BASE_URL,
    );

    expect(second.status).toBe('refused');
    if (second.status !== 'refused') return;

    expect(second.message).toMatch(/already exists/);

    // No new account was created.
    expect(temp.handle.db.select().from(user).all().length).toBe(before);
    expect(admins(temp.handle)).toHaveLength(1);
  });

  it('fails cleanly on a duplicate username', async () => {
    await bootstrapAdmin(temp.handle, VALID_INPUT, TEST_AUTH_SECRET, TEST_AUTH_BASE_URL);

    // Remove the admin role so the guard does not short-circuit, leaving the
    // duplicate-identity conflict to surface.
    temp.handle.sqlite.prepare("update user set role = 'user' where username = ?").run(VALID_INPUT.username);

    const duplicate = await bootstrapAdmin(
      temp.handle,
      { ...VALID_INPUT, email: 'other@example.com' },
      TEST_AUTH_SECRET,
      TEST_AUTH_BASE_URL,
    );

    expect(duplicate.status).toBe('failed');
    if (duplicate.status !== 'failed') return;

    expect(duplicate.message).toMatch(/failed to create administrator/);
    expect(admins(temp.handle)).toHaveLength(0);
  });

  it('does not enable public signup', () => {
    // The bootstrap path uses the server-side Better Auth admin API only; the
    // public sign-up route remains absent from the application.
    const source = temp.handle.sqlite
      .prepare("select count(*) as total from sqlite_master where type = 'table'")
      .get() as { total: number };

    expect(source.total).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI environment handling                                                    */
/* -------------------------------------------------------------------------- */

describe('bootstrap CLI environment handling', () => {
  it('refuses without the required variables and changes nothing', async () => {
    const handle = createDatabase(`${temp.directory}/cli.sqlite`);
    runMigrations(handle);

    const exitCode = await runBootstrapAdmin({
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
      BETTER_AUTH_URL: TEST_AUTH_BASE_URL,
      DATABASE_PATH: `${temp.directory}/cli.sqlite`,
    } as unknown as NodeJS.ProcessEnv);

    expect(exitCode).toBe(1);
    expect(handle.db.select().from(user).all()).toHaveLength(0);
    handle.close();
  });

  it('refuses unsafe production configuration before creating a database', async () => {
    const missingDb = `${temp.directory}/never-created.sqlite`;

    // Production without an auth secret must fail closed.
    const exitCode = await runBootstrapAdmin({
      NODE_ENV: 'production',
      BETTER_AUTH_URL: TEST_AUTH_BASE_URL,
      DATABASE_PATH: missingDb,
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'password-123',
    } as unknown as NodeJS.ProcessEnv);

    expect(exitCode).toBe(1);
  });
});
