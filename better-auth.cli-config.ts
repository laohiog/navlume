import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as authSchema from './src/db/auth-schema';
import { type Auth, createAuth } from './src/db/auth';

/**
 * Better Auth CLI configuration — schema generation and first-admin bootstrap.
 *
 * The CLI requires a module exporting a ready auth instance, while the
 * application builds auth explicitly from its composition root
 * (`src/db/auth.ts`). Reusing `createAuth` here guarantees the generated schema
 * and any bootstrapped user always match runtime behavior.
 *
 * Example — create the first administrator:
 *
 *   DATABASE_PATH=data/nav.sqlite \
 *   BETTER_AUTH_SECRET=<real-secret> \
 *     npx auth@1.7.4 create-admin --config better-auth.cli-config.ts \
 *       --email admin@example.com --password '<password>' \
 *       --data '{"username":"admin"}' -y
 *
 * Example — regenerate the Drizzle auth schema:
 *
 *   npx auth@1.7.4 generate --config better-auth.cli-config.ts \
 *     --output src/db/auth-schema.ts --adapter drizzle --dialect sqlite --yes
 *
 * The CLI targets the configured database path so this never falls back to an
 * unrelated file. `BETTER_AUTH_CLI_DATABASE_PATH` overrides it for one-off
 * isolated runs.
 */
const databasePath =
  process.env.BETTER_AUTH_CLI_DATABASE_PATH ?? process.env.DATABASE_PATH ?? 'data/nav.sqlite';

const sqlite = new Database(databasePath);
sqlite.pragma('foreign_keys = ON');

export const auth: Auth = createAuth({
  db: drizzle(sqlite, { schema: authSchema }),
  secret: process.env.BETTER_AUTH_SECRET ?? 'cli-only-secret-not-used-at-runtime',
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
});
