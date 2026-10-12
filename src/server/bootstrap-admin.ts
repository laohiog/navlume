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

import { count, eq } from 'drizzle-orm';

import { createAuth } from '../db/auth.js';
import { createDatabase, type DatabaseHandle } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { user } from '../db/auth-schema.js';
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

/** Number of users holding the admin role. */
function countAdmins(handle: DatabaseHandle): number {
  const rows = handle.db.select({ total: count() }).from(user).where(eq(user.role, 'admin')).all();

  return rows[0]?.total ?? 0;
}

/**
 * Create the first administrator.
 *
 * Refuses when an administrator already exists, so the command cannot quietly add
 * a second bootstrap admin on a redeployed or already-provisioned instance.
 */
export async function bootstrapAdmin(
  handle: DatabaseHandle,
  input: BootstrapAdminInput,
  authSecret: string,
  authBaseUrl: string,
): Promise<BootstrapResult> {
  if (countAdmins(handle) > 0) {
    return {
      status: 'refused',
      message: 'an administrator already exists; refusing to create another bootstrap admin',
    };
  }

  const auth = createAuth({ db: handle.db, secret: authSecret, baseURL: authBaseUrl });

  try {
    const created = await auth.api.createUser({
      body: {
        email: input.email,
        password: input.password,
        name: input.name,
        role: 'admin',
        data: { username: input.username, emailVerified: true },
      },
    });

    return { status: 'created', userId: created.user.id, username: input.username };
  } catch (error) {
    // Never echo the password or the full Better Auth error payload; the operator
    // needs to know it failed and why in general terms.
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', message: `failed to create administrator: ${message.slice(0, 200)}` };
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

    const result = await bootstrapAdmin(handle, parsed.input, config.authSecret, config.authBaseUrl);

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
