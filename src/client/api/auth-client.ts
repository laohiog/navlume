import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';

/**
 * Same-origin Better Auth browser client.
 *
 * No explicit `baseURL` is passed: the client defaults to the current origin and
 * Better Auth's `basePath` is `/api/auth`, matching the server. This keeps the
 * deployment same-origin and avoids hard-coding a host.
 *
 * The username plugin is mirrored with `displayUsername: false`, matching
 * `src/db/auth.ts`, so inferred user/session types line up with the server.
 */
export const authClient = createAuthClient({
  plugins: [usernameClient({ displayUsername: false })],
});

export type AuthClient = typeof authClient;
