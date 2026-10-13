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
  lanHttp: boolean;
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
  if (env.INSTALL_MODE !== undefined && !['standard', 'lan-http'].includes(env.INSTALL_MODE)) {
    throw new RuntimeConfigError('INSTALL_MODE must be standard or lan-http');
  }
  const lanHttp = env.INSTALL_MODE === 'lan-http';

  const port = parsePort(env.PORT);
  const host = requiredValue(env.HOST) ?? DEFAULT_HOST;
  const authBaseUrl = parseAuthBaseUrl(env.BETTER_AUTH_URL, isProduction);
  if (lanHttp) validateLanOrigin(authBaseUrl);
  if (lanHttp && requiredValue(env.BETTER_AUTH_TRUSTED_ORIGINS) !== undefined) {
    throw new RuntimeConfigError('Additional trusted origins are not supported; configure BETTER_AUTH_URL only');
  }

  const configuredSecret = requiredValue(env.BETTER_AUTH_SECRET);

  if (configuredSecret === undefined && isProduction && !lanHttp) {
    throw new RuntimeConfigError('BETTER_AUTH_SECRET must be set in production');
  }
  // Standard mode retains v0.1.1's non-empty-secret acceptance. Only the explicit
  // LAN mode enforces its stronger key boundary; never rotate a legacy key here.
  if (lanHttp && configuredSecret !== undefined && (configuredSecret.length < 32 || configuredSecret === DEVELOPMENT_AUTH_SECRET)) {
    throw new RuntimeConfigError('lan-http requires BETTER_AUTH_SECRET to contain at least 32 characters and not be the development fallback. For a legacy shorter key, keep standard HTTPS mode with the original key; do not replace it to bypass this check');
  }

  const databasePath = requiredValue(env.DATABASE_PATH) ?? 'data/nav.sqlite';
  const uploadsDir = requiredValue(env.UPLOADS_DIR) ?? 'data/uploads';

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    isProduction,
    lanHttp,
    host,
    port,
    databasePath,
    uploadsDir,
    authSecret: configuredSecret ?? (lanHttp ? '' : DEVELOPMENT_AUTH_SECRET),
    authBaseUrl,
    usingDevelopmentAuthSecret: configuredSecret === undefined && !lanHttp,
  };
}

/** Deliberately accepts canonical RFC1918 IPv4 literals only, never DNS/Host discovery. */
export function validateLanOrigin(raw: string): void {
  const url = new URL(raw);
  const parts = url.hostname.split('.').map(Number);
  const privateIp = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
      || (parts[0] === 192 && parts[1] === 168));
  if (url.protocol !== 'http:' || !privateIp || raw !== url.origin) {
    throw new RuntimeConfigError('lan-http requires BETTER_AUTH_URL to be an exact http:// private RFC1918 IPv4 origin (no path, credentials, query, or fragment)');
  }
}

/** Operator-facing warning text for the development fallback secret. */
export const DEVELOPMENT_SECRET_WARNING =
  'BETTER_AUTH_SECRET is not set; using an insecure development-only fallback.';
