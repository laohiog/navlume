import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

const BASE = TEST_AUTH_BASE_URL;
const ADMIN_PASSWORD = 'admin-password-123';
const USER_PASSWORD = 'user-password-123';

let temp: TempDatabase;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

/**
 * Call a Better Auth endpoint through the real Hono app.
 *
 * This is the security boundary: it exercises Better Auth's own server-side
 * permission checks, not a test double.
 */
function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers({ 'x-forwarded-for': nextIp(), ...options.headers });

  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }

  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  return Promise.resolve(
    createApp({ db: temp.handle.db, auth: temp.auth }).request(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
}

/** Server-side user provisioning used only to arrange the admin under test. */
async function provisionUser(options: {
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

async function loginCookie(username: string, password: string): Promise<string> {
  const response = await call('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username, password },
    headers: { origin: BASE },
  });

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

const CREATE_USER_BODY = {
  email: 'created@example.com',
  password: 'created-password-123',
  name: 'Created User',
  role: 'user',
  data: { username: 'createduser', emailVerified: true },
};

beforeEach(() => {
  temp = createTempDatabase();
});

afterEach(() => {
  temp.dispose();
});

describe('Admin surface — authorization matrix', () => {
  beforeEach(async () => {
    await provisionUser({
      email: 'admin@example.com',
      password: ADMIN_PASSWORD,
      name: 'Admin',
      role: 'admin',
      username: 'admin',
    });
    await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'Normal User',
      role: 'user',
      username: 'normaluser',
    });
  });

  describe('GET /api/auth/admin/list-users', () => {
    it('denies a guest (401)', async () => {
      const response = await call('/api/auth/admin/list-users');

      expect(response.status).toBe(401);
      // Better Auth returns an empty body for this unauthorized case.
      expect(await response.text()).toBe('');
    });

    it('denies a normal user (403)', async () => {
      const cookie = await loginCookie('normaluser', USER_PASSWORD);
      const response = await call('/api/auth/admin/list-users', { cookie });

      expect(response.status).toBe(403);
      const body = (await response.json()) as { users?: unknown; code?: string };
      expect(body.users).toBeUndefined();
      expect(body.code).toBe('YOU_ARE_NOT_ALLOWED_TO_LIST_USERS');
    });

    it('allows an admin (200)', async () => {
      const cookie = await loginCookie('admin', ADMIN_PASSWORD);
      const response = await call('/api/auth/admin/list-users', { cookie });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { users?: Array<{ email?: string }> };
      expect(body.users?.map((user) => user.email)).toContain('user@example.com');
    });
  });

  describe('POST /api/auth/admin/create-user', () => {
    it('denies a guest (401) and creates nothing', async () => {
      const response = await call('/api/auth/admin/create-user', {
        method: 'POST',
        body: CREATE_USER_BODY,
      });

      expect(response.status).toBe(401);
      expect(temp.handle.sqlite.prepare('select count(*) c from user').get()).toEqual({ c: 2 });
    });

    it('denies a normal user (403) and creates nothing', async () => {
      const cookie = await loginCookie('normaluser', USER_PASSWORD);
      const response = await call('/api/auth/admin/create-user', {
        method: 'POST',
        body: CREATE_USER_BODY,
        cookie,
      });

      expect(response.status).toBe(403);
      expect(temp.handle.sqlite.prepare('select count(*) c from user').get()).toEqual({ c: 2 });
    });

    it('allows an admin to create a normal user through the official HTTP API', async () => {
      const cookie = await loginCookie('admin', ADMIN_PASSWORD);
      const response = await call('/api/auth/admin/create-user', {
        method: 'POST',
        body: CREATE_USER_BODY,
        cookie,
      });

      expect(response.status).toBe(200);

      const row = temp.handle.sqlite
        .prepare('select email, role, username from user where email = ?')
        .get('created@example.com') as { email: string; role: string; username: string } | undefined;

      expect(row).toEqual({ email: 'created@example.com', role: 'user', username: 'createduser' });
    });
  });

  describe('Admin impersonation is disabled', () => {
    it.each([
      '/api/auth/admin/impersonate-user',
      '/api/auth/admin/impersonate-user/',
    ])('rejects %s without creating a session or changing personal-data access', async (path) => {
      const userCookie = await loginCookie('normaluser', USER_PASSWORD);
      const userSession = await call('/api/auth/get-session', { cookie: userCookie });
      expect(userSession.status).toBe(200);
      const target = (await userSession.json()) as { user: { id: string } };

      const userNavigation = await call('/api/personal/navigation', { cookie: userCookie });
      expect(userNavigation.status).toBe(200);
      const userData = (await userNavigation.json()) as { categories: Array<{ id: number }> };
      const privateTitle = 'Target user private destination';
      const privateUrl = 'https://example.com/target-private';
      const createdLink = await call('/api/personal/links', {
        method: 'POST',
        cookie: userCookie,
        body: { categoryId: userData.categories[0]!.id, title: privateTitle, url: privateUrl },
      });
      expect(createdLink.status).toBe(201);

      const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
      const originalSessionResponse = await call('/api/auth/get-session', { cookie: adminCookie });
      expect(originalSessionResponse.status).toBe(200);
      const originalSession = (await originalSessionResponse.json()) as {
        user: { id: string; role: string };
        session: { id: string };
      };
      expect(originalSession.user.id).not.toBe(target.user.id);
      const originalNavigation = await call('/api/personal/navigation', { cookie: adminCookie });
      expect(originalNavigation.status).toBe(200);
      const originalData: unknown = await originalNavigation.json();
      const originalExport = await call('/api/personal/data-export', { cookie: adminCookie });
      expect(originalExport.status).toBe(200);
      const originalDocument: unknown = await originalExport.json();
      const sessionsBefore = temp.handle.sqlite.prepare('select * from session order by id').all();

      const rejected = await call(path, {
        method: 'POST',
        cookie: adminCookie,
        headers: { origin: BASE },
        body: { userId: target.user.id },
      });

      expect(rejected.status).toBe(404);
      expect(rejected.headers.getSetCookie()).toHaveLength(0);
      const rejectedBody = await rejected.text();
      expect(rejectedBody).not.toContain(target.user.id);
      expect(rejectedBody).not.toContain(privateTitle);
      expect(rejectedBody).not.toContain(privateUrl);
      expect(temp.handle.sqlite.prepare('select * from session order by id').all()).toEqual(sessionsBefore);

      const sessionResponse = await call('/api/auth/get-session', { cookie: adminCookie });
      expect(sessionResponse.status).toBe(200);
      expect(await sessionResponse.json()).toMatchObject({
        user: { id: originalSession.user.id, role: 'admin' },
        session: { id: originalSession.session.id },
      });

      const navigation = await call('/api/personal/navigation', { cookie: adminCookie });
      expect(navigation.status).toBe(200);
      expect(await navigation.json()).toEqual(originalData);
      const exported = await call('/api/personal/data-export', { cookie: adminCookie });
      expect(exported.status).toBe(200);
      expect(await exported.json()).toEqual(originalDocument);
      for (const payload of [originalData, originalDocument]) {
        expect(JSON.stringify(payload)).not.toContain(privateTitle);
        expect(JSON.stringify(payload)).not.toContain(privateUrl);
      }
    });
  });
});

describe('Admin-created user lifecycle', () => {
  beforeEach(async () => {
    await provisionUser({
      email: 'admin@example.com',
      password: ADMIN_PASSWORD,
      name: 'Admin',
      role: 'admin',
      username: 'admin',
    });
  });

  it('can sign in with username/password and has role user without admin rights', async () => {
    const adminCookie = await loginCookie('admin', ADMIN_PASSWORD);
    const created = await call('/api/auth/admin/create-user', {
      method: 'POST',
      body: CREATE_USER_BODY,
      cookie: adminCookie,
    });
    expect(created.status).toBe(200);

    // The admin-created user can authenticate.
    const userCookie = await loginCookie('createduser', 'created-password-123');

    const session = await call('/api/auth/get-session', { cookie: userCookie });
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as { user?: { email?: string; role?: string } };
    expect(sessionBody.user?.email).toBe('created@example.com');
    expect(sessionBody.user?.role).toBe('user');

    // ...but has no admin capability.
    const listUsers = await call('/api/auth/admin/list-users', { cookie: userCookie });
    expect(listUsers.status).toBe(403);

    const createAnother = await call('/api/auth/admin/create-user', {
      method: 'POST',
      body: { ...CREATE_USER_BODY, email: 'other@example.com', data: { username: 'otheruser' } },
      cookie: userCookie,
    });
    expect(createAnother.status).toBe(403);
  });
});

describe('Role and identity spoofing', () => {
  beforeEach(async () => {
    await provisionUser({
      email: 'user@example.com',
      password: USER_PASSWORD,
      name: 'Normal User',
      role: 'user',
      username: 'normaluser',
    });
  });

  it('ignores query-parameter and header claims of admin identity', async () => {
    const cookie = await loginCookie('normaluser', USER_PASSWORD);

    const response = await call(
      '/api/auth/admin/list-users?role=admin&userId=1&username=admin&authenticated=true',
      {
        cookie,
        headers: {
          'x-role': 'admin',
          'x-user-id': '1',
          'x-authenticated': 'true',
          'x-forwarded-user': 'admin',
        },
      },
    );

    expect(response.status).toBe(403);
  });

  it('ignores spoofed identity without any session', async () => {
    const response = await call(
      '/api/auth/admin/list-users?role=admin&userId=1&authenticated=true',
      { headers: { 'x-role': 'admin', 'x-user-id': '1', 'x-authenticated': 'true' } },
    );

    expect(response.status).toBe(401);
  });

  it('ignores a forged cookie with a spoofed identity', async () => {
    const response = await call('/api/auth/admin/list-users?role=admin', {
      cookie: 'better-auth.session_token=forged.value',
      headers: { 'x-role': 'admin' },
    });

    expect(response.status).toBe(401);
  });

  it('does not let a normal user escalate their own role through the user API', async () => {
    const cookie = await loginCookie('normaluser', USER_PASSWORD);

    const response = await call('/api/auth/admin/set-role', {
      method: 'POST',
      body: { userId: '1', role: 'admin' },
      cookie,
    });

    expect(response.ok).toBe(false);

    // Their role in the database is unchanged.
    const row = temp.handle.sqlite
      .prepare("select role from user where email = 'user@example.com'")
      .get() as { role: string };
    expect(row.role).toBe('user');
  });
});

describe('Public signup boundary regression', () => {
  it('still rejects public email/password sign-up and exposes no username lookup', async () => {
    const signUp = await call('/api/auth/sign-up/email', {
      method: 'POST',
      body: { email: 'intruder@example.com', password: 'intruder-password-123', name: 'X' },
      headers: { origin: BASE },
    });

    expect(signUp.ok).toBe(false);
    const body = (await signUp.json()) as { code?: string };
    expect(body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
    expect(temp.handle.sqlite.prepare('select count(*) c from user').get()).toEqual({ c: 0 });

    const lookup = await call('/api/auth/is-username-available', {
      method: 'POST',
      body: { username: 'admin' },
    });
    expect(lookup.status).toBe(404);
  });
});
