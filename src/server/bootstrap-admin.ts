/**
 * One-shot first administrator bootstrap (P6.3).
 *
 * A brand-new deployment has no administrator, and the product deliberately has no
 * public sign-up. This is the explicit operator action that creates the first
 * admin, after which ordinary users are created through the Admin UI.
 *
 * Credentials come from one-shot environment variables rather than Compose
 * configuration, so the password never becomes persistent deployment state:
 *
 *     BOOTSTRAP_ADMIN_USERNAME
 *     BOOTSTRAP_ADMIN_EMAIL
 *     BOOTSTRAP_ADMIN_PASSWORD
 *     BOOTSTRAP_ADMIN_NAME
 *
 * Password handling is entirely Better Auth's: this calls `auth.api.createUser`,
 * so hashing, credential-account creation, and the user schema stay owned by the
 * existing Auth implementation. No manual hashing and no direct credential writes.
 */

import { pathToFileURL } from 'node:url';

import { createAuth, type Auth } from '../db/auth.js';
import { createDatabase, type DatabaseHandle } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { user } from '../db/auth-schema.js';
import { resolveAuthSecret } from './auth-secret.js';
import { isInitializationClosed, markInitializationComplete } from './setup-state.js';
import {
  RuntimeConfigError,
  resolveRuntimeConfig,
  type RuntimeConfig,
} from './runtime-config.js';

export interface BootstrapAdminInput {
  username: string;
  email: string;
  password: string;
  name: string;
}

export type BootstrapResult =
  | { status: 'created'; userId: string; username: string }
  | { status: 'refused'; message: string }
  | { status: 'failed'; message: string };

/** Shortest password accepted here; delegated to Better Auth beyond this check. */
const MINIMUM_PASSWORD_LENGTH = 8;

/**
 * Read the bootstrap credentials from the environment.
 *
 * Returns a concise reason when anything required is missing or obviously invalid,
 * so the operator gets an actionable message without a stack trace.
 */
export function readBootstrapInput(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; input: BootstrapAdminInput } | { ok: false; message: string } {
  const username = env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = env.BOOTSTRAP_ADMIN_NAME?.trim();

  const missing: string[] = [];

  if (username === undefined || username.length === 0) missing.push('BOOTSTRAP_ADMIN_USERNAME');
  if (email === undefined || email.length === 0) missing.push('BOOTSTRAP_ADMIN_EMAIL');
  if (password === undefined || password.length === 0) missing.push('BOOTSTRAP_ADMIN_PASSWORD');

  if (missing.length > 0) {
    return { ok: false, message: `missing required environment variable(s): ${missing.join(', ')}` };
  }

  // Deliberately not validating email shape beyond "present": Better Auth owns
  // credential validation, and duplicating its rules here would drift.
  if (password!.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `BOOTSTRAP_ADMIN_PASSWORD must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters`,
    };
  }

  return {
    ok: true,
    input: {
      username: username!,
      email: email!,
      password: password!,
      // Fall back to the username so the operator does not have to supply a
      // display name for a minimal bootstrap.
      name: name !== undefined && name.length > 0 ? name : username!,
    },
  };
}

/**
 * Create the first administrator.
 *
 * Refuses after provisioning, independently of subsequent user deletion.
 */
export async function bootstrapAdmin(
  handle: DatabaseHandle,
  input: BootstrapAdminInput,
  authSecret: string,
  authBaseUrl: string,
): Promise<BootstrapResult> {
  const auth = createAuth({ db: handle.db, secret: authSecret, baseURL: authBaseUrl });
  return createFirstAdministrator(handle, auth, input, false);
}

const activeCreations = new WeakSet<DatabaseHandle['sqlite']>();

/** SQLite owns the check/create boundary, including a CLI in another process.
 * Keep the transaction open across Better Auth's asynchronous password hashing:
 * a credential failure must roll back the user too. Same-connection callers are
 * refused before entering the transaction rather than joining its uncommitted state.
 */
export async function createFirstAdministrator(
  handle: DatabaseHandle,
  auth: Auth,
  input: BootstrapAdminInput,
  requireEmpty: boolean,
): Promise<BootstrapResult> {
  if (activeCreations.has(handle.sqlite)) {
    return { status: 'refused', message: 'administrator initialization is already in progress' };
  }
  activeCreations.add(handle.sqlite);
  let began = false;
  try {
    handle.sqlite.exec('BEGIN IMMEDIATE');
    began = true;
    const hasUsers = handle.db.select({ id: user.id }).from(user).limit(1).get() !== undefined;
    const closed = isInitializationClosed(handle);
    if (closed || (requireEmpty && hasUsers)) {
      // Commit adoption of an older instance's existing users before refusing.
      handle.sqlite.exec('COMMIT');
      began = false;
      return {
        status: 'refused',
        message: 'instance already provisioned; refusing to create another bootstrap admin (administrator already exists or users present)',
      };
    }
    const created = await auth.api.createUser({
      body: {
        email: input.email,
        password: input.password,
        name: input.name,
        role: 'admin',
        data: { username: input.username, emailVerified: true },
      },
    });
    markInitializationComplete(handle);
    handle.sqlite.exec('COMMIT');
    began = false;
    return { status: 'created', userId: created.user.id, username: input.username };
  } catch {
    if (began) handle.sqlite.exec('ROLLBACK');
    return { status: 'failed', message: 'failed to create administrator; check input and database availability' };
  } finally {
    activeCreations.delete(handle.sqlite);
  }
}

/**
 * Run the bootstrap command, applying pending migrations first so a brand-new
 * volume can be provisioned in a single operator step.
 */
export async function runBootstrapAdmin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let config: RuntimeConfig;

  try {
    config = resolveRuntimeConfig(env);
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      console.error(`[bootstrap] ${error.message}`);
      return 1;
    }

    throw error;
  }

  const parsed = readBootstrapInput(env);

  if (!parsed.ok) {
    console.error(`[bootstrap] ${parsed.message}`);
    return 1;
  }

  const handle = createDatabase(config.databasePath);

  try {
    runMigrations(handle);

    const secret = resolveAuthSecret(config, isInitializationClosed(handle));
    const result = await bootstrapAdmin(handle, parsed.input, secret, config.authBaseUrl);

    if (result.status === 'refused') {
      console.error(`[bootstrap] ${result.message}`);
      return 1;
    }

    if (result.status === 'failed') {
      console.error(`[bootstrap] ${result.message}`);
      return 1;
    }

    console.log(`[bootstrap] created administrator "${result.username}"`);
    return 0;
  } finally {
    handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runBootstrapAdmin();
}
