import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin, username } from 'better-auth/plugins';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as authSchema from './auth-schema.js';
import * as schema from './schema.js';

type Db = BetterSQLite3Database<typeof schema>;

/** Standard Better Auth roles. No custom role architecture is introduced. */
export type AppRole = 'admin' | 'user';

export interface CreateAuthOptions {
  db: Db;
  /** Better Auth signing secret. Required; never falls back to a production default. */
  secret: string;
  /** Public base URL of the deployment, e.g. `http://localhost:3000`. */
  baseURL: string;
  /**
   * Force the `Secure` attribute on authentication cookies.
   *
   * Better Auth otherwise derives this from `baseURL`: an `https://` origin gets
   * secure cookies, and an `http://` origin does not. That derivation is wrong for
   * a production deployment reachable over plain HTTP behind a TLS-terminating
   * proxy, and it would allow a production-mode instance to issue cookies without
   * `Secure`.
   *
   * The production runtime passes `true` so the requirement is explicit rather
   * than inferred from the origin. Development leaves it unset, preserving the
   * existing local-HTTP behaviour.
   */
  useSecureCookies?: boolean;
}

/**
 * Build a Better Auth instance bound to the shared SQLite/Drizzle connection.
 *
 * No import-time side effects: nothing is opened, migrated, or seeded here.
 */
export function createAuth({ db, secret, baseURL, useSecureCookies }: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: authSchema,
    }),
    secret,
    baseURL,
    // Same-origin contract: the Hono app mounts Better Auth at /api/auth/*.
    basePath: '/api/auth',
    advanced: {
      // Only set when explicitly requested, so an omitted value keeps Better
      // Auth's own secure-cookie derivation for the development origin.
      ...(useSecureCookies === undefined ? {} : { useSecureCookies }),
    },
    // Paths are relative to basePath. Admin impersonation is not a product
    // capability: administrators access only their own personal navigation.
    disabledPaths: ['/is-username-available', '/admin/impersonate-user'],
    emailAndPassword: {
      enabled: true,
      // The product provisions accounts through an administrator only.
      // There is no public sign-up.
      disableSignUp: true,
    },
    rateLimit: {
      // Explicit, as required. Default in-memory storage is correct for this
      // single-process MVP; no Redis or rate-limit table is introduced.
      enabled: true,
    },
    plugins: [
      username({
        // `name` already carries the display name for this product.
        displayUsername: false,
      }),
      admin({
        defaultRole: 'user',
        adminRoles: ['admin'],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
