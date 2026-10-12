import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { personalCategories, personalLinks } from '../../src/db/schema.js';
import { createApp } from '../../src/server/app.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

/**
 * P5.3 — User Management.
 *
 * Exercises Better Auth's **official** `/api/auth/admin/*` endpoints through the
 * real Hono app and a real SQLite database. This is the security boundary: user
 * management uses Better Auth's own authorization, not a custom API.
 *
 * Regression first: these endpoints already existed and were covered by
 * `admin-authorization.test.ts`. This suite adds the P5.3 lifecycle guarantees
 * (disable/enable, password reset, deletion with personal-data cascade) plus the
 * spoofing resistance required for an L3 account-administration change.
 */

const BASE = TEST_AUTH_BASE_URL;
const ADMIN_PASSWORD = 'admin-password-123';
const USER_PASSWORD = 'user-password-123';

let temp: TempDatabase;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 200) + 10}`;
}

function app(): ReturnType<typeof createApp> {
  return createApp({ db: temp.handle.db, auth: temp.auth });
}

/** Call any Better Auth endpoint through the real app. Origin is required for writes. */
function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers({ 'x-forwarded-for': nextIp(), origin: BASE, ...options.headers });

  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }

  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  return Promise.resolve(
    app().request(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
}

async function provisionUser(options: {
  email: string;
  password: string;
  name: string;
  role: 'admin' | 'user';
  username: string;
}): Promise<string> {
  const created = await temp.auth.api.createUser({
    body: {
      email: options.email,
      password: options.password,
      name: options.name,
      role: options.role,
      data: { username: options.username, emailVerified: true },
    },
  });

  return created.user.id;
}

async function loginCookie(username: string, password: string): Promise<string> {
  const response = await call('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username, password },
  });

  if (response.status !== 200) {
    throw new Error(`login failed for ${username}: ${response.status}`);
  }

  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('better-auth.session_token='));

  if (session === undefined) {
    throw new Error('no session cookie');
  }

  return session.split(';')[0] ?? '';
}

/** Sign-in attempt; returns the HTTP status so 401 vs 200 is assertable. */
async function signInStatus(username: string, password: string): Promise<number> {
  const response = await call('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username, password },
  });

  return response.status;
}

function userIdByEmail(email: string): string | undefined {
  return (temp.handle.sqlite.prepare('select id from user where email = ?').get(email) as { id: string } | undefined)
    ?.id;
}

function countRows(table: 'user' | 'account' | 'session' | 'personal_categories' | 'personal_links', column?: string, value?: string): number {
  const sql = column === undefined ? `select count(*) as c from ${table}` : `select count(*) as c from ${table} where ${column} = ?`;
  const row = column === undefined
    ? temp.handle.sqlite.prepare(sql).get()
    : temp.handle.sqlite.prepare(sql).get(value);
  return (row as { c: number }).c;
}

const CREATE_BODY = {
  email: 'newuser@example.com',
  password: 'new-user-password-123',
  name: 'New User',
  role: 'user',
  data: { username: 'newuser', emailVerified: true },
};

beforeEach(async () => {
  temp = createTempDatabase();
  await provisionUser({
    email: 'admin@example.com',
    password: ADMIN_PASSWORD,
    name: 'Admin',
    role: 'admin',
    username: 'admin',
  });
});

afterEach(() => {
  temp.dispose();
});

describe('user management authorization matrix', () => {
  it('denies every admin operation to a guest', async () => {
    const attempts: Array<[string, unknown]> = [
      ['/api/auth/admin/list-users', undefined],
      ['/api/auth/admin/create-user', CREATE_BODY],
      ['/api/auth/admin/ban-user', { userId: 'x' }],
      ['/api/auth/admin/unban-user', { userId: 'x' }],
      ['/api/auth/admin/set-user-password', { userId: 'x', newPassword: 'new-password-123' }],
      ['/api/auth/admin/remove-user', { userId: 'x' }],
    ];

    for (const [path, body] of attempts) {
      const response = await call(path, body === undefined ? {} : { method: 'POST', body });
      expect(response.status, path).toBe(401);
    }
  });

  it('denies every admin operation to an ordinary user', async () => {
    await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'User',
      role: 'user',
      username: 'normaluser',
    });
    const cookie = await loginCookie('normaluser', USER_PASSWORD);

    const attempts: Array<[string, unknown]> = [
      ['/api/auth/admin/list-users', undefined],
      ['/api/auth/admin/create-user', CREATE_BODY],
      ['/api/auth/admin/ban-user', { userId: 'x' }],
      ['/api/auth/admin/unban-user', { userId: 'x' }],
      ['/api/auth/admin/set-user-password', { userId: 'x', newPassword: 'new-password-123' }],
      ['/api/auth/admin/remove-user', { userId: 'x' }],
    ];

    for (const [path, body] of attempts) {
      const response = await call(path, {
        cookie,
        ...(body === undefined ? {} : { method: 'POST', body }),
      });
      expect(response.status, path).toBe(403);
    }
  });

  it('allows an admin to list users', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD);

    const response = await call('/api/auth/admin/list-users', { cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { username?: string; role?: string }[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.users.some((user) => user.username === 'admin')).toBe(true);
  });

  it('rejects spoofed identity and role claims from a guest', async () => {
    const spoofed = [
      '/api/auth/admin/list-users?role=admin&userId=1',
      '/api/auth/admin/list-users?authenticated=true',
    ];

    for (const path of spoofed) {
      expect((await call(path)).status, path).toBe(401);
    }

    for (const headers of [
      { 'x-role': 'admin' },
      { 'x-user-id': '1' },
      { 'x-authenticated': 'true' },
      { 'x-forwarded-user': 'admin' },
    ]) {
      expect((await call('/api/auth/admin/list-users', { headers })).status, JSON.stringify(headers)).toBe(401);
    }

    expect(
      (await call('/api/auth/admin/list-users', { cookie: 'better-auth.session_token=forged' })).status,
    ).toBe(401);
  });

  it('does not let an ordinary user escalate through a spoofed role', async () => {
    await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'User',
      role: 'user',
      username: 'normaluser',
    });
    const cookie = await loginCookie('normaluser', USER_PASSWORD);

    const response = await call('/api/auth/admin/set-role', {
      method: 'POST',
      cookie,
      body: { userId: userIdByEmail('user@example.com'), role: 'admin' },
    });

    expect(response.status).toBe(403);
    expect(
      (temp.handle.sqlite.prepare('select role from user where email = ?').get('user@example.com') as { role: string }).role,
    ).toBe('user');
  });
});

describe('create user', () => {
  it('creates a normal user that can sign in and has no admin access', async () => {
    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);

    const response = await call('/api/auth/admin/create-user', {
      method: 'POST',
      cookie: adminCookie,
      body: CREATE_BODY,
    });

    expect(response.status).toBe(200);

    // Role is forced to `user` and the account can authenticate.
    const userCookie = await loginCookie('newuser', CREATE_BODY.password);
    const session = await call('/api/auth/get-session', { cookie: userCookie });
    const sessionBody = (await session.json()) as { user?: { email?: string; role?: string } };
    expect(sessionBody.user?.role).toBe('user');
    expect(sessionBody.user?.email).toBe(CREATE_BODY.email);

    // ...but has no admin capability.
    expect((await call('/api/auth/admin/list-users', { cookie: userCookie })).status).toBe(403);
  });

  it('creates a `user` when no role is supplied at all', async () => {
    // The P5.3 client always sends `role: 'user'`; this proves the default is also
    // non-admin, so a missing field cannot silently escalate.
    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);

    const response = await call('/api/auth/admin/create-user', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        email: CREATE_BODY.email,
        password: CREATE_BODY.password,
        name: CREATE_BODY.name,
        data: { username: 'newuser', emailVerified: true },
      },
    });

    expect(response.status).toBe(200);
    const role = (
      temp.handle.sqlite.prepare('select role from user where email = ?').get(CREATE_BODY.email) as { role: string }
    ).role;
    expect(role).toBe('user');
  });

  it('is not a route for the client to choose an arbitrary role', async () => {
    // P5.3's client module hard-codes `role: 'user'` and exposes no role parameter,
    // so role selection is not part of the user-management surface. This asserts
    // the created account cannot administer users either way.
    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    await call('/api/auth/admin/create-user', {
      method: 'POST',
      cookie: adminCookie,
      body: CREATE_BODY,
    });

    const userCookie = await loginCookie('newuser', CREATE_BODY.password);
    expect((await call('/api/auth/admin/list-users', { cookie: userCookie })).status).toBe(403);
    expect((await call('/api/auth/admin/create-user', { method: 'POST', cookie: userCookie, body: CREATE_BODY })).status).toBe(403);
  });
});

describe('disable and re-enable', () => {
  it('disables an account, invalidates access, and preserves personal data', async () => {
    const userId = await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'User',
      role: 'user',
      username: 'normaluser',
    });

    // Give the user personal navigation data.
    temp.handle.db.insert(personalCategories).values({ userId, name: '我的分类', sortOrder: 0, isDefault: false }).run();
    const category = temp.handle.db.select().from(personalCategories).all()[0]!;
    temp.handle.db
      .insert(personalLinks)
      .values({ userId, categoryId: category.id, title: 'Link', url: 'https://example.com', normalizedUrl: 'https://example.com/', sortOrder: 0 })
      .run();

    const userCookie = await loginCookie('normaluser', USER_PASSWORD);
    // Precondition: the target user has a live session that authenticates.
    expect((await call('/api/auth/get-session', { cookie: userCookie })).status).toBe(200);
    expect(countRows('session', 'user_id', userId)).toBe(1);

    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    const banned = await call('/api/auth/admin/ban-user', {
      method: 'POST',
      cookie: adminCookie,
      body: { userId, banReason: 'Disabled by administrator' },
    });
    expect(banned.status).toBe(200);

    // Stored account and personal data survive.
    expect(countRows('user', 'id', userId)).toBe(1);
    expect(countRows('personal_categories', 'user_id', userId)).toBe(1);
    expect(countRows('personal_links', 'user_id', userId)).toBe(1);

    // 1. The previously valid session is revoked: the target user's session rows
    //    are gone. This is deterministic database evidence, not an inference.
    expect(countRows('session', 'user_id', userId)).toBe(0);

    // 2. The old cookie no longer resolves to an authenticated session. Better
    //    Auth answers `get-session` with 200 and a null body when no session
    //    exists, so that null body is the contract being asserted — not the
    //    status code.
    const stale = await call('/api/auth/get-session', { cookie: userCookie });
    expect(await stale.json()).toBeNull();

    // ...and the old cookie is rejected by an authenticated application route.
    const staleProtected = await call('/api/personal/navigation', { cookie: userCookie });
    expect(staleProtected.status).toBe(401);

    // 3. The banned account cannot create a new session.
    //    Better Auth rejects a banned account with 403 BANNED_USER (not 401).
    expect(await signInStatus('normaluser', USER_PASSWORD)).toBe(403);
    expect(countRows('session', 'user_id', userId)).toBe(0);
  });

  it('re-enables the account and preserves personal data', async () => {
    const userId = await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'User',
      role: 'user',
      username: 'normaluser',
    });
    temp.handle.db.insert(personalCategories).values({ userId, name: '保留', sortOrder: 0, isDefault: false }).run();

    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    await call('/api/auth/admin/ban-user', { method: 'POST', cookie: adminCookie, body: { userId } });
    // 403 BANNED_USER from Better Auth — the account is refused, not merely unknown.
    expect(await signInStatus('normaluser', USER_PASSWORD)).toBe(403);

    const unbanned = await call('/api/auth/admin/unban-user', {
      method: 'POST',
      cookie: adminCookie,
      body: { userId },
    });
    expect(unbanned.status).toBe(200);

    expect(await signInStatus('normaluser', USER_PASSWORD)).toBe(200);
    // Data is untouched by the disable/re-enable cycle.
    expect(countRows('personal_categories', 'user_id', userId)).toBe(1);
  });

  it('rejects disabling the current admin (self)', async () => {
    const adminId = userIdByEmail('admin@example.com');
    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);

    const response = await call('/api/auth/admin/ban-user', {
      method: 'POST',
      cookie: adminCookie,
      body: { userId: adminId },
    });

    expect(response.status).toBe(400);
    const row = temp.handle.sqlite.prepare('select banned from user where id = ?').get(adminId) as { banned: number };
    expect(row.banned).toBe(0);
  });
});

describe('password reset', () => {
  it('replaces the password: old fails, new succeeds', async () => {
    const userId = await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'User',
      role: 'user',
      username: 'normaluser',
    });
    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);

    const response = await call('/api/auth/admin/set-user-password', {
      method: 'POST',
      cookie: adminCookie,
      body: { userId, newPassword: 'brand-new-password-456' },
    });
    expect(response.status).toBe(200);

    expect(await signInStatus('normaluser', USER_PASSWORD)).toBe(401);
    expect(await signInStatus('normaluser', 'brand-new-password-456')).toBe(200);
  });

  it('requires admin authorization', async () => {
    const userId = await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'User',
      role: 'user',
      username: 'normaluser',
    });

    expect(
      (await call('/api/auth/admin/set-user-password', {
        method: 'POST',
        body: { userId, newPassword: 'x-password-123' },
      })).status,
    ).toBe(401);
  });
});

describe('delete user with personal-data cascade', () => {
  it('removes only the deleted user and their personal data', async () => {
    // Two users, each with personal data.
    const userA = await provisionUser({
      email: 'a@example.com',
      password: USER_PASSWORD,
      name: 'A',
      role: 'user',
      username: 'usera',
    });
    const userB = await provisionUser({
      email: 'b@example.com',
      password: USER_PASSWORD,
      name: 'B',
      role: 'user',
      username: 'userb',
    });

    for (const [userId, label] of [
      [userA, 'A'],
      [userB, 'B'],
    ] as const) {
      temp.handle.db.insert(personalCategories).values({ userId, name: `${label} cat`, sortOrder: 0, isDefault: true }).run();
      const category = temp.handle.db.select().from(personalCategories).all().find((row) => row.userId === userId)!;
      temp.handle.db
        .insert(personalLinks)
        .values({ userId, categoryId: category.id, title: `${label} link`, url: 'https://example.com', normalizedUrl: 'https://example.com/', sortOrder: 0 })
        .run();
    }

    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    const response = await call('/api/auth/admin/remove-user', {
      method: 'POST',
      cookie: adminCookie,
      body: { userId: userA },
    });

    expect(response.status).toBe(200);

    // User A and everything owned by A is gone.
    expect(countRows('user', 'id', userA)).toBe(0);
    expect(countRows('account', 'user_id', userA)).toBe(0);
    expect(countRows('session', 'user_id', userA)).toBe(0);
    expect(countRows('personal_categories', 'user_id', userA)).toBe(0);
    expect(countRows('personal_links', 'user_id', userA)).toBe(0);

    // User B and B's data are untouched.
    expect(countRows('user', 'id', userB)).toBe(1);
    expect(countRows('personal_categories', 'user_id', userB)).toBe(1);
    expect(countRows('personal_links', 'user_id', userB)).toBe(1);
  });

  it('leaves the database consistent after deletion', async () => {
    const userA = await provisionUser({
      email: 'a@example.com',
      password: USER_PASSWORD,
      name: 'A',
      role: 'user',
      username: 'usera',
    });
    temp.handle.db.insert(personalCategories).values({ userId: userA, name: 'cat', sortOrder: 0, isDefault: true }).run();
    const category = temp.handle.db.select().from(personalCategories).all()[0]!;
    temp.handle.db
      .insert(personalLinks)
      .values({ userId: userA, categoryId: category.id, title: 'link', url: 'https://example.com', normalizedUrl: 'https://example.com/', sortOrder: 0 })
      .run();

    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    await call('/api/auth/admin/remove-user', { method: 'POST', cookie: adminCookie, body: { userId: userA } });

    expect(temp.handle.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(temp.handle.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects deleting the current admin (self)', async () => {
    const adminId = userIdByEmail('admin@example.com');
    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);

    const response = await call('/api/auth/admin/remove-user', {
      method: 'POST',
      cookie: adminCookie,
      body: { userId: adminId },
    });

    expect(response.status).toBe(400);
    expect(countRows('user', 'id', adminId)).toBe(1);
  });

  it('deleted user can no longer authenticate', async () => {
    const userId = await provisionUser({
      email: 'gone@example.com',
      password: USER_PASSWORD,
      name: 'Gone',
      role: 'user',
      username: 'goneuser',
    });
    expect(await signInStatus('goneuser', USER_PASSWORD)).toBe(200);

    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    await call('/api/auth/admin/remove-user', { method: 'POST', cookie: adminCookie, body: { userId } });

    expect(await signInStatus('goneuser', USER_PASSWORD)).toBe(401);
  });
});

describe('user management does not disturb unrelated data', () => {
  it('leaves public navigation and branding untouched', async () => {
    const { publicCategories, publicLinks, siteSettings } = await import('../../src/db/schema.js');
    temp.handle.db.insert(siteSettings).values({ siteName: 'Brand', defaultTheme: 'light', accessMode: 'public' }).run();
    temp.handle.db.insert(publicCategories).values({ name: 'Public', sortOrder: 0, isVisible: true }).run();
    const pubCat = temp.handle.db.select().from(publicCategories).all()[0]!;
    temp.handle.db
      .insert(publicLinks)
      .values({ categoryId: pubCat.id, title: 'Public Link', url: 'https://public.example.com/', sortOrder: 0, isVisible: true })
      .run();

    const userId = await provisionUser({
      email: 'temp@example.com',
      password: USER_PASSWORD,
      name: 'Temp',
      role: 'user',
      username: 'tempuser',
    });

    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    await call('/api/auth/admin/remove-user', { method: 'POST', cookie: adminCookie, body: { userId } });

    expect(temp.handle.db.select().from(publicCategories).all()).toHaveLength(1);
    expect(temp.handle.db.select().from(publicLinks).all()).toHaveLength(1);
    expect(temp.handle.db.select().from(siteSettings).all()).toHaveLength(1);
  });
});

describe('official user-list pagination', () => {
  it.each([101, 203])('reaches all %i accounts, including tied creation times', async (total) => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD);
    const stamp = Date.now() + 1000;
    const insert = temp.handle.sqlite.prepare(
      'insert into user(id, name, email, email_verified, created_at, updated_at, role, username) values (?, ?, ?, 1, ?, ?, ?, ?)',
    );
    for (let index = 0; index < total - 2; index++) {
      insert.run(`page-user-${String(index)}`, `Page User ${String(index)}`, `page${String(index)}@example.com`, stamp, stamp, 'user', `pageuser${String(index)}`);
    }
    const targetId = await provisionUser({
      email: 'last@example.com', username: 'lastuser', name: 'Last User', password: USER_PASSWORD, role: 'user',
    });
    temp.handle.sqlite.prepare('update user set created_at = ? where id = ?').run(stamp, targetId);
    type Page = { users: Array<{ id: string; banned: boolean }>; total: number };
    async function page(offset: number): Promise<Page> {
      const response = await call(`/api/auth/admin/list-users?limit=100&offset=${String(offset)}&sortBy=createdAt&sortDirection=asc`, { cookie });
      expect(response.status).toBe(200);
      return (await response.json()) as Page;
    }
    const ids: string[] = [];
    for (let offset = 0; offset < total; offset += 100) {
      const current = await page(offset);
      expect(current.total).toBe(total);
      expect(current.users).toHaveLength(Math.min(100, total - offset));
      expect((await page(offset)).users.map((user) => user.id)).toEqual(current.users.map((user) => user.id));
      ids.push(...current.users.map((user) => user.id));
    }
    expect(new Set(ids).size).toBe(total);
    expect(ids).toHaveLength(total);
    expect(ids.at(-1)).toBe(targetId);

    if (total === 101) {
      const ban = await call('/api/auth/admin/ban-user', { method: 'POST', cookie, body: { userId: targetId } });
      expect(ban.status).toBe(200);
      expect((await page(100)).users[0]!.banned).toBe(true);
      expect((await call('/api/auth/admin/unban-user', { method: 'POST', cookie, body: { userId: targetId } })).status).toBe(200);
      expect((await page(100)).users[0]!.banned).toBe(false);
      const newPassword = 'pagination-new-password-123';
      expect((await call('/api/auth/admin/set-user-password', { method: 'POST', cookie, body: { userId: targetId, newPassword } })).status).toBe(200);
      const userCookie = await loginCookie('lastuser', newPassword);
      expect((await call('/api/auth/admin/list-users?limit=100&offset=100&sortBy=createdAt&sortDirection=asc', { cookie: userCookie })).status).toBe(403);
      expect((await call('/api/auth/admin/remove-user', { method: 'POST', cookie, body: { userId: targetId } })).status).toBe(200);
      expect(await page(100)).toMatchObject({ users: [], total: 100 });
      expect((await page(0)).users).toHaveLength(100);
    }
  });
});
