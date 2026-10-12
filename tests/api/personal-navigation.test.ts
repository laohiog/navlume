import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { personalCategories, personalLinks } from '../../src/db/schema.js';
import { createApp } from '../../src/server/app.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

const BASE = TEST_AUTH_BASE_URL;
const PERSONAL = '/api/personal/navigation';
const PASSWORD = 'personal-password-123';

let temp: TempDatabase;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

/** Call the API through the real Hono app — no React, no mocked session. */
function call(
  path: string,
  options: { cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers({ 'x-forwarded-for': nextIp(), ...options.headers });
  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }

  return Promise.resolve(
    createApp({ db: temp.handle.db, auth: temp.auth }).request(`${BASE}${path}`, {
      method: 'GET',
      headers,
    }),
  );
}

async function provisionUser(options: {
  email: string;
  username: string;
  role?: 'admin' | 'user';
}): Promise<void> {
  await temp.auth.api.createUser({
    body: {
      email: options.email,
      password: PASSWORD,
      name: options.username,
      role: options.role ?? 'user',
      data: { username: options.username, emailVerified: true },
    },
  });
}

async function loginCookie(username: string): Promise<string> {
  const response = await createApp({ db: temp.handle.db, auth: temp.auth }).request(
    `${BASE}/api/auth/sign-in/username`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ username, password: PASSWORD }),
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

interface NavigationBody {
  categories: Array<{
    id: number;
    name: string;
    sortOrder: number;
    isDefault: boolean;
    links: Array<{ id: number; title: string; url: string; normalizedUrl: string }>;
  }>;
}

/** Add a link to a user's category directly, to set up isolation scenarios. */
function addLink(userId: string, categoryId: number, title: string, url: string): void {
  temp.handle.db
    .insert(personalLinks)
    .values({ userId, categoryId, title, url, normalizedUrl: url })
    .run();
}

function userIdByEmail(email: string): string {
  const row = temp.handle.sqlite
    .prepare('select id from user where email = ?')
    .get(email) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error(`no user ${email}`);
  }
  return row.id;
}

beforeEach(async () => {
  temp = createTempDatabase();
  await provisionUser({ email: 'a@example.com', username: 'usera' });
  await provisionUser({ email: 'b@example.com', username: 'userb' });
  await provisionUser({ email: 'admin@example.com', username: 'adminuser', role: 'admin' });
});

afterEach(() => {
  temp.dispose();
});

describe('authentication boundary', () => {
  it('denies a guest with 401 and leaks no personal data', async () => {
    const response = await call(PERSONAL);

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Authentication Required' });
    expect(text).not.toContain('categories');
    expect(text).not.toContain('我的常用');
  });

  it('denies a forged session cookie', async () => {
    const response = await call(PERSONAL, {
      cookie: 'better-auth.session_token=forged.value',
    });

    expect(response.status).toBe(401);
  });

  it('denies a stale cookie after sign-out', async () => {
    const cookie = await loginCookie('usera');
    expect((await call(PERSONAL, { cookie })).status).toBe(200);

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

    expect((await call(PERSONAL, { cookie })).status).toBe(401);
  });

  it('accepts an authenticated user', async () => {
    const cookie = await loginCookie('usera');
    const response = await call(PERSONAL, { cookie });

    expect(response.status).toBe(200);
  });
});

describe('default category initialization', () => {
  it('creates ⭐ 我的常用 on first access', async () => {
    const cookie = await loginCookie('usera');
    const { categories } = (await (await call(PERSONAL, { cookie })).json()) as NavigationBody;

    expect(categories).toHaveLength(1);
    expect(categories[0]).toMatchObject({ name: '⭐ 我的常用', isDefault: true, links: [] });
  });

  it('does not duplicate the default category on repeated access', async () => {
    const cookie = await loginCookie('usera');

    await call(PERSONAL, { cookie });
    await call(PERSONAL, { cookie });
    const { categories } = (await (await call(PERSONAL, { cookie })).json()) as NavigationBody;

    expect(categories).toHaveLength(1);

    const defaults = temp.handle.db
      .select()
      .from(personalCategories)
      .where(
        and(
          eq(personalCategories.userId, userIdByEmail('a@example.com')),
          eq(personalCategories.isDefault, true),
        ),
      )
      .all();
    expect(defaults).toHaveLength(1);
  });

  it('creates an independent default category per user', async () => {
    const cookieA = await loginCookie('usera');
    const cookieB = await loginCookie('userb');

    const bodyA = (await (await call(PERSONAL, { cookie: cookieA })).json()) as NavigationBody;
    const bodyB = (await (await call(PERSONAL, { cookie: cookieB })).json()) as NavigationBody;

    expect(bodyA.categories).toHaveLength(1);
    expect(bodyB.categories).toHaveLength(1);
    expect(bodyA.categories[0]?.id).not.toBe(bodyB.categories[0]?.id);
  });

  it('does not create personal data for a user who has never used it', async () => {
    expect(temp.handle.db.select().from(personalCategories).all()).toHaveLength(0);

    const cookie = await loginCookie('usera');
    await call(PERSONAL, { cookie });

    // Only the requesting user gained a category.
    const rows = temp.handle.db.select().from(personalCategories).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userIdByEmail('a@example.com'));
  });
});

describe('cross-user read isolation', () => {
  it('shows User A only their own categories and links', async () => {
    const cookieA = await loginCookie('usera');
    const cookieB = await loginCookie('userb');

    // Materialize both defaults, then give each user a private link.
    const bodyA = (await (await call(PERSONAL, { cookie: cookieA })).json()) as NavigationBody;
    const bodyB = (await (await call(PERSONAL, { cookie: cookieB })).json()) as NavigationBody;

    const userAId = userIdByEmail('a@example.com');
    const userBId = userIdByEmail('b@example.com');
    addLink(userAId, bodyA.categories[0]!.id, 'A Private Link', 'https://a-private.example.com');
    addLink(userBId, bodyB.categories[0]!.id, 'B Private Link', 'https://b-private.example.com');

    const viewA = (await (await call(PERSONAL, { cookie: cookieA })).json()) as NavigationBody;
    const viewB = (await (await call(PERSONAL, { cookie: cookieB })).json()) as NavigationBody;

    const linksA = viewA.categories.flatMap((category) => category.links.map((link) => link.title));
    const linksB = viewB.categories.flatMap((category) => category.links.map((link) => link.title));

    expect(linksA).toEqual(['A Private Link']);
    expect(linksB).toEqual(['B Private Link']);

    // No leakage in either direction.
    expect(JSON.stringify(viewA)).not.toContain('B Private Link');
    expect(JSON.stringify(viewA)).not.toContain('b-private.example.com');
    expect(JSON.stringify(viewB)).not.toContain('A Private Link');
    expect(JSON.stringify(viewB)).not.toContain('a-private.example.com');
    expect(JSON.stringify(viewA)).not.toContain(userBId);
    expect(JSON.stringify(viewB)).not.toContain(userAId);
  });

  it('does not expose another user\'s category name', async () => {
    const cookieA = await loginCookie('usera');
    const cookieB = await loginCookie('userb');

    await call(PERSONAL, { cookie: cookieA });
    await call(PERSONAL, { cookie: cookieB });

    // Rename B's default to a distinctive private name directly in the DB.
    temp.handle.db
      .update(personalCategories)
      .set({ name: 'B Secret Category' })
      .where(eq(personalCategories.userId, userIdByEmail('b@example.com')))
      .run();

    const viewA = (await (await call(PERSONAL, { cookie: cookieA })).json()) as NavigationBody;

    expect(JSON.stringify(viewA)).not.toContain('B Secret Category');
    expect(viewA.categories.map((category) => category.name)).toEqual(['⭐ 我的常用']);
  });

  it('gives an admin only their own personal navigation', async () => {
    const cookieUser = await loginCookie('usera');
    const cookieAdmin = await loginCookie('adminuser');

    const userView = (await (await call(PERSONAL, { cookie: cookieUser })).json()) as NavigationBody;
    addLink(
      userIdByEmail('a@example.com'),
      userView.categories[0]!.id,
      'A Only Link',
      'https://a-only.example.com',
    );

    const adminView = (await (await call(PERSONAL, { cookie: cookieAdmin })).json()) as NavigationBody;

    expect(adminView.categories).toHaveLength(1);
    expect(adminView.categories[0]?.name).toBe('⭐ 我的常用');
    expect(JSON.stringify(adminView)).not.toContain('A Only Link');
  });
});

describe('identity spoofing', () => {
  beforeEach(async () => {
    // Seed distinguishable data for A and B.
    const cookieA = await loginCookie('usera');
    const cookieB = await loginCookie('userb');
    const bodyA = (await (await call(PERSONAL, { cookie: cookieA })).json()) as NavigationBody;
    const bodyB = (await (await call(PERSONAL, { cookie: cookieB })).json()) as NavigationBody;
    addLink(userIdByEmail('a@example.com'), bodyA.categories[0]!.id, 'A Link', 'https://a.example.com');
    addLink(userIdByEmail('b@example.com'), bodyB.categories[0]!.id, 'B Link', 'https://b.example.com');
  });

  it('ignores ?userId / ?username / ?role query spoofing', async () => {
    const cookieA = await loginCookie('usera');
    const userBId = userIdByEmail('b@example.com');

    const response = await call(
      `${PERSONAL}?userId=${userBId}&username=userb&role=admin&authenticated=true`,
      { cookie: cookieA },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as NavigationBody;
    expect(JSON.stringify(body)).toContain('A Link');
    expect(JSON.stringify(body)).not.toContain('B Link');
    expect(JSON.stringify(body)).not.toContain(userBId);
  });

  it('ignores x-user-id / x-role / x-authenticated headers', async () => {
    const cookieA = await loginCookie('usera');

    const response = await call(PERSONAL, {
      cookie: cookieA,
      headers: {
        'x-user-id': userIdByEmail('b@example.com'),
        'x-role': 'admin',
        'x-authenticated': 'true',
        'x-forwarded-user': 'userb',
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as NavigationBody;
    expect(JSON.stringify(body)).toContain('A Link');
    expect(JSON.stringify(body)).not.toContain('B Link');
  });

  it('ignores spoofing without any session (still 401)', async () => {
    const response = await call(`${PERSONAL}?userId=${userIdByEmail('b@example.com')}&role=admin`, {
      headers: { 'x-user-id': userIdByEmail('b@example.com'), 'x-authenticated': 'true' },
    });

    expect(response.status).toBe(401);
  });
});

describe('response shape', () => {
  it('exposes only client-facing fields', async () => {
    const cookie = await loginCookie('usera');
    const response = await call(PERSONAL, { cookie });
    const body = (await response.json()) as NavigationBody;

    expect(Object.keys(body).sort()).toEqual(['categories']);
    expect(Object.keys(body.categories[0] ?? {}).sort()).toEqual([
      'id',
      'isDefault',
      'links',
      'name',
      'sortOrder',
    ]);

    const text = JSON.stringify(body);
    expect(text).not.toContain('userId');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('password');
    expect(text).not.toContain('session');
    expect(text).not.toMatch(/SQLITE|sqlite|\.sqlite/);
  });

  it('orders categories and links by sort_order then id', async () => {
    const cookie = await loginCookie('usera');
    const initial = (await (await call(PERSONAL, { cookie })).json()) as NavigationBody;
    const userId = userIdByEmail('a@example.com');
    const defaultId = initial.categories[0]!.id;

    // Inserted out of order; the two sortOrder=1 rows share a tie so the id
    // tie-breaker is what decides their relative position.
    temp.handle.db
      .insert(personalCategories)
      .values([
        { userId, name: 'Third', sortOrder: 2 },
        { userId, name: 'Tie First Inserted', sortOrder: 1 },
        { userId, name: 'Tie Second Inserted', sortOrder: 1 },
      ])
      .run();

    const tieFirst = temp.handle.db
      .select()
      .from(personalCategories)
      .where(
        and(eq(personalCategories.userId, userId), eq(personalCategories.name, 'Tie First Inserted')),
      )
      .get()!;
    const tieSecond = temp.handle.db
      .select()
      .from(personalCategories)
      .where(
        and(eq(personalCategories.userId, userId), eq(personalCategories.name, 'Tie Second Inserted')),
      )
      .get()!;

    // Lower id must win the tie regardless of insertion order.
    expect(tieFirst.id).toBeLessThan(tieSecond.id);

    temp.handle.db
      .insert(personalLinks)
      .values([
        { userId, categoryId: tieFirst.id, title: 'Link B (later insert, lower id)', url: 'https://b.example.com', normalizedUrl: 'https://b.example.com', sortOrder: 5 },
        { userId, categoryId: tieFirst.id, title: 'Link A', url: 'https://a.example.com', normalizedUrl: 'https://a.example.com', sortOrder: 1 },
        { userId, categoryId: tieFirst.id, title: 'Link C', url: 'https://c.example.com', normalizedUrl: 'https://c.example.com', sortOrder: 9 },
      ])
      .run();

    // Add a tie pair for links, inserted in reverse id order.
    const linkEarly = temp.handle.db
      .insert(personalLinks)
      .values({ userId, categoryId: tieFirst.id, title: 'Link Tie Earlier', url: 'https://t1.example.com', normalizedUrl: 'https://t1.example.com', sortOrder: 3 })
      .returning()
      .get();
    temp.handle.db
      .insert(personalLinks)
      .values({ userId, categoryId: tieFirst.id, title: 'Link Tie Later', url: 'https://t2.example.com', normalizedUrl: 'https://t2.example.com', sortOrder: 3 })
      .run();

    const body = (await (await call(PERSONAL, { cookie })).json()) as NavigationBody;

    // Category order: default (sortOrder 0) first, then the tie pair by id, then Third (2).
    expect(body.categories.map((category) => category.name)).toEqual([
      '⭐ 我的常用',
      'Tie First Inserted',
      'Tie Second Inserted',
      'Third',
    ]);

    // Link order within the tie category: sort_order asc, then id asc.
    const tieCategory = body.categories[1]!;
    expect(tieCategory.links.map((link) => link.title)).toEqual([
      'Link A',
      'Link Tie Earlier',
      'Link Tie Later',
      'Link B (later insert, lower id)',
      'Link C',
    ]);
    expect(defaultId).toBe(initial.categories[0]!.id);
    expect(linkEarly.title).toBe('Link Tie Earlier');
  });
});

describe('no mutation surface exists', () => {
  it('does not accept writes on the personal route', async () => {
    const cookie = await loginCookie('usera');
    const app = createApp({ db: temp.handle.db, auth: temp.auth });

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await app.request(`${BASE}${PERSONAL}`, {
        method,
        headers: { cookie, 'x-forwarded-for': nextIp() },
      });
      expect(response.status).toBe(404);
    }
  });
});
