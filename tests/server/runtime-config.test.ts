import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PORT,
  DEVELOPMENT_AUTH_SECRET,
  DEVELOPMENT_CLIENT_ORIGIN,
  RuntimeConfigError,
  parseAuthBaseUrl,
  parsePort,
  resolveRuntimeConfig,
} from '../../src/server/runtime-config.js';

/** Production-like environment with every required value present. */
function productionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: 'a-production-secret-value-that-is-long-enough',
    BETTER_AUTH_URL: 'https://nav.example.com',
    ...overrides,
  };
}

describe('development configuration', () => {
  it('falls back to the development auth secret and client origin', () => {
    const config = resolveRuntimeConfig({});

    expect(config.isProduction).toBe(false);
    expect(config.usingDevelopmentAuthSecret).toBe(true);
    expect(config.authSecret).toBe(DEVELOPMENT_AUTH_SECRET);
    expect(config.authBaseUrl).toBe(DEVELOPMENT_CLIENT_ORIGIN);
  });

  it('uses the development defaults for port and paths', () => {
    const config = resolveRuntimeConfig({});

    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe('0.0.0.0');
    expect(config.databasePath).toBe('data/nav.sqlite');
    expect(config.uploadsDir).toBe('data/uploads');
  });
});

describe('production configuration', () => {
  it('preserves v0.1.1 acceptance of every non-empty configured standard secret', () => {
    for (const secret of ['x', 's'.repeat(31), DEVELOPMENT_AUTH_SECRET]) {
      const implicit = resolveRuntimeConfig(productionEnv({ BETTER_AUTH_SECRET: secret }));
      const explicit = resolveRuntimeConfig(productionEnv({ BETTER_AUTH_SECRET: secret, INSTALL_MODE: 'standard' }));
      expect(implicit.authSecret).toBe(secret);
      expect(explicit.authSecret).toBe(secret);
      expect(explicit.usingDevelopmentAuthSecret).toBe(false);
    }
  });
  it('accepts a complete production environment', () => {
    const config = resolveRuntimeConfig(productionEnv());

    expect(config.isProduction).toBe(true);
    expect(config.usingDevelopmentAuthSecret).toBe(false);
    expect(config.authBaseUrl).toBe('https://nav.example.com');
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it('requires BETTER_AUTH_SECRET', () => {
    expect(() => resolveRuntimeConfig(productionEnv({ BETTER_AUTH_SECRET: '' }))).toThrow(
      RuntimeConfigError,
    );
    expect(() => resolveRuntimeConfig(productionEnv({ BETTER_AUTH_SECRET: '   ' }))).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('requires BETTER_AUTH_URL', () => {
    expect(() => resolveRuntimeConfig(productionEnv({ BETTER_AUTH_URL: '' }))).toThrow(
      RuntimeConfigError,
    );
  });

  it('rejects a malformed BETTER_AUTH_URL', () => {
    expect(() => resolveRuntimeConfig(productionEnv({ BETTER_AUTH_URL: 'not a url' }))).toThrow(
      /valid absolute URL/,
    );
  });

  it('rejects an unsupported URL scheme', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com']) {
      expect(() => resolveRuntimeConfig(productionEnv({ BETTER_AUTH_URL: url }))).toThrow(
        /http:\/\/ or https:\/\//,
      );
    }
  });

  it('accepts both http and https origins', () => {
    expect(resolveRuntimeConfig(productionEnv({ BETTER_AUTH_URL: 'http://localhost:3000' })).authBaseUrl).toBe(
      'http://localhost:3000',
    );
    expect(resolveRuntimeConfig(productionEnv({ BETTER_AUTH_URL: 'https://nav.example.com' })).authBaseUrl).toBe(
      'https://nav.example.com',
    );
  });
});

describe('port validation', () => {
  it('defaults when unset', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
  });

  it('accepts valid ports', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects non-numeric input rather than yielding NaN', () => {
    for (const value of ['abc', '3000abc', '3000.5', '-1', '0x10']) {
      expect(() => parsePort(value)).toThrow(RuntimeConfigError);
    }
  });

  it('rejects out-of-range ports', () => {
    expect(() => parsePort('0')).toThrow(/between 1 and 65535/);
    expect(() => parsePort('65536')).toThrow(/between 1 and 65535/);
  });
});

describe('auth base URL parsing', () => {
  it('falls back to the development origin when unset outside production', () => {
    expect(parseAuthBaseUrl(undefined, false)).toBe(DEVELOPMENT_CLIENT_ORIGIN);
  });

  it('requires a value in production', () => {
    expect(() => parseAuthBaseUrl(undefined, true)).toThrow(/BETTER_AUTH_URL/);
  });
});

describe('configuration validation does not require a database', () => {
  it('validates and returns configuration without opening SQLite', () => {
    // The module only reads the supplied environment; no filesystem or database
    // access occurs, which is what lets startup fail closed before creating a DB.
    const config = resolveRuntimeConfig(productionEnv({ DATABASE_PATH: '/data/nav.sqlite' }));

    expect(config.databasePath).toBe('/data/nav.sqlite');
  });

  it('resolves Docker-style persistent paths verbatim', () => {
    const config = resolveRuntimeConfig(
      productionEnv({ DATABASE_PATH: '/data/nav.sqlite', UPLOADS_DIR: '/data/uploads' }),
    );

    expect(config.databasePath).toBe('/data/nav.sqlite');
    expect(config.uploadsDir).toBe('/data/uploads');
  });
});
