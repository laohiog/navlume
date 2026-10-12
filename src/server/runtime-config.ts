/**
 * Production runtime configuration resolution and validation (P6.3).
 *
 * Resolved and validated **before** the SQLite database is opened or created, so a
 * misconfigured deployment fails closed without leaving a stray database file
 * behind on a fresh volume.
 *
 * Pure and side-effect free apart from reading the supplied environment, so the
 * whole validation surface is unit-testable without starting a server or touching
 * the filesystem.
 */

/** Development fallbacks, mirroring the long-standing behaviour of the server. */
export const DEVELOPMENT_AUTH_SECRET = 'development-only-insecure-secret-do-not-use-in-production';
export const DEVELOPMENT_CLIENT_ORIGIN = 'http://localhost:5173';
export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = '0.0.0.0';

export interface RuntimeConfig {
  nodeEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  databasePath: string;
  uploadsDir: string;
  authSecret: string;
  authBaseUrl: string;
  /** True when the development fallback secret is in use; logged loudly. */
  usingDevelopmentAuthSecret: boolean;
}

/** Raised for configuration that must stop startup. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

/** Read a trimmed, non-empty value, or `undefined`. */
function requiredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate a port.
 *
 * An invalid value must be rejected rather than silently becoming `NaN`, because
 * `Number('abc')` is `NaN` and a server bound to `NaN` reports misleading state.
 */
export function parsePort(value: string | undefined): number {
  const raw = requiredValue(value);

  if (raw === undefined) {
    return DEFAULT_PORT;
  }

  // Reject non-integer spellings such as `3000.5`, `0x10`, or ` 3000 ` handled
  // above by trimming.
  if (!/^\d+$/.test(raw)) {
    throw new RuntimeConfigError(`PORT must be an integer between 1 and 65535 (received "${raw}")`);
  }

  const port = Number(raw);

  if (port < 1 || port > 65535) {
    throw new RuntimeConfigError(`PORT must be between 1 and 65535 (received "${raw}")`);
  }

  return port;
}

/**
 * Validate the browser-visible origin.
 *
 * Only http/https are accepted: this value becomes Better Auth's trusted origin,
 * so `javascript:` or `file:` must never be accepted.
 */
export function parseAuthBaseUrl(value: string | undefined, isProduction: boolean): string {
  const raw = requiredValue(value);

  if (raw === undefined) {
    if (isProduction) {
      throw new RuntimeConfigError('BETTER_AUTH_URL must be set in production');
    }

    return DEVELOPMENT_CLIENT_ORIGIN;
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new RuntimeConfigError(`BETTER_AUTH_URL must be a valid absolute URL (received "${raw}")`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RuntimeConfigError(
      `BETTER_AUTH_URL must use http:// or https:// (received "${raw}")`,
    );
  }

  return raw;
}

/**
 * Resolve and validate the runtime configuration.
 *
 * Throws `RuntimeConfigError` for anything that must prevent startup.
 */
export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const isProduction = env.NODE_ENV === 'production';

  const port = parsePort(env.PORT);
  const host = requiredValue(env.HOST) ?? DEFAULT_HOST;
  const authBaseUrl = parseAuthBaseUrl(env.BETTER_AUTH_URL, isProduction);

  const configuredSecret = requiredValue(env.BETTER_AUTH_SECRET);

  if (configuredSecret === undefined && isProduction) {
    throw new RuntimeConfigError('BETTER_AUTH_SECRET must be set in production');
  }

  const databasePath = requiredValue(env.DATABASE_PATH) ?? 'data/nav.sqlite';
  const uploadsDir = requiredValue(env.UPLOADS_DIR) ?? 'data/uploads';

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    isProduction,
    host,
    port,
    databasePath,
    uploadsDir,
    authSecret: configuredSecret ?? DEVELOPMENT_AUTH_SECRET,
    authBaseUrl,
    usingDevelopmentAuthSecret: configuredSecret === undefined,
  };
}

/** Operator-facing warning text for the development fallback secret. */
export const DEVELOPMENT_SECRET_WARNING =
  'BETTER_AUTH_SECRET is not set; using an insecure development-only fallback.';
