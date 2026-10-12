import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { siteSettings } from '../../src/db/schema.js';
import { seedDemoData } from '../../src/db/seed.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

const BASE = TEST_AUTH_BASE_URL;
const NAVIGATION = '/api/public/navigation';
const PASSWORD = 'access-mode-password-123';

let temp: TempDatabase;
let ipCounter = 0;

/** Distinct client IP per request so Better Auth's rate limiter is not exhausted. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

/** Call the API directly — no React app involved. This is the security boundary. */
function callNavigation(cookie?: string): Promise<Response> {
  const headers = new Headers({ 'x-forwarded-for': nextIp() });
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }

  return Promise.resolve(
    createApp({ db: temp.handle.db, auth: temp.auth }).request(`${BASE}${NAVIGATION}`, {
      method: 'GET',
      headers,
    }),
  );
}

async function createUser(options: {
  email: string;
  name: string;
  role: 'admin' | 'user';
  username: string;
}): Promise<void> {
  await temp.auth.api.createUser({
    body: {
      email: options.email,
      password: PASSWORD,
      name: options.name,
      role: options.role,
      data: { username: options.username, emailVerified: true },
    },
  });
}

/** Sign in through the real HTTP endpoint and return the session cookie pair. */
async function loginCookie(username: string, password = PASSWORD): Promise<string> {
  const response = await createApp({ db: temp.handle.db, auth: temp.auth }).request(
    `${BASE}/api/auth/sign-in/username`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        'x-forwarded-for': nextIp(),
      },
      body: JSON.stringify({ username, password }),
    },
  );

  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  }

  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('better-auth.session_token='));

  if (session === undefined) {
    throw new Error('no session cookie');
  }

  return session.split(';')[0] ?? '';
}

function setAccessMode(mode: 'public' | 'login_required'): void {
  temp.handle.db.update(siteSettings).set({ accessMode: mode }).run();
}

beforeEach(() => {
  temp = createTempDatabase();
  // Migrated + seeded: real categories and links exist, so a 401 must be proven
  // to withhold actual data rather than merely returning an empty payload.
  seedDemoData(temp.handle.db);
});

afterEach(() => {
  temp.dispose();
});

describe('access_mode = public', () => {
  it('allows a guest to read navigation', async () => {
    setAccessMode('public');

    const response = await callNavigation();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { categories: Array<{ name: string }> };
    expect(body.categories.length).toBeGreaterThan(0);
  });

  it('allows an authenticated user to read navigation', async () => {
    setAccessMode('public');
    await createUser({ email: 'user1@example.com', name: 'U', role: 'user', username: 'user1' });
    const cookie = await loginCookie('user1');

    const response = await callNavigation(cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { categories: Array<{ name: string }> };
    expect(body.categories.length).toBeGreaterThan(0);
  });

  it('treats a missing site_settings row as public', async () => {
    // Remove the settings row entirely. A fresh install must remain readable:
    // the absence of configuration must never lock the site down.
    temp.handle.db.delete(siteSettings).run();

    const response = await callNavigation();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      site: unknown;
      categories: Array<{ name: string }>;
    };
    expect(body.site).toBeNull();
    // Seeded categories still exist; unconfigured means public, not hidden.
    expect(body.categories.map((category) => category.name)).toEqual(['Example', 'Reference']);
  });
});

describe('access_mode = login_required', () => {
  it('denies a guest with 401 and leaks no navigation data', async () => {
    setAccessMode('login_required');

    const response = await callNavigation();

    expect(response.status).toBe(401);

    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Authentication Required' });

    // Real seeded data exists in this database, so absence proves withholding.
    expect(text).not.toContain('categories');
    expect(text).not.toContain('links');
    expect(text).not.toContain('Example');
    expect(text).not.toContain('example.com');
    expect(text).not.toMatch(/SQLITE|sqlite|no such table|\.sqlite/i);
  });

  it('allows an authenticated user', async () => {
    setAccessMode('login_required');
    await createUser({ email: 'user1@example.com', name: 'U', role: 'user', username: 'user1' });
    const cookie = await loginCookie('user1');

    const response = await callNavigation(cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { categories: Array<{ name: string }> };
    expect(body.categories.length).toBeGreaterThan(0);
  });

  it('allows an authenticated admin', async () => {
    setAccessMode('login_required');
    await createUser({ email: 'admin1@example.com', name: 'A', role: 'admin', username: 'admin1' });
    const cookie = await loginCookie('admin1');

    const response = await callNavigation(cookie);

    expect(response.status).toBe(200);
  });

  it('denies a forged/garbage session cookie', async () => {
    setAccessMode('login_required');

    const response = await callNavigation('better-auth.session_token=forged.value');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication Required' });
  });

  it('denies a stale cookie after the user signs out', async () => {
    setAccessMode('login_required');
    await createUser({ email: 'user1@example.com', name: 'U', role: 'user', username: 'user1' });
    const cookie = await loginCookie('user1');

    // Valid before logout.
    expect((await callNavigation(cookie)).status).toBe(200);

    const signOut = await createApp({ db: temp.handle.db, auth: temp.auth }).request(
      `${BASE}/api/auth/sign-out`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: BASE,
          'x-forwarded-for': nextIp(),
        },
        body: JSON.stringify({}),
      },
    );
    expect(signOut.status).toBe(200);

    // The same cookie must no longer grant access.
    expect((await callNavigation(cookie)).status).toBe(401);
  });

  it('does not authorize on client-supplied identity hints', async () => {
    setAccessMode('login_required');

    const app = createApp({ db: temp.handle.db, auth: temp.auth });
    const response = await app.request(
      `${BASE}${NAVIGATION}?userId=1&username=admin&authenticated=true`,
      {
        method: 'GET',
        headers: {
          'x-forwarded-for': nextIp(),
          'x-user-id': '1',
          'x-authenticated': 'true',
        },
      },
    );

    expect(response.status).toBe(401);
  });
});

describe('access_mode transitions', () => {
  it('serves immediately when switched back to public', async () => {
    setAccessMode('login_required');
    expect((await callNavigation()).status).toBe(401);

    temp.handle.db
      .update(siteSettings)
      .set({ accessMode: 'public' })
      .where(eq(siteSettings.id, 1))
      .run();

    expect((await callNavigation()).status).toBe(200);
  });
});

describe('P1 regression under public mode', () => {
  it('keeps ordering, visibility filtering and 404 behavior intact', async () => {
    setAccessMode('public');

    const response = await callNavigation();
    const body = (await response.json()) as {
      categories: Array<{ name: string; sortOrder: number; links: Array<{ sortOrder: number }> }>;
    };

    expect(response.status).toBe(200);
    expect(body.categories.map((category) => category.name)).toEqual(['Example', 'Reference']);

    const app = createApp({ db: temp.handle.db, auth: temp.auth });
    const notFound = await app.request(`${BASE}/api/does-not-exist`, {
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(notFound.status).toBe(404);
  });
});
