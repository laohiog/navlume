import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { personalCategories, personalLinks } from '../../src/db/schema.js';
import { createApp } from '../../src/server/app.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

const BASE = TEST_AUTH_BASE_URL;
const PASSWORD = 'mutation-password-123';

let temp: TempDatabase;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

function app(): ReturnType<typeof createApp> {
  return createApp({ db: temp.handle.db, auth: temp.auth });
}

/** JSON mutation request through the real Hono app. */
/** HTTP methods that mutate personal data and therefore require a JSON media type. */
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Send a personal mutation request through the real Hono app.
 *
 * `application/json` is applied automatically to mutation methods — including
 * body-less DELETE, which the server's media-type guard also enforces. Pass
 * `omitContentType: true` to exercise the 415 path, or `headers` to override.
 */
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
    app().request(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body }) }),
  );
}

function get(path: string, cookie: string): Promise<Response> {
  return Promise.resolve(
    app().request(`${BASE}${path}`, { headers: { cookie, 'x-forwarded-for': nextIp() } }),
  );
}

async function provision(username: string, role: 'admin' | 'user' = 'user'): Promise<void> {
  await temp.auth.api.createUser({
    body: {
      email: `${username}@example.com`,
      password: PASSWORD,
      name: username,
      role,
      data: { username, emailVerified: true },
    },
  });
}

async function login(username: string): Promise<string> {
  const response = await app().request(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ username, password: PASSWORD }),
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

interface NavBody {
  categories: Array<{ id: number; name: string; sortOrder: number; isDefault: boolean; links: Array<{ id: number; title: string; url: string; normalizedUrl: string; categoryId: number; sortOrder: number }> }>;
}

async function nav(cookie: string): Promise<NavBody> {
  const response = await get('/api/personal/navigation', cookie);
  expect(response.status).toBe(200);
  return (await response.json()) as NavBody;
}

/** Default category id for the cookie's user. */
async function defaultCategoryId(cookie: string): Promise<number> {
  const body = await nav(cookie);
  const found = body.categories.find((category) => category.isDefault);
  if (found === undefined) {
    throw new Error('no default category');
  }
  return found.id;
}

function userIdOf(username: string): string {
  const row = temp.handle.sqlite
    .prepare('select id from user where username = ?')
    .get(username) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error(`no user ${username}`);
  }
  return row.id;
}

beforeEach(async () => {
  temp = createTempDatabase();
  await provision('usera');
  await provision('userb');
  await provision('adminuser', 'admin');
});

afterEach(() => {
  temp.dispose();
});

describe('authentication boundary for mutations', () => {
  it('denies every mutation route to a guest with 401', async () => {
    const attempts: Array<[string, string, unknown]> = [
      ['POST', '/api/personal/categories', { name: 'X' }],
      ['PATCH', '/api/personal/categories/1', { name: 'X' }],
      ['DELETE', '/api/personal/categories/1', undefined],
      ['PUT', '/api/personal/categories/order', { ids: [1] }],
      ['POST', '/api/personal/links', { categoryId: 1, title: 'T', url: 'https://e.com' }],
      ['PATCH', '/api/personal/links/1', { title: 'X' }],
      ['DELETE', '/api/personal/links/1', undefined],
      ['PUT', '/api/personal/links/order', { categoryId: 1, ids: [1] }],
    ];

    for (const [method, path, body] of attempts) {
      const response = await send(method, path, body === undefined ? {} : { body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('creates nothing when a guest attempts a mutation', async () => {
    await send('POST', '/api/personal/categories', { body: { name: 'Guest Cat' } });
    await send('POST', '/api/personal/links', { body: { categoryId: 1, title: 'T', url: 'https://e.com' } });

    expect(temp.handle.db.select().from(personalCategories).all()).toHaveLength(0);
    expect(temp.handle.db.select().from(personalLinks).all()).toHaveLength(0);
  });

  it('denies a forged session cookie', async () => {
    const response = await send('POST', '/api/personal/categories', {
      cookie: 'better-auth.session_token=forged.value',
      body: { name: 'X' },
    });
    expect(response.status).toBe(401);
  });

  it('denies a stale cookie after sign-out', async () => {
    const cookie = await login('usera');
    expect((await send('POST', '/api/personal/categories', { cookie, body: { name: 'Before' } })).status).toBe(201);

    const signOut = await app().request(`${BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE, 'x-forwarded-for': nextIp() },
      body: JSON.stringify({}),
    });
    expect(signOut.status).toBe(200);

    const after = await send('POST', '/api/personal/categories', { cookie, body: { name: 'After' } });
    expect(after.status).toBe(401);

    const names = temp.handle.db.select().from(personalCategories).all().map((row) => row.name);
    expect(names).not.toContain('After');
  });
});

describe('content-type boundary', () => {
  it('rejects a form-encoded mutation without modifying data', async () => {
    const cookie = await login('usera');

    const response = await send('POST', '/api/personal/categories', {
      cookie,
      rawBody: 'name=FormCat',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.status).toBe(415);
    const names = temp.handle.db.select().from(personalCategories).all().map((row) => row.name);
    expect(names).not.toContain('FormCat');
  });

  it('rejects text/plain and multipart mutations', async () => {
    const cookie = await login('usera');

    const plain = await send('POST', '/api/personal/categories', {
      cookie,
      rawBody: 'name=Plain',
      headers: { 'content-type': 'text/plain' },
    });
    expect(plain.status).toBe(415);

    const multipart = await send('POST', '/api/personal/categories', {
      cookie,
      rawBody: 'name=Multi',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(multipart.status).toBe(415);
  });

  it('rejects a malformed JSON body', async () => {
    const cookie = await login('usera');
    const response = await send('POST', '/api/personal/categories', {
      cookie,
      rawBody: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  it('accepts the JSON media type with parameters', async () => {
    const cookie = await login('usera');

    const withCharset = await send('POST', '/api/personal/categories', {
      cookie,
      body: { name: 'Charset' },
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(withCharset.status).toBe(201);
  });

  it('rejects a media type that merely contains application/json (S1 regression)', async () => {
    const cookie = await login('usera');

    const masquerade = await send('POST', '/api/personal/categories', {
      cookie,
      rawBody: 'name=Masquerade',
      headers: { 'content-type': 'text/plain; foo=application/json' },
    });

    expect(masquerade.status).toBe(415);
    const names = temp.handle.db.select().from(personalCategories).all().map((row) => row.name);
    expect(names).not.toContain('Masquerade');
  });

  it('rejects other JSON-ish media types', async () => {
    const cookie = await login('usera');

    for (const contentType of ['application/jsonp', 'application/problem+json', 'text/json']) {
      const response = await send('POST', '/api/personal/categories', {
        cookie,
        rawBody: '{"name":"Jsonish"}',
        headers: { 'content-type': contentType },
      });
      expect(response.status, contentType).toBe(415);
    }

    const names = temp.handle.db.select().from(personalCategories).all().map((row) => row.name);
    expect(names).not.toContain('Jsonish');
  });

  it('enforces the media type on PATCH with zero writes', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const before = await nav(cookie);

    const response = await send('PATCH', `/api/personal/categories/${categoryId}`, {
      cookie,
      rawBody: 'name=Patched',
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.status).toBe(415);
    expect(await nav(cookie)).toEqual(before);
  });

  it('enforces the media type on PUT reorder with zero writes', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const before = await nav(cookie);

    const response = await send('PUT', '/api/personal/categories/order', {
      cookie,
      rawBody: `{"ids":[${categoryId}]}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.status).toBe(415);
    expect(await nav(cookie)).toEqual(before);
  });

  it('enforces the media type on DELETE with zero writes (S1 regression)', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const created = (await (await send('POST', '/api/personal/categories', { cookie, body: { name: 'Keep Me' } })).json()) as { id: number };
    const link = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'Keep Link', url: 'https://keep.example.com' } })).json()) as { id: number };

    // No Content-Type at all.
    const noHeader = await send('DELETE', `/api/personal/categories/${created.id}`, {
      cookie,
      omitContentType: true,
    });
    expect(noHeader.status).toBe(415);

    // A non-JSON media type.
    const plain = await send('DELETE', `/api/personal/links/${link.id}`, {
      cookie,
      headers: { 'content-type': 'text/plain' },
    });
    expect(plain.status).toBe(415);

    // Both resources must still exist.
    const view = await nav(cookie);
    expect(view.categories.map((c) => c.name)).toContain('Keep Me');
    expect(view.categories.flatMap((c) => c.links).map((l) => l.title)).toContain('Keep Link');

    // The same requests with JSON still succeed.
    expect((await send('DELETE', `/api/personal/links/${link.id}`, { cookie })).status).toBe(204);
    expect((await send('DELETE', `/api/personal/categories/${created.id}`, { cookie })).status).toBe(204);
  });
});


describe('category CRUD', () => {
  it('creates a non-default category appended to the end', async () => {
    const cookie = await login('usera');
    await nav(cookie); // materialize default

    const created = await send('POST', '/api/personal/categories', { cookie, body: { name: '采购' } });

    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: number; name: string; sortOrder: number; isDefault: boolean };
    expect(body).toMatchObject({ name: '采购', isDefault: false });
    expect(Object.keys(body).sort()).toEqual(['id', 'isDefault', 'name', 'sortOrder']);

    const view = await nav(cookie);
    expect(view.categories.map((c) => c.name)).toEqual(['⭐ 我的常用', '采购']);
  });

  it('trims the name and rejects an empty one', async () => {
    const cookie = await login('usera');

    const trimmed = await send('POST', '/api/personal/categories', { cookie, body: { name: '  Tools  ' } });
    expect(trimmed.status).toBe(201);
    expect(((await trimmed.json()) as { name: string }).name).toBe('Tools');

    const empty = await send('POST', '/api/personal/categories', { cookie, body: { name: '   ' } });
    expect(empty.status).toBe(400);

    const missing = await send('POST', '/api/personal/categories', { cookie, body: {} });
    expect(missing.status).toBe(400);
  });

  it('ignores client-supplied userId and isDefault', async () => {
    const cookie = await login('usera');
    const userBId = userIdOf('userb');

    const response = await send('POST', '/api/personal/categories', {
      cookie,
      body: { name: 'Spoofed', userId: userBId, isDefault: true, id: 9999 },
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: number; isDefault: boolean };
    // Cannot be the id the client asked for, cannot be default.
    expect(created.id).not.toBe(9999);
    expect(created.isDefault).toBe(false);

    // Row is owned by A, not B.
    const row = temp.handle.db
      .select()
      .from(personalCategories)
      .where(eq(personalCategories.id, created.id))
      .get();
    expect(row?.userId).toBe(userIdOf('usera'));
  });

  it('renames a category', async () => {
    const cookie = await login('usera');
    const created = (await (await send('POST', '/api/personal/categories', { cookie, body: { name: 'Old' } })).json()) as { id: number };

    const renamed = await send('PATCH', `/api/personal/categories/${created.id}`, { cookie, body: { name: 'New' } });

    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { name: string }).name).toBe('New');
  });

  it('deletes a non-default category and cascades its links', async () => {
    const cookie = await login('usera');
    const created = (await (await send('POST', '/api/personal/categories', { cookie, body: { name: 'Doomed' } })).json()) as { id: number };

    const link = await send('POST', '/api/personal/links', {
      cookie,
      body: { categoryId: created.id, title: 'Doomed Link', url: 'https://doomed.example.com' },
    });
    expect(link.status).toBe(201);

    const deleted = await send('DELETE', `/api/personal/categories/${created.id}`, { cookie });
    expect(deleted.status).toBe(204);

    const view = await nav(cookie);
    expect(view.categories.map((c) => c.name)).not.toContain('Doomed');
    expect(view.categories.flatMap((c) => c.links)).toHaveLength(0);

    expect(temp.handle.sqlite.pragma('foreign_key_check')).toHaveLength(0);
  });

  it('refuses to delete the default category', async () => {
    const cookie = await login('usera');
    const defaultId = await defaultCategoryId(cookie);

    const response = await send('DELETE', `/api/personal/categories/${defaultId}`, { cookie });

    expect(response.status).toBe(409);
    const view = await nav(cookie);
    expect(view.categories.some((c) => c.isDefault)).toBe(true);
  });

  it('does not let the client change isDefault through PATCH', async () => {
    const cookie = await login('usera');
    const created = (await (await send('POST', '/api/personal/categories', { cookie, body: { name: 'Plain' } })).json()) as { id: number };

    await send('PATCH', `/api/personal/categories/${created.id}`, {
      cookie,
      body: { name: 'Still Plain', isDefault: true },
    });

    const row = temp.handle.db.select().from(personalCategories).where(eq(personalCategories.id, created.id)).get();
    expect(row?.isDefault).toBe(false);
  });
});

describe('category reorder', () => {
  it('rewrites order atomically', async () => {
    const cookie = await login('usera');
    const second = (await (await send('POST', '/api/personal/categories', { cookie, body: { name: 'Second' } })).json()) as { id: number };
    const third = (await (await send('POST', '/api/personal/categories', { cookie, body: { name: 'Third' } })).json()) as { id: number };
    const defaultId = await defaultCategoryId(cookie);

    const response = await send('PUT', '/api/personal/categories/order', {
      cookie,
      body: { ids: [third.id, defaultId, second.id] },
    });

    expect(response.status).toBe(200);
    const view = await nav(cookie);
    expect(view.categories.map((c) => c.name)).toEqual(['Third', '⭐ 我的常用', 'Second']);
    expect(view.categories.map((c) => c.sortOrder)).toEqual([0, 1, 2]);
  });

  it('rejects an incomplete id list with zero writes', async () => {
    const cookie = await login('usera');
    await send('POST', '/api/personal/categories', { cookie, body: { name: 'Second' } });
    const defaultId = await defaultCategoryId(cookie);
    const before = await nav(cookie);

    const response = await send('PUT', '/api/personal/categories/order', {
      cookie,
      body: { ids: [defaultId] },
    });

    expect(response.status).toBe(400);
    expect(await nav(cookie)).toEqual(before);
  });

  it('rejects duplicate ids with zero writes', async () => {
    const cookie = await login('usera');
    const defaultId = await defaultCategoryId(cookie);
    const before = await nav(cookie);

    const response = await send('PUT', '/api/personal/categories/order', {
      cookie,
      body: { ids: [defaultId, defaultId] },
    });

    expect(response.status).toBe(400);
    expect(await nav(cookie)).toEqual(before);
  });

  it('rejects a foreign category id with zero writes', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const defaultB = await defaultCategoryId(cookieB);
    const defaultA = await defaultCategoryId(cookieA);
    const before = await nav(cookieA);

    const response = await send('PUT', '/api/personal/categories/order', {
      cookie: cookieA,
      body: { ids: [defaultA, defaultB] },
    });

    expect(response.status).toBe(400);
    expect(await nav(cookieA)).toEqual(before);

    // B's ordering is untouched too.
    const viewB = await nav(cookieB);
    expect(viewB.categories).toHaveLength(1);
  });
});

describe('link CRUD', () => {
  it('creates a link in the caller\'s category with a server-derived normalized URL', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    const response = await send('POST', '/api/personal/links', {
      cookie,
      body: { categoryId, title: 'Example', url: 'example.com/path#frag' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: number;
      url: string;
      normalizedUrl: string;
      categoryId: number;
      sortOrder: number;
    };

    expect(body.url).toBe('example.com/path#frag');
    expect(body.normalizedUrl).toBe('https://example.com/path');
    expect(body.categoryId).toBe(categoryId);
    expect(Object.keys(body).sort()).toEqual([
      'categoryId', 'iconUrl', 'id', 'normalizedUrl', 'sortOrder', 'title', 'url',
    ]);
  });

  it('ignores a client-supplied normalizedUrl and userId', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    const response = await send('POST', '/api/personal/links', {
      cookie,
      body: {
        categoryId,
        title: 'Spoof',
        url: 'https://example.com',
        normalizedUrl: 'https://evil.example.com/',
        userId: userIdOf('userb'),
      },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { normalizedUrl: string; id: number };
    expect(body.normalizedUrl).toBe('https://example.com/');

    const row = temp.handle.db.select().from(personalLinks).where(eq(personalLinks.id, body.id)).get();
    expect(row?.userId).toBe(userIdOf('usera'));
    expect(row?.normalizedUrl).toBe('https://example.com/');
  });

  it('rejects dangerous URL schemes', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.com']) {
      const response = await send('POST', '/api/personal/links', {
        cookie,
        body: { categoryId, title: 'Bad', url },
      });
      expect(response.status, url).toBe(400);
    }
  });

  /**
   * Regression (S1): a numeric suffix must not smuggle a forbidden scheme past
   * validation, and the raw `url` column must never store one either.
   */
  it('rejects forbidden schemes with a numeric suffix and stores nothing (S1 regression)', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    const forbidden = [
      'javascript:1/alert(1)',
      'data:1/text/html,x',
      'file:80/etc/passwd',
      'ftp:21/path',
      'custom:80/path',
    ];

    for (const url of forbidden) {
      const response = await send('POST', '/api/personal/links', {
        cookie,
        body: { categoryId, title: 'Bad', url },
      });
      expect(response.status, url).toBe(400);
    }

    expect(temp.handle.db.select().from(personalLinks).all()).toHaveLength(0);
  });

  it('rejects a numeric-suffix scheme on PATCH and leaves the link unchanged', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const created = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'Safe', url: 'https://safe.example.com' } })).json()) as { id: number };

    for (const url of ['javascript:1/alert(1)', 'data:1/text/html,x', 'ftp:21/path']) {
      const response = await send('PATCH', `/api/personal/links/${created.id}`, {
        cookie,
        body: { url },
      });
      expect(response.status, url).toBe(400);
    }

    const row = temp.handle.db.select().from(personalLinks).where(eq(personalLinks.id, created.id)).get();
    expect(row?.url).toBe('https://safe.example.com');
    expect(row?.normalizedUrl).toBe('https://safe.example.com/');
  });

  it('still accepts host:port URLs (S1 regression guard)', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    const response = await send('POST', '/api/personal/links', {
      cookie,
      body: { categoryId, title: 'Port', url: 'example.com:8080/path' },
    });

    expect(response.status).toBe(201);
    expect(((await response.json()) as { normalizedUrl: string }).normalizedUrl).toBe(
      'https://example.com:8080/path',
    );
  });


  it('appends new links to the end of the category', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    // Distinct URLs: P4.3 rejects the same normalized URL twice in one category.
    for (const title of ['First', 'Second', 'Third']) {
      await send('POST', '/api/personal/links', { cookie, body: { categoryId, title, url: `https://${title.toLowerCase()}.example.com` } });
    }

    const view = await nav(cookie);
    expect(view.categories[0]?.links.map((l) => l.title)).toEqual(['First', 'Second', 'Third']);
    expect(view.categories[0]?.links.map((l) => l.sortOrder)).toEqual([0, 1, 2]);
  });

  it('updates title and re-normalizes a changed URL', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const created = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'Old', url: 'https://old.example.com' } })).json()) as { id: number };

    const response = await send('PATCH', `/api/personal/links/${created.id}`, {
      cookie,
      body: { title: 'New', url: 'new.example.com/x?q=1#f' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { title: string; url: string; normalizedUrl: string };
    expect(body.title).toBe('New');
    expect(body.url).toBe('new.example.com/x?q=1#f');
    expect(body.normalizedUrl).toBe('https://new.example.com/x?q=1');
  });

  it('rejects an invalid URL on update', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const created = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'T', url: 'https://ok.example.com' } })).json()) as { id: number };

    const response = await send('PATCH', `/api/personal/links/${created.id}`, {
      cookie,
      body: { url: 'javascript:alert(1)' },
    });

    expect(response.status).toBe(400);
    const row = temp.handle.db.select().from(personalLinks).where(eq(personalLinks.id, created.id)).get();
    expect(row?.url).toBe('https://ok.example.com');
  });

  it('moves a link between the caller\'s own categories', async () => {
    const cookie = await login('usera');
    const sourceId = await defaultCategoryId(cookie);
    const target = (await (await send('POST', '/api/personal/categories', { cookie, body: { name: 'Target' } })).json()) as { id: number };
    const link = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId: sourceId, title: 'Move Me', url: 'https://move.example.com' } })).json()) as { id: number };

    const response = await send('PATCH', `/api/personal/links/${link.id}`, {
      cookie,
      body: { categoryId: target.id },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { categoryId: number }).categoryId).toBe(target.id);

    const view = await nav(cookie);
    const targetCategory = view.categories.find((c) => c.id === target.id);
    expect(targetCategory?.links.map((l) => l.title)).toEqual(['Move Me']);
  });

  it('deletes a link', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const link = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'Bye', url: 'https://bye.example.com' } })).json()) as { id: number };

    const response = await send('DELETE', `/api/personal/links/${link.id}`, { cookie });

    expect(response.status).toBe(204);
    const view = await nav(cookie);
    expect(view.categories.flatMap((c) => c.links)).toHaveLength(0);
  });
});

describe('link reorder', () => {
  it('rewrites order atomically within a category', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const ids: number[] = [];
    for (const title of ['A', 'B', 'C']) {
      // Distinct URLs: P4.3 rejects the same normalized URL twice in one category.
      const created = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title, url: `https://order-${title.toLowerCase()}.example.com` } })).json()) as { id: number };
      ids.push(created.id);
    }

    const response = await send('PUT', '/api/personal/links/order', {
      cookie,
      body: { categoryId, ids: [ids[2], ids[0], ids[1]] },
    });

    expect(response.status).toBe(200);
    const view = await nav(cookie);
    expect(view.categories[0]?.links.map((l) => l.title)).toEqual(['C', 'A', 'B']);
    expect(view.categories[0]?.links.map((l) => l.sortOrder)).toEqual([0, 1, 2]);
  });

  it('rejects an incomplete id list with zero writes', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);
    const first = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'A', url: 'https://a.example.com' } })).json()) as { id: number };
    await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'B', url: 'https://b.example.com' } });
    const before = await nav(cookie);

    const response = await send('PUT', '/api/personal/links/order', {
      cookie,
      body: { categoryId, ids: [first.id] },
    });

    expect(response.status).toBe(400);
    expect(await nav(cookie)).toEqual(before);
  });

  it('rejects a foreign link id with zero writes', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const categoryA = await defaultCategoryId(cookieA);
    const categoryB = await defaultCategoryId(cookieB);
    const linkA = (await (await send('POST', '/api/personal/links', { cookie: cookieA, body: { categoryId: categoryA, title: 'A', url: 'https://a.example.com' } })).json()) as { id: number };
    const linkB = (await (await send('POST', '/api/personal/links', { cookie: cookieB, body: { categoryId: categoryB, title: 'B', url: 'https://b.example.com' } })).json()) as { id: number };
    const before = await nav(cookieA);

    const response = await send('PUT', '/api/personal/links/order', {
      cookie: cookieA,
      body: { categoryId: categoryA, ids: [linkA.id, linkB.id] },
    });

    expect(response.status).toBe(400);
    expect(await nav(cookieA)).toEqual(before);
  });

  it('rejects reordering a category that is not the caller\'s', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const categoryB = await defaultCategoryId(cookieB);

    const response = await send('PUT', '/api/personal/links/order', {
      cookie: cookieA,
      body: { categoryId: categoryB, ids: [] },
    });

    expect(response.status).toBe(404);
  });
});

describe('cross-user mutation isolation', () => {
  it('denies renaming/deleting another user\'s category', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const categoryB = await defaultCategoryId(cookieB);

    const rename = await send('PATCH', `/api/personal/categories/${categoryB}`, { cookie: cookieA, body: { name: 'Stolen' } });
    expect(rename.status).toBe(404);

    const remove = await send('DELETE', `/api/personal/categories/${categoryB}`, { cookie: cookieA });
    // 404 (not owned) rather than 409 (default) — ownership is checked first.
    expect(remove.status).toBe(404);

    const viewB = await nav(cookieB);
    expect(viewB.categories[0]?.name).toBe('⭐ 我的常用');
  });

  it('denies creating a link inside another user\'s category', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const categoryB = await defaultCategoryId(cookieB);

    const response = await send('POST', '/api/personal/links', {
      cookie: cookieA,
      body: { categoryId: categoryB, title: 'Intruder', url: 'https://intruder.example.com' },
    });

    expect(response.status).toBe(404);
    const viewB = await nav(cookieB);
    expect(viewB.categories[0]?.links).toHaveLength(0);
  });

  it('denies editing/moving/deleting another user\'s link', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const categoryA = await defaultCategoryId(cookieA);
    const categoryB = await defaultCategoryId(cookieB);
    const linkB = (await (await send('POST', '/api/personal/links', { cookie: cookieB, body: { categoryId: categoryB, title: 'B Link', url: 'https://b.example.com' } })).json()) as { id: number };

    expect((await send('PATCH', `/api/personal/links/${linkB.id}`, { cookie: cookieA, body: { title: 'Stolen' } })).status).toBe(404);
    expect((await send('PATCH', `/api/personal/links/${linkB.id}`, { cookie: cookieA, body: { categoryId: categoryA } })).status).toBe(404);
    expect((await send('DELETE', `/api/personal/links/${linkB.id}`, { cookie: cookieA })).status).toBe(404);

    const viewB = await nav(cookieB);
    expect(viewB.categories[0]?.links.map((l) => l.title)).toEqual(['B Link']);

    // Ownership verified in the database: the read API intentionally omits
    // `categoryId` from link payloads.
    const rowB = temp.handle.db.select().from(personalLinks).where(eq(personalLinks.id, linkB.id)).get();
    expect(rowB?.categoryId).toBe(categoryB);
    expect(rowB?.title).toBe('B Link');
  });

  it('denies moving an own link into another user\'s category', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const categoryA = await defaultCategoryId(cookieA);
    const categoryB = await defaultCategoryId(cookieB);
    const linkA = (await (await send('POST', '/api/personal/links', { cookie: cookieA, body: { categoryId: categoryA, title: 'A Link', url: 'https://a.example.com' } })).json()) as { id: number };

    const response = await send('PATCH', `/api/personal/links/${linkA.id}`, {
      cookie: cookieA,
      body: { categoryId: categoryB },
    });

    expect(response.status).toBe(404);

    // The link stayed in A's own category.
    const rowA = temp.handle.db.select().from(personalLinks).where(eq(personalLinks.id, linkA.id)).get();
    expect(rowA?.categoryId).toBe(categoryA);
  });

  it('does not leak ownership through differing error bodies', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');
    const categoryB = await defaultCategoryId(cookieB);

    const foreign = await send('PATCH', `/api/personal/categories/${categoryB}`, { cookie: cookieA, body: { name: 'X' } });
    const missing = await send('PATCH', '/api/personal/categories/99999999', { cookie: cookieA, body: { name: 'X' } });

    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it('gives an admin no cross-user personal privilege', async () => {
    const cookieA = await login('usera');
    const cookieAdmin = await login('adminuser');
    const categoryA = await defaultCategoryId(cookieA);

    const rename = await send('PATCH', `/api/personal/categories/${categoryA}`, { cookie: cookieAdmin, body: { name: 'Admin Owned' } });
    expect(rename.status).toBe(404);

    const link = await send('POST', '/api/personal/links', {
      cookie: cookieAdmin,
      body: { categoryId: categoryA, title: 'Admin Intruder', url: 'https://x.example.com' },
    });
    expect(link.status).toBe(404);

    const viewA = await nav(cookieA);
    expect(viewA.categories[0]?.name).toBe('⭐ 我的常用');
  });
});

describe('identity spoofing across mutation surfaces', () => {
  it('ignores body/query/header identity claims', async () => {
    const cookieA = await login('usera');
    const userBId = userIdOf('userb');
    const categoryB = await defaultCategoryId(await login('userb'));

    // Body + query + headers all claim to be B (or an admin).
    const create = await send('POST', `/api/personal/categories?userId=${userBId}&role=admin`, {
      cookie: cookieA,
      body: { name: 'Spoofed Cat', userId: userBId, ownerId: userBId, username: 'userb', role: 'admin' },
      headers: { 'x-user-id': userBId, 'x-role': 'admin', 'x-authenticated': 'true', 'x-forwarded-user': 'userb' },
    });

    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: number };
    const row = temp.handle.db.select().from(personalCategories).where(eq(personalCategories.id, created.id)).get();
    expect(row?.userId).toBe(userIdOf('usera'));

    // Still cannot touch B's category.
    const steal = await send('PATCH', `/api/personal/categories/${categoryB}?userId=${userBId}`, {
      cookie: cookieA,
      body: { name: 'Stolen', userId: userBId },
      headers: { 'x-user-id': userBId, 'x-role': 'admin' },
    });
    expect(steal.status).toBe(404);
  });
});

describe('persistence readback', () => {
  it('returns mutations through a freshly authenticated session', async () => {
    const cookieA = await login('usera');
    const categoryId = await defaultCategoryId(cookieA);

    const category = (await (await send('POST', '/api/personal/categories', { cookie: cookieA, body: { name: 'Persisted' } })).json()) as { id: number };
    const link = (await (await send('POST', '/api/personal/links', { cookie: cookieA, body: { categoryId: category.id, title: 'Persisted Link', url: 'https://persist.example.com' } })).json()) as { id: number };
    await send('PUT', '/api/personal/categories/order', { cookie: cookieA, body: { ids: [category.id, categoryId] } });
    await send('PATCH', `/api/personal/links/${link.id}`, { cookie: cookieA, body: { title: 'Renamed Link' } });

    // Brand-new session for the same user.
    const freshCookie = await login('usera');
    const view = await nav(freshCookie);

    expect(view.categories.map((c) => c.name)).toEqual(['Persisted', '⭐ 我的常用']);
    const persisted = view.categories.find((c) => c.name === 'Persisted');
    expect(persisted?.links.map((l) => l.title)).toEqual(['Renamed Link']);

    // And it is genuinely in SQLite.
    const row = temp.handle.sqlite.prepare('select title from personal_links where id = ?').get(link.id) as { title: string };
    expect(row.title).toBe('Renamed Link');
  });
});

describe('updated_at maintenance', () => {
  it('advances updated_at on rename, reorder, and link update', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    const before = temp.handle.db.select().from(personalCategories).where(eq(personalCategories.id, categoryId)).get();
    expect(before?.updatedAt).toBeInstanceOf(Date);

    // Backdate so the change is observable without sleeping.
    const old = new Date(Date.now() - 60_000);
    temp.handle.db.update(personalCategories).set({ updatedAt: old }).where(eq(personalCategories.id, categoryId)).run();

    await send('PATCH', `/api/personal/categories/${categoryId}`, { cookie, body: { name: 'Renamed' } });
    const renamed = temp.handle.db.select().from(personalCategories).where(eq(personalCategories.id, categoryId)).get();
    expect(renamed?.updatedAt.getTime()).toBeGreaterThan(old.getTime());

    const link = (await (await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'T', url: 'https://e.com' } })).json()) as { id: number };
    temp.handle.db.update(personalLinks).set({ updatedAt: old }).where(eq(personalLinks.id, link.id)).run();

    await send('PATCH', `/api/personal/links/${link.id}`, { cookie, body: { title: 'T2' } });
    const updatedLink = temp.handle.db.select().from(personalLinks).where(eq(personalLinks.id, link.id)).get();
    expect(updatedLink?.updatedAt.getTime()).toBeGreaterThan(old.getTime());

    temp.handle.db.update(personalCategories).set({ updatedAt: old }).where(eq(personalCategories.id, categoryId)).run();
    await send('PUT', '/api/personal/categories/order', { cookie, body: { ids: [categoryId] } });
    const reordered = temp.handle.db.select().from(personalCategories).where(eq(personalCategories.id, categoryId)).get();
    expect(reordered?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });
});

describe('response safety', () => {
  it('never exposes internal fields in mutation responses', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    const category = await send('POST', '/api/personal/categories', { cookie, body: { name: 'Safe' } });
    const link = await send('POST', '/api/personal/links', { cookie, body: { categoryId, title: 'Safe', url: 'https://safe.example.com' } });

    for (const response of [category, link]) {
      const text = await response.clone().text();
      expect(text).not.toContain('userId');
      expect(text).not.toContain('user_id');
      expect(text).not.toContain('password');
      expect(text).not.toMatch(/SQLITE|sqlite|\.sqlite|stack/i);
    }
  });

  it('returns a generic error for an unexpected failure', async () => {
    const cookie = await login('usera');
    // Materialize the default category so the request reaches the link query
    // rather than failing ownership validation first.
    const categoryId = await defaultCategoryId(cookie);

    // Drop a table the mutation path needs, forcing a genuine internal error.
    temp.handle.sqlite.exec('drop table personal_links');

    const response = await send('POST', '/api/personal/links', {
      cookie,
      body: { categoryId, title: 'T', url: 'https://e.com' },
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Internal Server Error' });
    expect(text).not.toMatch(/SQLITE|no such table|\.sqlite/);
  });
});

/**
 * P4.3 — duplicate link handling.
 *
 * Duplicate identity is: authenticated user + target category + server-generated
 * normalized_url. The same URL in two different categories is deliberately
 * allowed; a conflict must perform zero writes.
 */
describe('duplicate link handling', () => {
  /** Create a category owned by `cookie` and return its id. */
  async function createCategory(cookie: string, name: string): Promise<number> {
    const response = await send('POST', '/api/personal/categories', { cookie, body: { name } });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: number }).id;
  }

  function createLink(
    cookie: string,
    categoryId: number,
    title: string,
    url: string,
  ): Promise<Response> {
    return send('POST', '/api/personal/links', { cookie, body: { categoryId, title, url } });
  }

  function linksIn(categoryId: number) {
    return temp.handle.db
      .select()
      .from(personalLinks)
      .where(eq(personalLinks.categoryId, categoryId))
      .all();
  }

  it('rejects the same normalized URL in the same category with zero writes', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    expect((await createLink(cookie, categoryId, 'First', 'https://dup.example.com/path')).status).toBe(201);

    const before = linksIn(categoryId);
    expect(before).toHaveLength(1);

    const duplicate = await createLink(cookie, categoryId, 'Second', 'https://dup.example.com/path');
    expect(duplicate.status).toBe(409);

    const rows = linksIn(categoryId);
    expect(rows).toHaveLength(1);
    // The original row is untouched.
    expect(rows[0]?.title).toBe('First');
    expect(rows[0]?.normalizedUrl).toBe('https://dup.example.com/path');
  });

  it('treats raw variants that normalize equally as duplicates', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    expect((await createLink(cookie, categoryId, 'Bare', 'dup2.example.com/path')).status).toBe(201);

    // Scheme-less vs absolute, and a differing fragment, both normalize to the
    // same value and must therefore conflict.
    for (const variant of ['https://dup2.example.com/path', 'https://dup2.example.com/path#frag']) {
      const response = await createLink(cookie, categoryId, 'Variant', variant);
      expect(response.status, variant).toBe(409);
    }

    expect(linksIn(categoryId)).toHaveLength(1);
  });

  it('allows the same normalized URL in a different category of the same user', async () => {
    const cookie = await login('usera');
    const defaultId = await defaultCategoryId(cookie);
    const otherId = await createCategory(cookie, 'Other');

    expect((await createLink(cookie, defaultId, 'Here', 'https://same.example.com')).status).toBe(201);
    expect((await createLink(cookie, otherId, 'There', 'https://same.example.com')).status).toBe(201);

    expect(linksIn(defaultId)).toHaveLength(1);
    expect(linksIn(otherId)).toHaveLength(1);
  });

  it('does not leak a conflict across users', async () => {
    const cookieA = await login('usera');
    const cookieB = await login('userb');

    const categoryA = await defaultCategoryId(cookieA);
    const categoryB = await defaultCategoryId(cookieB);

    expect((await createLink(cookieA, categoryA, 'A Link', 'https://shared.example.com')).status).toBe(201);

    // User B must not be blocked by user A's row.
    expect((await createLink(cookieB, categoryB, 'B Link', 'https://shared.example.com')).status).toBe(201);

    expect(linksIn(categoryA)).toHaveLength(1);
    expect(linksIn(categoryB)).toHaveLength(1);
  });

  it('keeps distinct normalized URLs separate in the same category', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    expect((await createLink(cookie, categoryId, 'One', 'https://q.example.com/path?a=1')).status).toBe(201);
    expect((await createLink(cookie, categoryId, 'Two', 'https://q.example.com/path?a=2')).status).toBe(201);

    expect(linksIn(categoryId)).toHaveLength(2);
  });

  it('lets a link re-save its own unchanged URL and category', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    const created = (await (
      await createLink(cookie, categoryId, 'Self', 'https://self.example.com')
    ).json()) as { id: number };

    for (const body of [
      { title: 'Self Renamed' },
      { url: 'https://self.example.com' },
      { url: 'self.example.com' },
      { title: 'Again', url: 'https://self.example.com' },
    ]) {
      const response = await send('PATCH', `/api/personal/links/${created.id}`, { cookie, body });
      expect(response.status, JSON.stringify(body)).toBe(200);
    }
  });

  it('rejects an update that collides with another link in the same category', async () => {
    const cookie = await login('usera');
    const categoryId = await defaultCategoryId(cookie);

    await createLink(cookie, categoryId, 'A', 'https://collide-a.example.com');
    const b = (await (
      await createLink(cookie, categoryId, 'B', 'https://collide-b.example.com')
    ).json()) as { id: number };

    const before = linksIn(categoryId).find((row) => row.id === b.id);
    const response = await send('PATCH', `/api/personal/links/${b.id}`, {
      cookie,
      body: { url: 'https://collide-a.example.com' },
    });

    expect(response.status).toBe(409);
    // Zero partial writes: B's row is unchanged.
    const after = linksIn(categoryId).find((row) => row.id === b.id);
    expect(after?.url).toBe(before?.url);
    expect(after?.normalizedUrl).toBe(before?.normalizedUrl);
    expect(linksIn(categoryId)).toHaveLength(2);
  });

  it('rejects moving a link into a category that already holds that URL, with no move', async () => {
    const cookie = await login('usera');
    const source = await defaultCategoryId(cookie);
    const target = await createCategory(cookie, 'Target');

    await createLink(cookie, target, 'Occupant', 'https://move.example.com');
    const moving = (await (
      await createLink(cookie, source, 'Moving', 'https://move.example.com')
    ).json()) as { id: number };

    const response = await send('PATCH', `/api/personal/links/${moving.id}`, {
      cookie,
      body: { categoryId: target },
    });

    expect(response.status).toBe(409);

    const row = temp.handle.db
      .select()
      .from(personalLinks)
      .where(eq(personalLinks.id, moving.id))
      .get();
    // No move, and no partial sort-order update.
    expect(row?.categoryId).toBe(source);
    expect(linksIn(target)).toHaveLength(1);
  });

  it('allows moving a link when the destination has no such URL', async () => {
    const cookie = await login('usera');
    const source = await defaultCategoryId(cookie);
    const target = await createCategory(cookie, 'Empty Target');

    const moving = (await (
      await createLink(cookie, source, 'Moving', 'https://free.example.com')
    ).json()) as { id: number };

    const response = await send('PATCH', `/api/personal/links/${moving.id}`, {
      cookie,
      body: { categoryId: target },
    });

    expect(response.status).toBe(200);
    expect(linksIn(target)).toHaveLength(1);
    expect(linksIn(source)).toHaveLength(0);
  });

  it('rejects a move combined with a URL change that collides', async () => {
    const cookie = await login('usera');
    const source = await defaultCategoryId(cookie);
    const target = await createCategory(cookie, 'Combo Target');

    await createLink(cookie, target, 'Occupant', 'https://combo.example.com');
    const moving = (await (
      await createLink(cookie, source, 'Moving', 'https://combo-other.example.com')
    ).json()) as { id: number };

    const response = await send('PATCH', `/api/personal/links/${moving.id}`, {
      cookie,
      body: { categoryId: target, url: 'https://combo.example.com' },
    });

    expect(response.status).toBe(409);

    const row = temp.handle.db
      .select()
      .from(personalLinks)
      .where(eq(personalLinks.id, moving.id))
      .get();
    expect(row?.categoryId).toBe(source);
    expect(row?.normalizedUrl).toBe('https://combo-other.example.com/');
  });
});
