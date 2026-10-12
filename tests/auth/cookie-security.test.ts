import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createTempDatabase, type TempDatabase } from '../helpers/temp-database.js';

/** Production-like HTTPS origin. `.test` is reserved by RFC 6761 and never resolves. */
const HTTPS_BASE = 'https://nav.example.test';
const PASSWORD = 'cookie-secure-password-123';

let temp: TempDatabase;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${(ipCounter % 250) + 1}`;
}

function app(): ReturnType<typeof createApp> {
  return createApp({ db: temp.handle.db, auth: temp.auth });
}

async function login(username: string, password = PASSWORD): Promise<Response> {
  return app().request(`${HTTPS_BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: HTTPS_BASE,
      'x-forwarded-for': nextIp(),
    },
    body: JSON.stringify({ username, password }),
  });
}

beforeEach(async () => {
  temp = createTempDatabase({ baseURL: HTTPS_BASE });
  await temp.auth.api.createUser({
    body: {
      email: 'user@example.com',
      password: PASSWORD,
      name: 'Normal User',
      role: 'user',
      data: { username: 'normaluser', emailVerified: true },
    },
  });
});

afterEach(() => {
  temp.dispose();
});

describe('Session cookie security under HTTPS', () => {
  it('issues a Secure, HttpOnly, path-scoped, SameSite=Lax session cookie', async () => {
    const response = await login('normaluser');

    expect(response.status).toBe(200);

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.includes('session_token'));

    expect(session).toBeDefined();

    const lower = session?.toLowerCase() ?? '';
    expect(lower).toContain('httponly');
    expect(lower).toContain('secure');
    expect(lower).toContain('path=/');
    expect(lower).toContain('samesite=lax');
  });

  it('uses the __Secure- cookie name prefix for the HTTPS origin', async () => {
    const response = await login('normaluser');

    const session = response.headers
      .getSetCookie()
      .find((cookie) => cookie.toLowerCase().includes('session_token'));

    expect(session?.startsWith('__Secure-better-auth.session_token=')).toBe(true);
  });

  it('does not require Secure on a plain-HTTP development origin (P2.2 dev parity)', async () => {
    const plain = createTempDatabase();
    try {
      await plain.auth.api.createUser({
        body: {
          email: 'user@example.com',
          password: PASSWORD,
          name: 'User',
          role: 'user',
          data: { username: 'normaluser', emailVerified: true },
        },
      });

      const response = await createApp({ db: plain.handle.db, auth: plain.auth }).request(
        'http://localhost:3000/api/auth/sign-in/username',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify({ username: 'normaluser', password: PASSWORD }),
        },
      );

      const session = response.headers
        .getSetCookie()
        .find((cookie) => cookie.includes('session_token'));
      const lower = session?.toLowerCase() ?? '';

      expect(lower).toContain('httponly');
      expect(lower).toContain('path=/');
      // Local plain HTTP must remain usable (no Secure, no __Secure- prefix).
      expect(lower).not.toContain('secure');
      expect(session?.startsWith('__Secure-')).toBe(false);
    } finally {
      plain.dispose();
    }
  });
});

describe('Session token confidentiality', () => {
  it('never returns the session token or password hash in the JSON body', async () => {
    const response = await login('normaluser');

    const body = await response.text();
    const session = response.headers
      .getSetCookie()
      .find((cookie) => cookie.includes('session_token'));
    const rawToken = session?.split(';')[0]?.split('=')[1] ?? '';

    expect(rawToken.length).toBeGreaterThan(0);
    expect(body).not.toContain(rawToken);
    expect(body).not.toContain('password');

    const stored = temp.handle.sqlite
      .prepare('select password from account limit 1')
      .get() as { password: string } | undefined;
    expect(stored?.password).toBeTruthy();
    expect(body).not.toContain(stored?.password);

    // The session body must not carry the credential hash either.
    const sessionLookup = await app().request(`${HTTPS_BASE}/api/auth/get-session`, {
      headers: {
        cookie: session?.split(';')[0] ?? '',
        'x-forwarded-for': nextIp(),
      },
    });
    const sessionBody = await sessionLookup.text();
    expect(sessionBody).not.toContain(stored?.password);
    expect(sessionBody).not.toContain('"password"');
  });

  it('does not accept the raw session token as an Authorization bearer token', async () => {
    const loginResponse = await login('normaluser');
    const session = loginResponse.headers
      .getSetCookie()
      .find((cookie) => cookie.includes('session_token'));
    const rawToken = session?.split(';')[0]?.split('=')[1] ?? '';

    const response = await app().request(`${HTTPS_BASE}/api/auth/get-session`, {
      headers: {
        authorization: `Bearer ${rawToken}`,
        'x-forwarded-for': nextIp(),
      },
    });

    const body = (await response.json()) as { user?: unknown; session?: unknown } | null;
    expect(body?.user ?? null).toBeNull();
  });

  it('rejects a forged session cookie', async () => {
    const response = await app().request(`${HTTPS_BASE}/api/auth/get-session`, {
      headers: {
        cookie: '__Secure-better-auth.session_token=forged.value',
        'x-forwarded-for': nextIp(),
      },
    });

    const body = (await response.json()) as { user?: unknown } | null;
    expect(body?.user ?? null).toBeNull();
  });

  it('rejects a logged-out (stale) session cookie', async () => {
    const loginResponse = await login('normaluser');
    const cookie = loginResponse.headers
      .getSetCookie()
      .find((secret) => secret.includes('session_token'))
      ?.split(';')[0] ?? '';

    const before = await app().request(`${HTTPS_BASE}/api/auth/get-session`, {
      headers: { cookie, 'x-forwarded-for': nextIp() },
    });
    expect(((await before.json()) as { user?: unknown }).user).toBeTruthy();

    const signOut = await app().request(`${HTTPS_BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: HTTPS_BASE,
        'x-forwarded-for': nextIp(),
      },
      body: JSON.stringify({}),
    });
    expect(signOut.status).toBe(200);

    const after = await app().request(`${HTTPS_BASE}/api/auth/get-session`, {
      headers: { cookie, 'x-forwarded-for': nextIp() },
    });
    const body = (await after.json()) as { user?: unknown } | null;
    expect(body?.user ?? null).toBeNull();
  });
});

describe('HTTPS origin validation', () => {
  /**
   * Better Auth intentionally disables the origin/CSRF check when
   * `NODE_ENV=test` (`context/create-context.mjs`: `skipOriginCheck = isTest() ? true`).
   *
   * That means this particular control cannot be exercised faithfully from
   * Vitest. It is therefore verified against the real dev HTTP server
   * (`NODE_ENV` unset), matching production. The assertion below pins the
   * auto-skip so a change in Better Auth's behavior is noticed here instead of
   * silently removing the out-of-band verification's rationale.
   */
  it('is auto-skipped under NODE_ENV=test, so enforcement is verified over real HTTP instead', async () => {
    const loginResponse = await login('normaluser');
    const cookie = loginResponse.headers
      .getSetCookie()
      .find((secret) => secret.includes('session_token'))
      ?.split(';')[0] ?? '';

    const response = await app().request(`${HTTPS_BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://evil.example.com',
        'x-forwarded-for': nextIp(),
      },
      body: JSON.stringify({}),
    });

    expect(process.env.NODE_ENV).toBe('test');
    expect(response.status).toBe(200);
  });
});
