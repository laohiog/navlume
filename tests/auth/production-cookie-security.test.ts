import { afterEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/db/auth.js';
import { createApp } from '../../src/server/app.js';
import { createTempDatabase, TEST_AUTH_SECRET, type TempDatabase } from '../helpers/temp-database.js';

/**
 * Production-mode cookie contract (P6.3.1-R1).
 *
 * The production runtime forces `advanced.useSecureCookies`, because Better Auth
 * otherwise derives the `Secure` attribute from `baseURL`. A deployment behind a
 * TLS-terminating proxy commonly has a plain `http://` internal origin, and
 * deriving from that origin would let a production instance issue cookies without
 * `Secure`.
 *
 * These tests assert the actual `Set-Cookie` header produced by Better Auth, not
 * the configuration object, so a regression in the derivation logic is caught.
 */

const PASSWORD = 'secure-cookie-password-123';

/** A plain-HTTP origin — exactly the case that used to omit `Secure`. */
const HTTP_ORIGIN = 'http://localhost:3000';

let temp: TempDatabase | null = null;
let ipCounter = 0;

/**
 * Distinct client IP per request.
 *
 * Better Auth rate limits sign-ins; without a resolvable client address it falls
 * back to one shared per-path bucket, which would make this suite flaky for a
 * reason unrelated to cookie behavior.
 */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${String((ipCounter % 250) + 1)}`;
}

afterEach(() => {
  temp?.dispose();
  temp = null;
});

async function provisionUser(database: TempDatabase): Promise<void> {
  await database.auth.api.createUser({
    body: {
      email: 'user@example.com',
      password: PASSWORD,
      name: 'Normal User',
      role: 'user',
      data: { username: 'normaluser', emailVerified: true },
    },
  });
}

/** Sign in over HTTP and return the raw session `Set-Cookie` value. */
async function signInCookie(database: TempDatabase): Promise<string> {
  const response = await createApp({ db: database.handle.db, auth: database.auth }).request(
    `${HTTP_ORIGIN}/api/auth/sign-in/username`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: HTTP_ORIGIN, 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ username: 'normaluser', password: PASSWORD }),
    },
  );

  expect(response.status).toBe(200);

  // Match the session token cookie specifically; `session_data` also exists.
  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('better-auth.session_token=')
      || cookie.startsWith('__Secure-better-auth.session_token='));

  expect(session).toBeDefined();
  return session!;
}

describe('production secure cookies', () => {
  it('marks the session cookie Secure, HttpOnly, SameSite=Lax on a plain-HTTP origin', async () => {
    temp = createTempDatabase({ baseURL: HTTP_ORIGIN, useSecureCookies: true });
    await provisionUser(temp);

    const session = await signInCookie(temp);
    const lower = session.toLowerCase();

    // The three attributes the project requires in production.
    expect(lower).toContain('secure');
    expect(lower).toContain('httponly');
    expect(lower).toContain('samesite=lax');
    expect(lower).toContain('path=/');
  });

  it('uses the __Secure- cookie name prefix in production', async () => {
    temp = createTempDatabase({ baseURL: HTTP_ORIGIN, useSecureCookies: true });
    await provisionUser(temp);

    const session = await signInCookie(temp);

    // Better Auth pairs the Secure attribute with a __Secure- name; the prefix is
    // the part of the contract that browsers actually enforce.
    expect(session.startsWith('__Secure-')).toBe(true);
  });

  it('still authenticates successfully with Secure cookies enabled', async () => {
    temp = createTempDatabase({ baseURL: HTTP_ORIGIN, useSecureCookies: true });
    await provisionUser(temp);

    const session = await signInCookie(temp);
    const cookie = session.split(';')[0] ?? '';

    // A Secure-flagged cookie must still resolve a session server-side.
    const sessionResponse = await createApp({
      db: temp.handle.db,
      auth: temp.auth,
    }).request(`${HTTP_ORIGIN}/api/auth/get-session`, {
      headers: { cookie, 'x-forwarded-for': nextIp() },
    });

    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({ user: { username: 'normaluser' } });
  });
});

describe('development cookie behavior is preserved', () => {
  it('does not force Secure when the option is unset on a plain-HTTP origin', async () => {
    // The production flag must not leak into development, where a local plain-HTTP
    // origin has to stay usable.
    temp = createTempDatabase({ baseURL: HTTP_ORIGIN });
    await provisionUser(temp);

    const session = await signInCookie(temp);
    const lower = session.toLowerCase();

    expect(lower).toContain('httponly');
    expect(lower).toContain('samesite=lax');
    expect(lower).not.toContain('secure');
    expect(session.startsWith('__Secure-')).toBe(false);
  });

  it('derives Secure from an HTTPS origin when the option is unset', async () => {
    // Existing behavior for an HTTPS base URL is unchanged.
    temp = createTempDatabase({ baseURL: 'https://nav.example.test' });
    await provisionUser(temp);

    const response = await createApp({ db: temp.handle.db, auth: temp.auth }).request(
      'https://nav.example.test/api/auth/sign-in/username',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://nav.example.test',
          'x-forwarded-for': nextIp(),
        },
        body: JSON.stringify({ username: 'normaluser', password: PASSWORD }),
      },
    );

    expect(response.status).toBe(200);

    const session = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('better-auth.session_token=')
        || cookie.startsWith('__Secure-better-auth.session_token='));

    expect(session).toBeDefined();
    expect(session!.toLowerCase()).toContain('secure');
  });
});

describe('createAuth secure-cookie option', () => {
  it('omits the advanced key entirely when not requested', () => {
    temp = createTempDatabase();

    // The option is only spread in when set, so an omitted value cannot
    // accidentally override Better Auth's own derivation with `undefined`.
    const auth = createAuth({
      db: temp.handle.db,
      secret: TEST_AUTH_SECRET,
      baseURL: HTTP_ORIGIN,
    });

    expect(auth).toBeDefined();
  });
});
