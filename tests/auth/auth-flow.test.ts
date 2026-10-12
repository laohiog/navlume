import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/db/auth.js';
import { createApp } from '../../src/server/app.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

const BASE = TEST_AUTH_BASE_URL;
const ADMIN_PASSWORD = 'admin-password-123';
const USER_PASSWORD = 'user-password-123';

let temp: TempDatabase;

/**
 * Distinct client IP per request.
 *
 * Better Auth's rate limiter keys buckets by client IP. The production topology
 * reaches the app through a reverse proxy that forwards `x-forwarded-for`, so
 * tests send that header too. Without it every call shares one in-memory bucket
 * and unrelated tests would exhaust the sign-in rate limit.
 */
let clientIpCounter = 0;

function nextClientIp(): string {
  clientIpCounter += 1;
  return `198.51.100.${(clientIpCounter % 250) + 1}`;
}

/** Issue a request through the real Hono app so routing is exercised too. */
function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('x-forwarded-for')) {
    headers.set('x-forwarded-for', nextClientIp());
  }

  return Promise.resolve(
    createApp({ db: temp.handle.db, auth: temp.auth }).request(`${BASE}${path}`, {
      ...init,
      headers,
    }),
  );
}

function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  return request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

/** Extract the session cookie pair from a Set-Cookie header. */
function sessionCookieFrom(response: Response): string {
  const raw = response.headers.getSetCookie();
  const session = raw.find((cookie) => cookie.startsWith('better-auth.session_token='));
  if (session === undefined) {
    throw new Error(`no session cookie in: ${JSON.stringify(raw)}`);
  }
  return session.split(';')[0] ?? '';
}

/** Create a user through the official server-side admin API (never raw SQL). */
async function createUser(options: {
  email: string;
  password: string;
  name: string;
  role: 'admin' | 'user';
  username: string;
}): Promise<void> {
  await temp.auth.api.createUser({
    body: {
      email: options.email,
      password: options.password,
      name: options.name,
      role: options.role,
      data: { username: options.username, emailVerified: true },
    },
  });
}

beforeEach(() => {
  temp = createTempDatabase();
});

afterEach(() => {
  temp.dispose();
});

describe('public signup boundary', () => {
  it('rejects public email/password sign-up over HTTP', async () => {
    const response = await postJson('/api/auth/sign-up/email', {
      email: 'intruder@example.com',
      password: 'intruder-password-123',
      name: 'Intruder',
      username: 'intruder',
    });

    expect(response.ok).toBe(false);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');

    // No user row and no session may be created by the attempt.
    expect(temp.handle.sqlite.prepare('select count(*) c from user').get()).toEqual({ c: 0 });
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it('does not expose a public username availability endpoint', async () => {
    const response = await postJson('/api/auth/is-username-available', { username: 'admin' });

    expect(response.status).toBe(404);
  });
});

describe('username login', () => {
  beforeEach(async () => {
    await createUser({
      email: 'admin@example.com',
      password: ADMIN_PASSWORD,
      name: 'Admin',
      role: 'admin',
      username: 'admin',
    });
  });

  it('signs in with username and password', async () => {
    const response = await postJson('/api/auth/sign-in/username', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user?: { email?: string; username?: string } };
    expect(body.user?.email).toBe('admin@example.com');
    expect(body.user?.username).toBe('admin');
  });

  it('rejects a wrong password without creating a session', async () => {
    const response = await postJson('/api/auth/sign-in/username', {
      username: 'admin',
      password: 'definitely-the-wrong-password',
    });

    expect(response.ok).toBe(false);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(temp.handle.sqlite.prepare('select count(*) c from session').get()).toEqual({ c: 0 });
  });

  it('never echoes a password hash in the response body', async () => {
    const response = await postJson('/api/auth/sign-in/username', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });

    const text = await response.text();
    const stored = temp.handle.sqlite
      .prepare('select password from account limit 1')
      .get() as { password: string } | undefined;

    expect(stored?.password).toBeTruthy();
    expect(text).not.toContain(stored?.password);
  });
});

describe('session lifecycle', () => {
  beforeEach(async () => {
    await createUser({
      email: 'admin@example.com',
      password: ADMIN_PASSWORD,
      name: 'Admin',
      role: 'admin',
      username: 'admin',
    });
  });

  it('returns the signed-in user for a valid session cookie', async () => {
    const login = await postJson('/api/auth/sign-in/username', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });
    const cookie = sessionCookieFrom(login);

    const response = await request('/api/auth/get-session', { headers: { cookie } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user?: { email?: string; role?: string };
      session?: { token?: string };
    };
    expect(body.user?.email).toBe('admin@example.com');
    expect(body.user?.role).toBe('admin');
    expect(body.session?.token).toBeTruthy();
  });

  it('invalidates the session on sign-out', async () => {
    const login = await postJson('/api/auth/sign-in/username', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });
    const cookie = sessionCookieFrom(login);

    const before = await request('/api/auth/get-session', { headers: { cookie } });
    expect(((await before.json()) as { user?: unknown }).user).toBeTruthy();

    const signOut = await postJson('/api/auth/sign-out', {}, cookie);
    expect(signOut.ok).toBe(true);

    const after = await request('/api/auth/get-session', { headers: { cookie } });
    const body = (await after.json()) as { user?: unknown; session?: unknown } | null;
    expect(body?.user ?? null).toBeNull();
  });

  it('marks the session cookie HttpOnly and path-scoped', async () => {
    const response = await postJson('/api/auth/sign-in/username', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });

    const setCookie = response.headers.getSetCookie();
    const session = setCookie.find((cookie) => cookie.startsWith('better-auth.session_token='));
    expect(session).toBeDefined();
    expect(session?.toLowerCase()).toContain('httponly');
    expect(session?.toLowerCase()).toContain('path=/');

    // The raw session token must not leak into the JSON body.
    const body = await response.text();
    const token = session?.split(';')[0]?.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThan(0);
    expect(body).not.toContain(token);
  });
});

describe('admin authorization', () => {
  beforeEach(async () => {
    await createUser({
      email: 'admin@example.com',
      password: ADMIN_PASSWORD,
      name: 'Admin',
      role: 'admin',
      username: 'admin',
    });
    await createUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'Normal User',
      role: 'user',
      username: 'normaluser',
    });
  });

  it('denies an unauthenticated (guest) caller', async () => {
    const response = await request('/api/auth/admin/list-users');

    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('denies a normal user', async () => {
    const login = await postJson('/api/auth/sign-in/username', {
      username: 'normaluser',
      password: USER_PASSWORD,
    });
    const cookie = sessionCookieFrom(login);

    const response = await request('/api/auth/admin/list-users', { headers: { cookie } });

    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('allows an admin to perform a harmless admin operation', async () => {
    const login = await postJson('/api/auth/sign-in/username', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });
    const cookie = sessionCookieFrom(login);

    const response = await request('/api/auth/admin/list-users', { headers: { cookie } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { users?: Array<{ email?: string }> };
    expect(body.users?.map((user) => user.email)).toContain('user@example.com');
  });
});

describe('auth configuration boundaries', () => {
  it('rate limits repeated sign-in attempts from the same client', async () => {
    await createUser({
      email: 'admin@example.com',
      password: ADMIN_PASSWORD,
      name: 'Admin',
      role: 'admin',
      username: 'admin',
    });

    const sameClient = { 'x-forwarded-for': '203.0.113.77' };
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request('/api/auth/sign-in/username', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sameClient },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
      });
      statuses.push(response.status);
    }

    // The limiter must actually engage rather than only being configured.
    expect(statuses).toContain(429);
  });

  it('runs every auth instance against its own injected database', () => {
    const other = createTempDatabase();
    try {
      const otherAuth = createAuth({
        db: other.handle.db,
        secret: 'another-valid-test-secret-value-0123456789',
        baseURL: BASE,
      });
      expect(otherAuth.handler).toBeTypeOf('function');
      // Independent databases must not share rows.
      expect(other.handle.sqlite.prepare('select count(*) c from user').get()).toEqual({ c: 0 });
    } finally {
      other.dispose();
    }
  });

  it('does not create any personal data merely by running the auth suite', () => {
    // Personal tables exist since P3.1, but no personal rows may be created by
    // authenticating: the default category is materialized lazily by the
    // personal navigation route, never at signup.
    const categories = temp.handle.sqlite.prepare('select count(*) c from personal_categories').get() as { c: number };
    const links = temp.handle.sqlite.prepare('select count(*) c from personal_links').get() as { c: number };

    expect(categories.c).toBe(0);
    expect(links.c).toBe(0);
  });
});
