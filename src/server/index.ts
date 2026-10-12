/**
 * Production/dev server entry point (P6.3).
 *
 * Startup order is deliberate:
 *
 *   1. resolve and validate the runtime configuration;
 *   2. apply pending Drizzle migrations;
 *   3. open the application database;
 *   4. begin listening.
 *
 * Validation runs before the database is opened, so a misconfigured production
 * deployment exits without creating a stray SQLite file on a fresh volume.
 */

import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { createAuth } from '../db/auth.js';
import { createDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createApp } from './app.js';
import {
  DEVELOPMENT_SECRET_WARNING,
  RuntimeConfigError,
  resolveRuntimeConfig,
  type RuntimeConfig,
} from './runtime-config.js';

/**
 * Built client directory shipped alongside the compiled server.
 *
 * Resolved relative to this module so it works from any working directory inside
 * the container. `dist/server/server/index.js` → `dist/client`.
 */
const STATIC_ROOT = fileURLToPath(new URL('../../client', import.meta.url));

/**
 * Apply pending migrations, then open the database.
 *
 * Migrations must succeed before the server starts: serving traffic against a
 * partially migrated schema is worse than failing to start. `runMigrations` uses
 * Drizzle's migration tracking, so a restart is a no-op once migrations are
 * applied.
 */
function openMigratedDatabase(config: RuntimeConfig) {
  // The migration CLI and the application share `createDatabase`, which creates the
  // parent directory when needed — required on a brand-new persistent volume.
  const migrationHandle = createDatabase(config.databasePath);

  try {
    runMigrations(migrationHandle);
  } finally {
    migrationHandle.close();
  }

  return createDatabase(config.databasePath);
}

function main(): void {
  let config: RuntimeConfig;

  try {
    config = resolveRuntimeConfig();
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      // Operator-facing, intentional: a misconfigured deployment must fail closed
      // with a clear message rather than a stack trace.
      console.error(`[config] ${error.message}`);
      process.exitCode = 1;
      return;
    }

    throw error;
  }

  if (config.usingDevelopmentAuthSecret) {
    console.warn(`[auth] ${DEVELOPMENT_SECRET_WARNING}`);
  }

  console.log(`[db] applying migrations to ${config.databasePath}`);

  const database = openMigratedDatabase(config);

  const auth = createAuth({
    db: database.db,
    secret: config.authSecret,
    baseURL: config.authBaseUrl,
    // Production always issues Secure cookies regardless of the configured origin,
    // so a TLS-terminating proxy in front of plain HTTP inside the container
    // cannot silently downgrade cookie security. Development leaves the option
    // unset, preserving Better Auth's existing origin-derived behaviour.
    ...(config.isProduction ? { useSecureCookies: true } : {}),
  });

  // Static serving is enabled for the production runtime. In development the Vite
  // dev server owns the client and proxies `/api` to this process, so serving a
  // stale `dist/client` here would be misleading.
  const app = createApp({
    db: database.db,
    auth,
    ...(config.isProduction ? { staticRoot: STATIC_ROOT } : {}),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    // Report the real bind address rather than claiming localhost when the server
    // is bound to another interface.
    console.log(`[server] listening on http://${config.host}:${info.port}`);
  });

  /**
   * Graceful shutdown.
   *
   * `docker compose stop` sends SIGTERM; closing the HTTP server first lets
   * in-flight requests finish before the SQLite connection is released.
   */
  function shutdown(signal: string): void {
    console.log(`[server] ${signal} received, shutting down`);

    server.close(() => {
      database.close();
      process.exit(0);
    });
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

main();
