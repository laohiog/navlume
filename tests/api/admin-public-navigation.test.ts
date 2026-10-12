import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publicCategories, publicLinks } from '../../src/db/schema.js';
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

function app(): ReturnType<typeof createApp> {
  return createApp({ db: temp.handle.db, auth: temp.auth });
}

/** HTTP methods that mutate public data and therefore require a JSON media type. */
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function send(
  method: string,
  path: string,
  options: {
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: string;
    omitContentType?: boolean;
  } = {},
): Promise<Response> {
  const headers = new Headers({ 'x-forwarded-for': nextIp(), ...options.headers });

  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }

  if (
    MUTATION_METHODS.has(method) &&
    options.omitContentType !== true &&
    !headers.has('content-type')
  ) {
    headers.set('content-type', 'application/json');
  }

  return Promise.resolve(
    app().request(`${BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
}

async function provision(username: string, role: 'admin' | 'user'): Promise<void> {
  await temp.auth.api.createUser({
    body: {
      email: `${username}@example.com`,
      password: role === 'admin' ? ADMIN_PASSWORD : USER_PASSWORD,
      name: username,
      role,
      data: { username, emailVerified: true },
    },
  });
}

async function login(username: string, password: string): Promise<string> {
  const response = await app().request(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ username, password }),
  });

  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('better-auth.session_token='));

  if (session === undefined) {
    throw new Error('no session cookie');
  }

  return session.split(';')[0] ?? '';
}

interface AdminCategory {
  id: number;
  name: string;
  icon: string | null;
  sortOrder: number;
  isVisible: boolean;
  links: AdminLink[];
}

interface AdminLink {
  id: number;
  categoryId: number;
  title: string;
  url: string;
  description: string | null;
  iconUrl: string | null;
  sortOrder: number;
  isVisible: boolean;
}

async function adminNav(cookie: string): Promise<{ categories: AdminCategory[] }> {
  const response = await send('GET', '/api/admin/public-navigation', { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as { categories: AdminCategory[] };
}

async function publicNav(cookie?: string): Promise<{ categories: { id: number; name: string; links: { id: number; title: string; url: string }[] }[] }> {
  const response = await send('GET', '/api/public/navigation', cookie === undefined ? {} : { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    categories: { id: number; name: string; links: { id: number; title: string; url: string }[] }[];
  };
}

async function createCategory(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return send('POST', '/api/admin/public/categories', { cookie, body });
}

async function createLink(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return send('POST', '/api/admin/public/links', { cookie, body });
}

function categoryRows() {
  return temp.handle.db.select().from(publicCategories).all();
}

function linkRows() {
  return temp.handle.db.select().from(publicLinks).all();
}

beforeEach(async () => {
  temp = createTempDatabase();
  await provision('admina', 'admin');
  await provision('normalb', 'user');
  // Start from an empty public navigation so assertions are unambiguous.
  temp.handle.db.delete(publicLinks).run();
  temp.handle.db.delete(publicCategories).run();
});

afterEach(() => {
  temp.dispose();
});

describe('admin authorization boundary', () => {
  it('returns 401 to a guest', async () => {
    const response = await send('GET', '/api/admin/public-navigation');
    expect(response.status).toBe(401);
  });

  it('returns 403 to an authenticated non-admin', async () => {
    const cookie = await login('normalb', USER_PASSWORD);
    const response = await send('GET', '/api/admin/public-navigation', { cookie });
    expect(response.status).toBe(403);
  });

  it('allows an admin', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const response = await send('GET', '/api/admin/public-navigation', { cookie });
    expect(response.status).toBe(200);
  });

  it('rejects every admin route for a guest with 401', async () => {
    const attempts: Array<[string, string, unknown]> = [
      ['GET', '/api/admin/public-navigation', undefined],
      ['POST', '/api/admin/public/categories', { name: 'X' }],
      ['PATCH', '/api/admin/public/categories/1', { name: 'X' }],
      ['DELETE', '/api/admin/public/categories/1', undefined],
      ['PUT', '/api/admin/public/categories/order', { ids: [1] }],
      ['POST', '/api/admin/public/links', { categoryId: 1, title: 'T', url: 'https://e.com' }],
      ['PATCH', '/api/admin/public/links/1', { title: 'X' }],
      ['DELETE', '/api/admin/public/links/1', undefined],
      ['PUT', '/api/admin/public/links/order', { categoryId: 1, ids: [1] }],
    ];

    for (const [method, path, body] of attempts) {
      const response = await send(method, path, body === undefined ? {} : { body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('rejects every admin route for a non-admin with 403', async () => {
    const cookie = await login('normalb', USER_PASSWORD);

    const attempts: Array<[string, string, unknown]> = [
      ['GET', '/api/admin/public-navigation', undefined],
      ['POST', '/api/admin/public/categories', { name: 'X' }],
      ['PATCH', '/api/admin/public/categories/1', { name: 'X' }],
      ['DELETE', '/api/admin/public/categories/1', undefined],
      ['PUT', '/api/admin/public/categories/order', { ids: [1] }],
      ['POST', '/api/admin/public/links', { categoryId: 1, title: 'T', url: 'https://e.com' }],
      ['PATCH', '/api/admin/public/links/1', { title: 'X' }],
      ['DELETE', '/api/admin/public/links/1', undefined],
      ['PUT', '/api/admin/public/links/order', { categoryId: 1, ids: [1] }],
    ];

    for (const [method, path, body] of attempts) {
      const response = await send(method, path, { cookie, ...(body === undefined ? {} : { body }) });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('is not fooled by role spoofing through query, header, or body', async () => {
    const spoofed = [
      { path: '/api/admin/public-navigation?role=admin' },
      { path: '/api/admin/public-navigation?userId=1' },
      { path: '/api/admin/public-navigation', headers: { 'x-role': 'admin' } },
      { path: '/api/admin/public-navigation', headers: { 'x-user-id': '1' } },
      { path: '/api/admin/public-navigation', headers: { 'x-authenticated': 'true' } },
      { path: '/api/admin/public-navigation', headers: { 'x-forwarded-user': 'admina' } },
      { path: '/api/admin/public-navigation', headers: { 'x-forwarded-role': 'admin' } },
    ];

    for (const attempt of spoofed) {
      const response = await send('GET', attempt.path, {
        ...('headers' in attempt && attempt.headers !== undefined ? { headers: attempt.headers } : {}),
      });
      expect(response.status, JSON.stringify(attempt)).toBe(401);
    }
  });

  it('rejects a forged session cookie', async () => {
    const response = await send('GET', '/api/admin/public-navigation', {
      cookie: 'better-auth.session_token=forged-not-a-real-token',
    });

    expect(response.status).toBe(401);
  });

  it('does not let a body role field grant admin to a non-admin', async () => {
    const cookie = await login('normalb', USER_PASSWORD);

    const response = await createCategory(cookie, { name: 'Spoofed', role: 'admin' });

    expect(response.status).toBe(403);
    expect(categoryRows()).toHaveLength(0);
  });

  it('enforces the JSON media type on admin mutations', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('POST', '/api/admin/public/categories', {
      cookie,
      rawBody: 'name=X',
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.status).toBe(415);
    expect(categoryRows()).toHaveLength(0);
  });

  it('rejects a malformed JSON body', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('POST', '/api/admin/public/categories', {
      cookie,
      rawBody: '{not json',
    });

    expect(response.status).toBe(400);
  });
});

describe('admin read model', () => {
  it('returns hidden rows that the public endpoint omits', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const visibleCategory = (await (await createCategory(cookie, { name: 'Visible Cat' })).json()) as { id: number };
    const hiddenCategory = (await (
      await createCategory(cookie, { name: 'Hidden Cat', isVisible: false })
    ).json()) as { id: number };

    await createLink(cookie, { categoryId: visibleCategory.id, title: 'Visible Link', url: 'https://visible.example.com' });
    await createLink(cookie, {
      categoryId: visibleCategory.id,
      title: 'Hidden Link',
      url: 'https://hidden.example.com',
      isVisible: false,
    });

    const admin = await adminNav(cookie);
    const names = admin.categories.map((category) => category.name);
    expect(names).toContain('Visible Cat');
    expect(names).toContain('Hidden Cat');
    expect(admin.categories.find((category) => category.id === hiddenCategory.id)?.isVisible).toBe(false);
    expect(admin.categories.flatMap((category) => category.links.map((link) => link.title))).toEqual(
      expect.arrayContaining(['Visible Link', 'Hidden Link']),
    );

    const publicResult = await publicNav();
    expect(publicResult.categories.map((category) => category.name)).toEqual(['Visible Cat']);
    expect(publicResult.categories[0]?.links.map((link) => link.title)).toEqual(['Visible Link']);
  });

  it('orders by sortOrder then id', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    await createCategory(cookie, { name: 'First' });
    await createCategory(cookie, { name: 'Second' });
    await createCategory(cookie, { name: 'Third' });

    const admin = await adminNav(cookie);
    expect(admin.categories.map((category) => category.name)).toEqual(['First', 'Second', 'Third']);
    expect(admin.categories.map((category) => category.sortOrder)).toEqual([0, 1, 2]);
  });

  it('does not expose hidden rows to a normal user', async () => {
    const adminCookie = await login('admina', ADMIN_PASSWORD);
    await createCategory(adminCookie, { name: 'Hidden From Users', isVisible: false });

    const userCookie = await login('normalb', USER_PASSWORD);
    const response = await send('GET', '/api/admin/public-navigation', { cookie: userCookie });

    expect(response.status).toBe(403);
  });
});

describe('category mutations', () => {
  it('creates a category appended at the end, defaulting to visible', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const first = (await (await createCategory(cookie, { name: 'A' })).json()) as { sortOrder: number; isVisible: boolean };
    const second = (await (await createCategory(cookie, { name: 'B' })).json()) as { sortOrder: number; isVisible: boolean };

    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    expect(first.isVisible).toBe(true);
  });

  it('ignores a client-supplied sortOrder and id', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const created = (await (
      await createCategory(cookie, { name: 'C', sortOrder: 99, id: 500 })
    ).json()) as { id: number; sortOrder: number };

    expect(created.sortOrder).toBe(0);
    expect(created.id).not.toBe(500);
  });

  it('rejects an empty or non-string name', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    expect((await createCategory(cookie, { name: '   ' })).status).toBe(400);
    expect((await createCategory(cookie, { name: 42 })).status).toBe(400);
    expect(categoryRows()).toHaveLength(0);
  });

  it('updates name, icon and visibility', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const created = (await (await createCategory(cookie, { name: 'Old' })).json()) as { id: number };

    const response = await send('PATCH', `/api/admin/public/categories/${created.id}`, {
      cookie,
      body: { name: 'New', icon: 'star', isVisible: false },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { name: string; icon: string; isVisible: boolean };
    expect(body.name).toBe('New');
    expect(body.icon).toBe('star');
    expect(body.isVisible).toBe(false);
  });

  it('hides a category from the public endpoint without touching its links', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const category = (await (await createCategory(cookie, { name: 'Toggle' })).json()) as { id: number };
    await createLink(cookie, { categoryId: category.id, title: 'Kept', url: 'https://kept.example.com' });

    await send('PATCH', `/api/admin/public/categories/${category.id}`, { cookie, body: { isVisible: false } });

    expect((await publicNav()).categories).toHaveLength(0);
    // The link is untouched: still present and still visible.
    expect(linkRows()).toHaveLength(1);
    expect(linkRows()[0]?.isVisible).toBe(true);
    const admin = await adminNav(cookie);
    expect(admin.categories[0]?.isVisible).toBe(false);
    expect(admin.categories[0]?.links).toHaveLength(1);

    await send('PATCH', `/api/admin/public/categories/${category.id}`, { cookie, body: { isVisible: true } });
    expect((await publicNav()).categories).toHaveLength(1);
  });

  it('returns 404 for an unknown category', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const response = await send('PATCH', '/api/admin/public/categories/99999', { cookie, body: { name: 'X' } });
    expect(response.status).toBe(404);
  });

  it('deletes a category and cascades to its links', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const category = (await (await createCategory(cookie, { name: 'Doomed' })).json()) as { id: number };
    const keep = (await (await createCategory(cookie, { name: 'Kept' })).json()) as { id: number };

    await createLink(cookie, { categoryId: category.id, title: 'Gone', url: 'https://gone.example.com' });
    await createLink(cookie, { categoryId: keep.id, title: 'Stays', url: 'https://stays.example.com' });

    const response = await send('DELETE', `/api/admin/public/categories/${category.id}`, { cookie });

    expect(response.status).toBe(204);
    const remaining = categoryRows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(keep.id);
    const links = linkRows();
    expect(links).toHaveLength(1);
    expect(links[0]?.title).toBe('Stays');
  });

  it('returns 404 when deleting an unknown category', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    expect((await send('DELETE', '/api/admin/public/categories/99999', { cookie })).status).toBe(404);
  });
});

describe('category reorder', () => {
  async function seedThree(cookie: string): Promise<number[]> {
    const a = (await (await createCategory(cookie, { name: 'A' })).json()) as { id: number };
    const b = (await (await createCategory(cookie, { name: 'B', isVisible: false })).json()) as { id: number };
    const c = (await (await createCategory(cookie, { name: 'C' })).json()) as { id: number };
    return [a.id, b.id, c.id];
  }

  it('reorders all categories including hidden ones into contiguous order', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const [a, b, c] = await seedThree(cookie);

    const response = await send('PUT', '/api/admin/public/categories/order', {
      cookie,
      body: { ids: [c, a, b] },
    });

    expect(response.status).toBe(200);
    const admin = await adminNav(cookie);
    expect(admin.categories.map((category) => category.name)).toEqual(['C', 'A', 'B']);
    expect(admin.categories.map((category) => category.sortOrder)).toEqual([0, 1, 2]);
  });

  it('makes the public order follow the visible subset', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const [a, b, c] = await seedThree(cookie);

    await send('PUT', '/api/admin/public/categories/order', { cookie, body: { ids: [c, b, a] } });

    // B is hidden, so the public order is C then A.
    expect((await publicNav()).categories.map((category) => category.name)).toEqual(['C', 'A']);
    expect(linkRows()).toHaveLength(0);
    expect(categoryRows()).toHaveLength(3);
  });

  it.each([
    ['duplicate ids', (ids: number[]) => [ids[0], ids[0], ids[2]]],
    ['missing id', (ids: number[]) => [ids[0], ids[1]]],
    ['unknown id', (ids: number[]) => [ids[0], ids[1], 99999]],
  ])('rejects %s with zero writes', async (_label, mutate) => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const ids = await seedThree(cookie);
    const before = categoryRows().map((row) => ({ id: row.id, sortOrder: row.sortOrder }));

    const response = await send('PUT', '/api/admin/public/categories/order', {
      cookie,
      body: { ids: mutate(ids) },
    });

    expect(response.status).toBe(400);
    const after = categoryRows().map((row) => ({ id: row.id, sortOrder: row.sortOrder }));
    expect(after.sort((x, y) => x.id - y.id)).toEqual(before.sort((x, y) => x.id - y.id));
  });
});

describe('link mutations', () => {
  async function seedCategory(cookie: string, name = 'Cat'): Promise<number> {
    return ((await (await createCategory(cookie, { name })).json()) as { id: number }).id;
  }

  it('creates a link with an absolute URL', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);

    const response = await createLink(cookie, {
      categoryId,
      title: 'Absolute',
      url: 'https://absolute.example.com/path',
      description: 'A description',
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string; sortOrder: number; isVisible: boolean };
    expect(body.url).toBe('https://absolute.example.com/path');
    expect(body.sortOrder).toBe(0);
    expect(body.isVisible).toBe(true);
  });

  it('stores a scheme-less URL as a canonical absolute HTTP(S) URL', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);

    const body = (await (await createLink(cookie, { categoryId, title: 'Bare', url: 'example.com' })).json()) as {
      url: string;
    };

    expect(body.url).toBe('https://example.com/');
    // Stored value must be absolute, never a scheme-less string that a browser
    // could resolve relative to the current page.
    expect(body.url.startsWith('http')).toBe(true);
    expect(linkRows()[0]?.url).toBe('https://example.com/');
  });

  it.each([
    ['javascript:alert(1)'],
    ['javascript:80'],
    ['data:text/html,x'],
    ['file:///etc/passwd'],
    ['ftp://example.com'],
    ['vbscript:msgbox'],
  ])('rejects forbidden URL %s', async (url) => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);

    const response = await createLink(cookie, { categoryId, title: 'Bad', url });

    expect(response.status, url).toBe(400);
    expect(linkRows()).toHaveLength(0);
  });

  it('returns 404 for an unknown target category with zero writes', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await createLink(cookie, { categoryId: 99999, title: 'Orphan', url: 'https://o.example.com' });

    expect(response.status).toBe(404);
    expect(linkRows()).toHaveLength(0);
  });

  it('appends new links to the end of the category', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);

    for (const title of ['One', 'Two', 'Three']) {
      await createLink(cookie, { categoryId, title, url: `https://${title.toLowerCase()}.example.com` });
    }

    const admin = await adminNav(cookie);
    expect(admin.categories[0]?.links.map((link) => link.title)).toEqual(['One', 'Two', 'Three']);
    expect(admin.categories[0]?.links.map((link) => link.sortOrder)).toEqual([0, 1, 2]);
  });

  it('updates title, url, description and visibility', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);
    const link = (await (
      await createLink(cookie, { categoryId, title: 'Before', url: 'https://before.example.com' })
    ).json()) as { id: number };

    const response = await send('PATCH', `/api/admin/public/links/${link.id}`, {
      cookie,
      body: { title: 'After', url: 'after.example.com', description: '  trimmed  ', isVisible: false },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { title: string; url: string; description: string; isVisible: boolean };
    expect(body.title).toBe('After');
    expect(body.url).toBe('https://after.example.com/');
    expect(body.description).toBe('trimmed');
    expect(body.isVisible).toBe(false);
  });

  it('moves a link to another category, appending to the destination', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const source = await seedCategory(cookie, 'Source');
    const target = await seedCategory(cookie, 'Target');

    await createLink(cookie, { categoryId: target, title: 'Existing', url: 'https://existing.example.com' });
    const moving = (await (
      await createLink(cookie, { categoryId: source, title: 'Moving', url: 'https://moving.example.com' })
    ).json()) as { id: number };

    const response = await send('PATCH', `/api/admin/public/links/${moving.id}`, {
      cookie,
      body: { categoryId: target },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { categoryId: number; sortOrder: number };
    expect(body.categoryId).toBe(target);
    expect(body.sortOrder).toBe(1);

    const admin = await adminNav(cookie);
    const destination = admin.categories.find((category) => category.id === target);
    expect(destination?.links.map((link) => link.title)).toEqual(['Existing', 'Moving']);
  });

  it('rejects a move to an unknown category with zero partial writes', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);
    const link = (await (
      await createLink(cookie, { categoryId, title: 'Stable', url: 'https://stable.example.com' })
    ).json()) as { id: number };

    const before = linkRows()[0];
    const response = await send('PATCH', `/api/admin/public/links/${link.id}`, {
      cookie,
      body: { categoryId: 99999, title: 'Changed' },
    });

    expect(response.status).toBe(404);
    const after = linkRows()[0];
    expect(after?.categoryId).toBe(before?.categoryId);
    expect(after?.title).toBe(before?.title);
  });

  it('hides a link from the public endpoint but keeps it in the admin model', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);
    const link = (await (
      await createLink(cookie, { categoryId, title: 'Toggle', url: 'https://toggle.example.com' })
    ).json()) as { id: number };

    await send('PATCH', `/api/admin/public/links/${link.id}`, { cookie, body: { isVisible: false } });

    expect((await publicNav()).categories[0]?.links).toHaveLength(0);
    const admin = await adminNav(cookie);
    expect(admin.categories[0]?.links).toHaveLength(1);
    expect(admin.categories[0]?.links[0]?.isVisible).toBe(false);

    await send('PATCH', `/api/admin/public/links/${link.id}`, { cookie, body: { isVisible: true } });
    expect((await publicNav()).categories[0]?.links).toHaveLength(1);
  });

  it('deletes only the selected link', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);
    const keep = (await (
      await createLink(cookie, { categoryId, title: 'Keep', url: 'https://keep.example.com' })
    ).json()) as { id: number };
    const drop = (await (
      await createLink(cookie, { categoryId, title: 'Drop', url: 'https://drop.example.com' })
    ).json()) as { id: number };

    const response = await send('DELETE', `/api/admin/public/links/${drop.id}`, { cookie });

    expect(response.status).toBe(204);
    const rows = linkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(keep.id);
  });

  it('returns 404 for an unknown link', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    expect((await send('DELETE', '/api/admin/public/links/99999', { cookie })).status).toBe(404);
  });

  it('allows duplicate public URLs, unlike personal links', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = await seedCategory(cookie);

    expect((await createLink(cookie, { categoryId, title: 'A', url: 'https://dup.example.com' })).status).toBe(201);
    expect((await createLink(cookie, { categoryId, title: 'B', url: 'https://dup.example.com' })).status).toBe(201);

    expect(linkRows()).toHaveLength(2);
  });
});

describe('link reorder', () => {
  async function seedLinks(cookie: string, categoryId: number, titles: string[], hiddenAt?: number): Promise<number[]> {
    const ids: number[] = [];

    for (const [index, title] of titles.entries()) {
      const body: Record<string, unknown> = {
        categoryId,
        title,
        url: `https://${title.toLowerCase()}.example.com`,
      };

      if (hiddenAt === index) {
        body.isVisible = false;
      }

      ids.push(((await (await createLink(cookie, body)).json()) as { id: number }).id);
    }

    return ids;
  }

  it('reorders links including hidden ones into contiguous order', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = ((await (await createCategory(cookie, { name: 'C' })).json()) as { id: number }).id;
    const [a, b, c] = await seedLinks(cookie, categoryId, ['A', 'B', 'C'], 1);

    const response = await send('PUT', '/api/admin/public/links/order', {
      cookie,
      body: { categoryId, ids: [c, a, b] },
    });

    expect(response.status).toBe(200);
    const links = (await adminNav(cookie)).categories[0]?.links ?? [];
    expect(links.map((link) => link.title)).toEqual(['C', 'A', 'B']);
    expect(links.map((link) => link.sortOrder)).toEqual([0, 1, 2]);
  });

  it.each([
    ['duplicate ids', (ids: number[]) => [ids[0], ids[0]]],
    ['missing id', (ids: number[]) => [ids[0]]],
    ['unknown id', (ids: number[]) => [ids[0], 99999]],
  ])('rejects %s with zero writes', async (_label, mutate) => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = ((await (await createCategory(cookie, { name: 'C' })).json()) as { id: number }).id;
    const ids = await seedLinks(cookie, categoryId, ['A', 'B']);
    const before = linkRows().map((row) => ({ id: row.id, sortOrder: row.sortOrder })).sort((x, y) => x.id - y.id);

    const response = await send('PUT', '/api/admin/public/links/order', {
      cookie,
      body: { categoryId, ids: mutate(ids) },
    });

    expect(response.status).toBe(400);
    const after = linkRows().map((row) => ({ id: row.id, sortOrder: row.sortOrder })).sort((x, y) => x.id - y.id);
    expect(after).toEqual(before);
  });

  it('rejects ids belonging to another category', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const first = ((await (await createCategory(cookie, { name: 'First' })).json()) as { id: number }).id;
    const second = ((await (await createCategory(cookie, { name: 'Second' })).json()) as { id: number }).id;
    const firstIds = await seedLinks(cookie, first, ['A']);
    const secondIds = await seedLinks(cookie, second, ['B']);

    const response = await send('PUT', '/api/admin/public/links/order', {
      cookie,
      body: { categoryId: first, ids: [firstIds[0], secondIds[0]] },
    });

    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown category', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const response = await send('PUT', '/api/admin/public/links/order', {
      cookie,
      body: { categoryId: 99999, ids: [] },
    });

    expect(response.status).toBe(404);
  });
});

describe('public regression under admin mutations', () => {
  it('keeps the ordinary public endpoint free of hidden rows', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const visible = ((await (await createCategory(cookie, { name: 'Shown' })).json()) as { id: number }).id;
    const hidden = ((await (await createCategory(cookie, { name: 'Unseen', isVisible: false })).json()) as { id: number }).id;

    await createLink(cookie, { categoryId: visible, title: 'Public', url: 'https://public.example.com' });
    await createLink(cookie, { categoryId: hidden, title: 'Secret', url: 'https://secret.example.com' });

    const payload = JSON.stringify(await publicNav());
    expect(payload).toContain('Public');
    expect(payload).not.toContain('Secret');
    expect(payload).not.toContain('Unseen');
  });

  it('never exposes timestamps through the admin model', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await createCategory(cookie, { name: 'C' });

    const response = await send('GET', '/api/admin/public-navigation', { cookie });
    const payload = JSON.stringify(await response.json());

    expect(payload).not.toContain('createdAt');
    expect(payload).not.toContain('updatedAt');
  });

  it('does not create a personal-link side effect', async () => {
    const { personalCategories, personalLinks } = await import('../../src/db/schema.js');
    const cookie = await login('admina', ADMIN_PASSWORD);
    const categoryId = ((await (await createCategory(cookie, { name: 'Site' })).json()) as { id: number }).id;
    await createLink(cookie, { categoryId, title: 'Site Link', url: 'https://site.example.com' });

    expect(temp.handle.db.select().from(personalCategories).all()).toHaveLength(0);
    expect(temp.handle.db.select().from(personalLinks).all()).toHaveLength(0);
  });
});

/**
 * P5.1 TARGETED FIX #1 — authorization precedence on the Admin DELETE routes.
 *
 * The admin session/role check is the security boundary for `/api/admin/*`, so it
 * must run before request media-type validation. Previously both DELETE routes
 * checked the JSON media type first, which meant an unauthorized caller with no
 * `Content-Type` received 415 instead of the required 401/403 — leaking the
 * mutation contract to callers who were never authorized to reach it.
 *
 * These tests deliberately send **no** `Content-Type` (`omitContentType`) so they
 * exercise the branch the auto-adding `send()` helper previously masked. The IDs
 * are intentionally unknown: authorization must win before ID or media checks.
 */
describe('admin DELETE authorization precedence', () => {
  const deleteRoutes = [
    '/api/admin/public/categories/99999',
    '/api/admin/public/links/99999',
  ] as const;

  it('returns 401 to a guest without a Content-Type', async () => {
    for (const path of deleteRoutes) {
      const response = await send('DELETE', path, { omitContentType: true });
      expect(response.status, `guest DELETE ${path} (no content-type)`).toBe(401);
    }
  });

  it('returns 403 to an authenticated non-admin without a Content-Type', async () => {
    const cookie = await login('normalb', USER_PASSWORD);

    for (const path of deleteRoutes) {
      const response = await send('DELETE', path, { cookie, omitContentType: true });
      expect(response.status, `user DELETE ${path} (no content-type)`).toBe(403);
    }
  });

  it('returns 415 only once the caller is an authorized admin', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    for (const path of deleteRoutes) {
      const response = await send('DELETE', path, { cookie, omitContentType: true });
      // The media-type contract is preserved, but it is reached only after
      // authorization succeeds.
      expect(response.status, `admin DELETE ${path} (no content-type)`).toBe(415);
    }
  });

  it('does not leak the media-type contract ahead of authorization', async () => {
    // A caller who is not authorized must never see a 415, regardless of what
    // media type they send (or omit).
    const userCookie = await login('normalb', USER_PASSWORD);

    for (const path of deleteRoutes) {
      for (const omitted of [true, false]) {
        const response = await send('DELETE', path, {
          cookie: userCookie,
          ...(omitted
            ? { omitContentType: true }
            : { rawBody: '', headers: { 'content-type': 'text/plain' } }),
        });
        expect(response.status, `user DELETE ${path} omitted=${String(omitted)}`).toBe(403);
      }
    }
  });

  it('still performs a real admin DELETE with a JSON Content-Type', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const category = (await (await createCategory(cookie, { name: 'ToDelete' })).json()) as { id: number };

    const response = await send('DELETE', `/api/admin/public/categories/${category.id}`, { cookie });

    expect(response.status).toBe(204);
    expect(categoryRows()).toHaveLength(0);
  });

  it('still rejects spoofed identity on DELETE without a Content-Type', async () => {
    const spoofed: Record<string, string>[] = [
      { 'x-role': 'admin' },
      { 'x-user-id': '1' },
      { 'x-authenticated': 'true' },
      { 'x-forwarded-user': 'admina' },
    ];

    for (const headers of spoofed) {
      const response = await send('DELETE', '/api/admin/public/categories/99999', {
        headers,
        omitContentType: true,
      });
      expect(response.status, JSON.stringify(headers)).toBe(401);
    }
  });
});
