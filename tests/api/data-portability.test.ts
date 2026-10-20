import { afterEach, describe, expect, it } from 'vitest';

import {
  personalCategories,
  personalLinks,
  publicCategories,
  publicLinks,
  siteSettings,
} from '../../src/db/schema.js';
import { createApp } from '../../src/server/app.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

const BASE = TEST_AUTH_BASE_URL;
const ADMIN_PASSWORD = 'admin-password-123';
const USER_PASSWORD = 'user-password-123';

let temp: TempDatabase;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${String((ipCounter % 250) + 1)}`;
}

function app(): ReturnType<typeof createApp> {
  return createApp({ db: temp.handle.db, auth: temp.auth });
}

function send(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers({ 'x-forwarded-for': nextIp(), ...options.headers });

  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('content-type', 'application/json');
  }

  return Promise.resolve(
    app().request(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body }) }),
  );
}

async function signIn(username: string, password: string): Promise<string> {
  const response = await app().request(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ username, password }),
  });

  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('better-auth.session_token='));

  if (cookie === undefined) {
    throw new Error(`Sign-in failed for ${username} (status ${String(response.status)})`);
  }

  return cookie.split(';')[0]!;
}

async function createUser(email: string, username: string, password: string, role: 'admin' | 'user') {
  await temp.auth.api.createUser({
    body: {
      email,
      password,
      name: username,
      role,
      data: { username, emailVerified: true },
    },
  });
}

/** Seed one admin, one regular user, public navigation, and personal navigation. */
async function seed(): Promise<{ adminCookie: string; userCookie: string; userId: string }> {
  temp = createTempDatabase();

  await createUser('admin@example.com', 'adminuser', ADMIN_PASSWORD, 'admin');
  await createUser('user@example.com', 'normaluser', USER_PASSWORD, 'user');

  const adminCookie = await signIn('adminuser', ADMIN_PASSWORD);
  const userCookie = await signIn('normaluser', USER_PASSWORD);

  temp.handle.db
    .insert(siteSettings)
    .values({
      siteName: 'Seed Site',
      primaryColor: '#336699',
      defaultTheme: 'light',
      accessMode: 'public',
      tagline: 'Seeded',
      footerText: 'Footer',
      logoPath: '/api/public/brand-assets/logo.png',
      faviconPath: '/api/public/brand-assets/favicon.ico',
      backgroundImagePath: '/api/public/brand-assets/background.webp',
      pageBackgroundColor: '#123456',
      surfaceColor: '#ABCDEF',
    })
    .run();

  const category = temp.handle.db
    .insert(publicCategories)
    .values({ name: 'Public Tools', sortOrder: 0, isVisible: true })
    .returning()
    .get();

  temp.handle.db
    .insert(publicLinks)
    .values({
      categoryId: category.id,
      title: 'Public Link',
      url: 'https://public.example.com/',
      sortOrder: 0,
      isVisible: true,
    })
    .run();

  const userId = (
    temp.handle.sqlite.prepare('select id from user where username = ?').get('normaluser') as {
      id: string;
    }
  ).id;

  const personalCategory = temp.handle.db
    .insert(personalCategories)
    .values({ userId, name: 'Personal Tools', sortOrder: 0, isDefault: true })
    .returning()
    .get();

  temp.handle.db
    .insert(personalLinks)
    .values({
      userId,
      categoryId: personalCategory.id,
      title: 'Personal Link',
      url: 'https://personal.example.com/',
      normalizedUrl: 'https://personal.example.com/',
      sortOrder: 0,
    })
    .run();

  return { adminCookie, userCookie, userId };
}

afterEach(() => {
  temp.dispose();
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

describe('data portability authorization', () => {
  it('rejects anonymous access to site export', async () => {
    await seed();

    const response = await send('GET', '/api/admin/data-export/site');

    expect(response.status).toBe(401);
  });

  it('rejects a non-admin user for site export', async () => {
    const { userCookie } = await seed();

    const response = await send('GET', '/api/admin/data-export/site', { cookie: userCookie });

    expect(response.status).toBe(403);
  });

  it('allows an admin to export site data', async () => {
    const { adminCookie } = await seed();

    const response = await send('GET', '/api/admin/data-export/site', { cookie: adminCookie });

    expect(response.status).toBe(200);
  });

  it('rejects a non-admin user for every site import endpoint', async () => {
    const { userCookie, adminCookie } = await seed();

    const siteDocument = await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json();

    const endpoints: [string, string][] = [
      ['POST', '/api/admin/data-import/site/preview'],
      ['POST', '/api/admin/data-import/site/apply'],
    ];

    for (const [method, path] of endpoints) {
      const response = await send(method, path, {
        cookie: userCookie,
        body: { confirm: true, document: siteDocument },
      });

      expect(response.status).toBe(403);
    }
  });

  it('rejects anonymous access to every personal portability endpoint', async () => {
    await seed();

    expect((await send('GET', '/api/personal/data-export')).status).toBe(401);
    expect((await send('POST', '/api/personal/data-import/preview', { body: {} })).status).toBe(401);
    expect((await send('POST', '/api/personal/data-import/apply', { body: {} })).status).toBe(401);
  });

  it('allows an authenticated user to export their own personal data', async () => {
    const { userCookie } = await seed();

    const response = await send('GET', '/api/personal/data-export', { cookie: userCookie });

    expect(response.status).toBe(200);
  });

  it('requires a JSON media type on import endpoints', async () => {
    const { adminCookie } = await seed();

    const response = await send('POST', '/api/admin/data-import/site/preview', {
      cookie: adminCookie,
      headers: { 'content-type': 'text/plain' },
      body: { document: {} },
    });

    // The client sends a string body with an overridden media type.
    expect([400, 415]).toContain(response.status);
  });
});

/* -------------------------------------------------------------------------- */
/* Export shape                                                                */
/* -------------------------------------------------------------------------- */

describe('site export document', () => {
  it('produces a versioned, typed document without asset paths', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;

    expect(document['schema_version']).toBe(1);
    expect(document['type']).toBe('site');
    expect(Object.keys(document['site_settings'] as object).sort()).toEqual([
      'access_mode',
      'default_theme',
      'footer_text',
      // T1: exported so a home-page appearance survives export/import. It is a
      // JSON document, not an asset path, so it carries no instance-local risk.
      'home_theme_config',
      'page_background_color',
      'primary_color',
      'site_name',
      'surface_color',
      'tagline',
    ]);
    // Asset paths are instance-local and must never leave the instance.
    expect('logo_path' in (document['site_settings'] as object)).toBe(false);
    expect('favicon_path' in (document['site_settings'] as object)).toBe(false);
    expect('background_image_path' in (document['site_settings'] as object)).toBe(false);
    expect(JSON.stringify(document)).not.toContain('brand-assets');
  });

  it('exports only the portable fields of the settings row', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as { site_settings: Record<string, unknown> };

    expect(document.site_settings['site_name']).toBe('Seed Site');
    expect(document.site_settings['primary_color']).toBe('#336699');
    expect(document.site_settings['page_background_color']).toBe('#123456');
    expect(document.site_settings['surface_color']).toBe('#ABCDEF');
    expect(document.site_settings['default_theme']).toBe('light');
    expect(document.site_settings['tagline']).toBe('Seeded');
    expect(document.site_settings['footer_text']).toBe('Footer');
    expect(document.site_settings['access_mode']).toBe('public');
  });

  it('exports public categories and links with relationship source ids', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as {
      public_categories: { source_id: number; name: string }[];
      public_links: { category_source_id: number; title: string }[];
    };

    expect(document.public_categories).toHaveLength(1);
    expect(document.public_links).toHaveLength(1);
    expect(document.public_links[0]!.category_source_id).toBe(document.public_categories[0]!.source_id);
  });

  it('never includes credentials or user records', async () => {
    const { adminCookie } = await seed();

    const text = await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).text();

    expect(text).not.toContain('password');
    expect(text).not.toContain('session');
    expect(text).not.toContain('admin@example.com');
  });
});

describe('personal export document', () => {
  it('produces a versioned, typed document scoped to the caller', async () => {
    const { userCookie } = await seed();

    const document = (await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json()) as Record<string, unknown>;

    expect(document['schema_version']).toBe(1);
    expect(document['type']).toBe('personal');
    expect(document['personal_categories']).toBeInstanceOf(Array);

    const category = (document['personal_categories'] as Record<string, unknown>[])[0]!;
    expect(Object.keys(category).sort()).toEqual(['is_default', 'name', 'sort_order', 'source_id']);

    const link = (document['personal_links'] as Record<string, unknown>[])[0]!;
    // `normalized_url` is server-derived state and is not part of the contract.
    expect(Object.keys(link).sort()).toEqual([
      'category_source_id',
      'icon_url',
      'sort_order',
      'source_id',
      'title',
      'url',
    ]);
  });

  it('never exports an owner identifier', async () => {
    const { userCookie } = await seed();

    const text = await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).text();

    expect(text).not.toContain('user_id');
    expect(text).not.toContain('userId');
  });

  it('does not leak another user\u2019s navigation', async () => {
    const { adminCookie, userCookie, userId } = await seed();

    // Give the admin their own personal navigation.
    const adminId = (
      temp.handle.sqlite.prepare('select id from user where username = ?').get('adminuser') as {
        id: string;
      }
    ).id;
    const adminCategory = temp.handle.db
      .insert(personalCategories)
      .values({ userId: adminId, name: 'Admin Only', sortOrder: 0, isDefault: true })
      .returning()
      .get();
    temp.handle.db
      .insert(personalLinks)
      .values({
        userId: adminId,
        categoryId: adminCategory.id,
        title: 'Admin Secret',
        url: 'https://admin-secret.example.com/',
        normalizedUrl: 'https://admin-secret.example.com/',
        sortOrder: 0,
      })
      .run();

    const asUser = await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).text();
    expect(asUser).not.toContain('Admin Secret');
    expect(asUser).not.toContain('Admin Only');

    // An admin exporting "personal" data still receives only their own.
    const asAdmin = await (
      await send('GET', '/api/personal/data-export', { cookie: adminCookie })
    ).text();
    expect(asAdmin).not.toContain('Personal Link');
    expect(asAdmin).not.toContain('Personal Tools');

    // Sanity: both users really do own rows.
    const owners = temp.handle.db.select().from(personalCategories).all();
    expect(owners.map((row) => row.userId).sort()).toContain(userId);
    expect(owners).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

describe('site import preview', () => {
  it('reports counts and writes nothing', async () => {
    const { adminCookie } = await seed();

    const document = await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json();

    const before = {
      categories: temp.handle.db.select().from(publicCategories).all().length,
      links: temp.handle.db.select().from(publicLinks).all().length,
      settings: JSON.stringify(temp.handle.db.select().from(siteSettings).all()),
    };

    const response = await send('POST', '/api/admin/data-import/site/preview', {
      cookie: adminCookie,
      body: { document },
    });

    expect(response.status).toBe(200);

    const preview = (await response.json()) as Record<string, unknown>;
    expect(preview['scope']).toBe('site');
    expect(preview['incomingCategories']).toBe(1);
    expect(preview['incomingLinks']).toBe(1);
    expect(preview['currentCategories']).toBe(1);
    expect(preview['currentLinks']).toBe(1);
    expect(preview['assetsPreserved']).toBe(true);

    const after = {
      categories: temp.handle.db.select().from(publicCategories).all().length,
      links: temp.handle.db.select().from(publicLinks).all().length,
      settings: JSON.stringify(temp.handle.db.select().from(siteSettings).all()),
    };

    expect(after).toEqual(before);
  });

  it('counts incoming data that differs from the current state', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    (document['public_categories'] as unknown[]).push({
      source_id: 500,
      name: 'Second',
      icon: null,
      sort_order: 1,
      is_visible: true,
    });

    const response = await send('POST', '/api/admin/data-import/site/preview', {
      cookie: adminCookie,
      body: { document },
    });

    const preview = (await response.json()) as Record<string, unknown>;
    expect(preview['incomingCategories']).toBe(2);
    expect(preview['currentCategories']).toBe(1);
  });
});

describe('personal import preview', () => {
  it('reports counts and writes nothing', async () => {
    const { userCookie, userId } = await seed();

    const document = await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json();

    const before = JSON.stringify(
      temp.handle.db.select().from(personalCategories).all().filter((row) => row.userId === userId),
    );

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(200);

    const preview = (await response.json()) as Record<string, unknown>;
    expect(preview['scope']).toBe('personal');
    expect(preview['incomingCategories']).toBe(1);
    expect(preview['currentCategories']).toBe(1);

    const after = JSON.stringify(
      temp.handle.db.select().from(personalCategories).all().filter((row) => row.userId === userId),
    );
    expect(after).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

describe('site import validation', () => {
  async function siteDocument(adminCookie: string): Promise<Record<string, unknown>> {
    return (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
  }

  it('rejects an unsupported schema version', async () => {
    const { adminCookie } = await seed();
    const document = await siteDocument(adminCookie);
    document['schema_version'] = 2;

    const response = await send('POST', '/api/admin/data-import/site/preview', {
      cookie: adminCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('schema_version');
  });

  it('rejects a document of the wrong type', async () => {
    const { adminCookie, userCookie } = await seed();
    const personal = await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json();

    const response = await send('POST', '/api/admin/data-import/site/preview', {
      cookie: adminCookie,
      body: { document: personal },
    });

    expect(response.status).toBe(400);
  });

  it('rejects a non-object document', async () => {
    const { adminCookie } = await seed();

    for (const document of [null, 'text', 42, []]) {
      const response = await send('POST', '/api/admin/data-import/site/preview', {
        cookie: adminCookie,
        body: { document },
      });

      expect(response.status).toBe(400);
    }
  });

  it('rejects a link referencing a missing category', async () => {
    const { adminCookie } = await seed();
    const document = await siteDocument(adminCookie);
    (document['public_links'] as Record<string, unknown>[])[0]!['category_source_id'] = 99999;

    const response = await send('POST', '/api/admin/data-import/site/preview', {
      cookie: adminCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('category_source_id');
  });

  it('rejects duplicate source ids', async () => {
    const { adminCookie } = await seed();
    const document = await siteDocument(adminCookie);
    const categories = document['public_categories'] as Record<string, unknown>[];
    categories.push({ ...categories[0]! });

    const response = await send('POST', '/api/admin/data-import/site/preview', {
      cookie: adminCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('duplicate source_id');
  });

  it('rejects forbidden URL schemes', async () => {
    const { adminCookie } = await seed();

    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com/',
    ]) {
      const document = await siteDocument(adminCookie);
      (document['public_links'] as Record<string, unknown>[])[0]!['url'] = url;

      const response = await send('POST', '/api/admin/data-import/site/preview', {
        cookie: adminCookie,
        body: { document },
      });

      expect(response.status, `expected rejection for ${url}`).toBe(400);
    }
  });

  it('rejects an invalid primary color', async () => {
    const { adminCookie } = await seed();

    for (const color of ['red', '#12345', '#GGGGGG', 'rgb(0,0,0)', '#1234567']) {
      const document = await siteDocument(adminCookie);
      (document['site_settings'] as Record<string, unknown>)['primary_color'] = color;

      const response = await send('POST', '/api/admin/data-import/site/preview', {
        cookie: adminCookie,
        body: { document },
      });

      expect(response.status, `expected rejection for ${color}`).toBe(400);
    }
  });

  it('rejects an invalid theme or access mode', async () => {
    const { adminCookie } = await seed();

    const badTheme = await siteDocument(adminCookie);
    (badTheme['site_settings'] as Record<string, unknown>)['default_theme'] = 'neon';
    expect(
      (
        await send('POST', '/api/admin/data-import/site/preview', {
          cookie: adminCookie,
          body: { document: badTheme },
        })
      ).status,
    ).toBe(400);

    const badAccess = await siteDocument(adminCookie);
    (badAccess['site_settings'] as Record<string, unknown>)['access_mode'] = 'everyone';
    expect(
      (
        await send('POST', '/api/admin/data-import/site/preview', {
          cookie: adminCookie,
          body: { document: badAccess },
        })
      ).status,
    ).toBe(400);
  });

  it('rejects an empty or over-long site name', async () => {
    const { adminCookie } = await seed();

    for (const name of ['', '   ', 'x'.repeat(101)]) {
      const document = await siteDocument(adminCookie);
      (document['site_settings'] as Record<string, unknown>)['site_name'] = name;

      const response = await send('POST', '/api/admin/data-import/site/preview', {
        cookie: adminCookie,
        body: { document },
      });

      expect(response.status).toBe(400);
    }
  });

  it('rejects a non-array category or link collection', async () => {
    const { adminCookie } = await seed();

    for (const field of ['public_categories', 'public_links']) {
      const document = await siteDocument(adminCookie);
      document[field] = { not: 'an array' };

      const response = await send('POST', '/api/admin/data-import/site/preview', {
        cookie: adminCookie,
        body: { document },
      });

      expect(response.status).toBe(400);
    }
  });
});

describe('personal import validation', () => {
  async function personalDocument(userCookie: string): Promise<Record<string, unknown>> {
    return (await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json()) as Record<string, unknown>;
  }

  it.each(['', ' \t\n ', 123, null])('rejects an invalid personal link title (%j) without writes', async (title) => {
    const { userCookie } = await seed();
    const document = await personalDocument(userCookie);
    (document['personal_links'] as Record<string, unknown>[])[0]!['title'] = title;
    const snapshot = () => ({
      categories: temp.handle.db.select().from(personalCategories).all(),
      links: temp.handle.db.select().from(personalLinks).all(),
    });
    const before = snapshot();

    for (const action of ['preview', 'apply']) {
      const response = await send('POST', `/api/personal/data-import/${action}`, {
        cookie: userCookie,
        body: { confirm: true, document },
      });
      expect(response.status).toBe(400);
      expect(snapshot()).toEqual(before);
    }
  });

  it('rejects a document with no categories', async () => {
    const { userCookie } = await seed();
    const document = await personalDocument(userCookie);
    document['personal_categories'] = [];
    document['personal_links'] = [];

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
  });

  it('rejects a document with no default category', async () => {
    const { userCookie } = await seed();
    const document = await personalDocument(userCookie);
    (document['personal_categories'] as Record<string, unknown>[])[0]!['is_default'] = false;

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
  });

  it('rejects a document with more than one default category', async () => {
    const { userCookie } = await seed();
    const document = await personalDocument(userCookie);
    (document['personal_categories'] as Record<string, unknown>[]).push({
      source_id: 900,
      name: 'Another',
      sort_order: 1,
      is_default: true,
    });

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('default');
  });

  it('rejects duplicate URLs within the same category', async () => {
    const { userCookie } = await seed();
    const document = await personalDocument(userCookie);
    const link = (document['personal_links'] as Record<string, unknown>[])[0]!;
    (document['personal_links'] as Record<string, unknown>[]).push({
      ...link,
      source_id: 901,
      url: 'https://personal.example.com',
    });

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
  });

  it('allows the same URL in two different categories', async () => {
    const { userCookie } = await seed();
    const document = await personalDocument(userCookie);
    const link = (document['personal_links'] as Record<string, unknown>[])[0]!;
    (document['personal_categories'] as Record<string, unknown>[]).push({
      source_id: 902,
      name: 'Second',
      sort_order: 1,
      is_default: false,
    });
    (document['personal_links'] as Record<string, unknown>[]).push({
      ...link,
      source_id: 903,
      category_source_id: 902,
    });

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(200);
  });

  it('rejects a forbidden URL scheme', async () => {
    const { userCookie } = await seed();
    const document = await personalDocument(userCookie);
    (document['personal_links'] as Record<string, unknown>[])[0]!['url'] = 'javascript:alert(1)';

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
  });

  it('rejects a document of the wrong type', async () => {
    const { userCookie, adminCookie } = await seed();
    const site = await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json();

    const response = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie,
      body: { document: site },
    });

    expect(response.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Apply confirmation                                                          */
/* -------------------------------------------------------------------------- */

describe('import apply confirmation', () => {
  it('refuses to apply without an explicit confirm flag', async () => {
    const { adminCookie } = await seed();
    const document = await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json();

    const omitted = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { document },
    });
    expect(omitted.status).toBe(400);

    const falsy = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: false, document },
    });
    expect(falsy.status).toBe(400);

    // Truthy-but-not-true must not be accepted either.
    const stringy = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: 'true', document },
    });
    expect(stringy.status).toBe(400);
  });

  it('refuses to apply personal data without an explicit confirm flag', async () => {
    const { userCookie } = await seed();
    const document = await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json();

    const response = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { document },
    });

    expect(response.status).toBe(400);
  });

  it('still rejects an invalid document when confirm is true', async () => {
    const { adminCookie } = await seed();
    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    document['schema_version'] = 42;

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });

    expect(response.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Apply replacement semantics                                                 */
/* -------------------------------------------------------------------------- */

describe('site import apply', () => {
  it('replaces public navigation and portable settings', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;

    // Build a genuinely different replacement document.
    document['site_settings'] = {
      site_name: 'Replaced Site',
      tagline: null,
      primary_color: '#ABCDEF',
      page_background_color: ' #123abc ',
      surface_color: '#aabbcc',
      default_theme: 'dark',
      footer_text: null,
      access_mode: 'login_required',
    };
    document['public_categories'] = [
      { source_id: 77, name: 'Replaced Category', icon: 'star', sort_order: 0, is_visible: false },
    ];
    document['public_links'] = [
      {
        source_id: 88,
        category_source_id: 77,
        title: 'Replaced Link',
        url: 'https://replaced.example.com/',
        description: 'desc',
        icon_url: null,
        sort_order: 0,
        is_visible: false,
      },
    ];

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      scope: 'site',
      incomingCategories: 1,
      incomingLinks: 1,
    });

    const settings = temp.handle.db.select().from(siteSettings).all()[0]!;
    expect(settings.siteName).toBe('Replaced Site');
    expect(settings.primaryColor).toBe('#ABCDEF');
    expect(settings.pageBackgroundColor).toBe('#123ABC');
    expect(settings.surfaceColor).toBe('#AABBCC');
    expect(settings.defaultTheme).toBe('dark');
    expect(settings.accessMode).toBe('login_required');
    expect(settings.tagline).toBeNull();

    const categories = temp.handle.db.select().from(publicCategories).all();
    expect(categories).toHaveLength(1);
    expect(categories[0]!.name).toBe('Replaced Category');
    expect(categories[0]!.isVisible).toBe(false);

    const links = temp.handle.db.select().from(publicLinks).all();
    expect(links).toHaveLength(1);
    expect(links[0]!.title).toBe('Replaced Link');
    expect(links[0]!.isVisible).toBe(false);
    // The new link belongs to the newly created category, not the old id.
    expect(links[0]!.categoryId).toBe(categories[0]!.id);
  });

  it('imports an old v1 document with null color defaults and preserves all three branding assets', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    document['site_settings'] = {
      site_name: 'Assets Kept',
      tagline: null,
      primary_color: null,
      default_theme: 'light',
      footer_text: null,
      access_mode: 'public',
    };

    const beforePreview = temp.handle.db.select().from(siteSettings).all();
    const preview = await send('POST', '/api/admin/data-import/site/preview', { cookie: adminCookie, body: { document } });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ assetsPreserved: true });
    expect(temp.handle.db.select().from(siteSettings).all()).toEqual(beforePreview);

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    const settings = temp.handle.db.select().from(siteSettings).all()[0]!;
    expect(settings.logoPath).toBe('/api/public/brand-assets/logo.png');
    expect(settings.faviconPath).toBe('/api/public/brand-assets/favicon.ico');
    expect(settings.siteName).toBe('Assets Kept');
    expect(settings.pageBackgroundColor).toBeNull();
    expect(settings.surfaceColor).toBeNull();
    expect(settings.backgroundImagePath).toBe('/api/public/brand-assets/background.webp');
  });

  it('ignores injected logo, favicon and background asset paths in the document', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as { site_settings: Record<string, unknown> };
    document.site_settings['logo_path'] = '/etc/passwd';
    document.site_settings['favicon_path'] = 'https://evil.example.com/x.png';
    document.site_settings['background_image_path'] = '/etc/passwd';

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    const settings = temp.handle.db.select().from(siteSettings).all()[0]!;
    expect(settings.logoPath).toBe('/api/public/brand-assets/logo.png');
    expect(settings.faviconPath).toBe('/api/public/brand-assets/favicon.ico');
    expect(settings.backgroundImagePath).toBe('/api/public/brand-assets/background.webp');
  });

  it('rejects unsafe new colors in both preview and apply without writing any data', async () => {
    const { adminCookie } = await seed();
    const document = (await (await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })).json()) as {
      site_settings: Record<string, unknown>;
    };
    const snapshot = () => JSON.stringify({
      settings: temp.handle.db.select().from(siteSettings).all(),
      categories: temp.handle.db.select().from(publicCategories).all(),
      links: temp.handle.db.select().from(publicLinks).all(),
      personalCategories: temp.handle.db.select().from(personalCategories).all(),
      personalLinks: temp.handle.db.select().from(personalLinks).all(),
    });
    const before = snapshot();
    for (const field of ['page_background_color', 'surface_color']) {
      const original = document.site_settings[field];
      for (const color of ['#abc', '#12345678', 'red', 'rgb(1,2,3)', 'hsl(0,0%,0%)', 'var(--x)',
        'url(https://evil.example/x)', '#123456!important', '#123456; color:red', 123, {}, []]) {
        document.site_settings[field] = color;
        for (const action of ['preview', 'apply']) {
          const response = await send('POST', `/api/admin/data-import/site/${action}`, {
            cookie: adminCookie, body: { confirm: true, document },
          });
          expect(response.status, `${action} ${field}: ${JSON.stringify(color)}`).toBe(400);
          expect(snapshot()).toBe(before);
        }
      }
      document.site_settings[field] = original;
    }
  });

  it('imports blank and null new colors as null while preserving instance assets', async () => {
    const { adminCookie } = await seed();
    const document = (await (await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })).json()) as {
      site_settings: Record<string, unknown>;
    };
    document.site_settings['page_background_color'] = '  ';
    document.site_settings['surface_color'] = null;
    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie, body: { confirm: true, document },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ assetsPreserved: true });
    expect(temp.handle.db.select().from(siteSettings).all()[0]).toMatchObject({
      pageBackgroundColor: null, surfaceColor: null,
      logoPath: '/api/public/brand-assets/logo.png', faviconPath: '/api/public/brand-assets/favicon.ico',
      backgroundImagePath: '/api/public/brand-assets/background.webp',
    });
  });

  it('clears public navigation when the document is empty', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    document['public_categories'] = [];
    document['public_links'] = [];

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });

    expect(response.status).toBe(200);
    expect(temp.handle.db.select().from(publicCategories).all()).toHaveLength(0);
    expect(temp.handle.db.select().from(publicLinks).all()).toHaveLength(0);
  });

  it('does not touch personal data or user accounts', async () => {
    const { adminCookie, userId } = await seed();

    const personalBefore = JSON.stringify(
      temp.handle.db.select().from(personalCategories).all().filter((row) => row.userId === userId),
    );

    const document = await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json();

    await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });

    const personalAfter = JSON.stringify(
      temp.handle.db.select().from(personalCategories).all().filter((row) => row.userId === userId),
    );
    expect(personalAfter).toBe(personalBefore);

    const userCount = (
      temp.handle.sqlite.prepare('select count(*) as count from user').get() as { count: number }
    ).count;
    expect(userCount).toBe(2);
  });

  /**
   * Read the URL that the existing Public Link CRUD path stores for `input`.
   *
   * Used as the authority for the site-import parity assertions, so this test file
   * never restates the URL-normalization rules itself: it asks the product what
   * the correct stored value is.
   */
  async function storedUrlFromPublicLinkCrud(adminCookie: string, input: string): Promise<string> {
    const navigation = (await (
      await send('GET', '/api/admin/public-navigation', { cookie: adminCookie })
    ).json()) as { categories: { id: number }[] };

    const response = await send('POST', '/api/admin/public/links', {
      cookie: adminCookie,
      body: { categoryId: navigation.categories[0]!.id, title: 'Parity Probe', url: input },
    });
    expect(response.status).toBe(201);

    const created = (await response.json()) as { id: number; url: string };

    return created.url;
  }

  it('stores the canonical absolute URL for a scheme-less imported link', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    document['public_links'] = [
      {
        source_id: 1,
        category_source_id: (document['public_categories'] as Record<string, unknown>[])[0]![
          'source_id'
        ],
        title: 'Scheme-less',
        url: 'scheme-less.example.com/path',
        description: null,
        icon_url: null,
        sort_order: 0,
        is_visible: true,
      },
    ];

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    // `public_links.url` is rendered directly as `<a href>`, so a scheme-less
    // value would navigate relative to the application's own origin.
    const link = temp.handle.db.select().from(publicLinks).all()[0]!;
    expect(link.url).toBe('https://scheme-less.example.com/path');
    expect(link.url.startsWith('https://')).toBe(true);

    // And the stored value is exactly what ordinary Public Link CRUD produces.
    expect(link.url).toBe(await storedUrlFromPublicLinkCrud(adminCookie, 'scheme-less.example.com/path'));
  });

  it('normalizes an imported URL fragment by the shared rules', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    document['public_links'] = [
      {
        source_id: 1,
        category_source_id: (document['public_categories'] as Record<string, unknown>[])[0]![
          'source_id'
        ],
        title: 'With Fragment',
        url: 'https://fragment.example.com/page#section',
        description: null,
        icon_url: null,
        sort_order: 0,
        is_visible: true,
      },
    ];

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    const expected = await storedUrlFromPublicLinkCrud(
      adminCookie,
      'https://fragment.example.com/page#section',
    );

    const link = temp.handle.db.select().from(publicLinks).all()[0]!;
    // The exact serialization is whatever the shared validator produces; the
    // contract asserted here is parity with the normal mutation path.
    expect(link.url).toBe(expected);
    expect(link.url).not.toContain('#');
  });

  it('stores the same canonical URL for several inputs as Public Link CRUD', async () => {
    const { adminCookie } = await seed();

    // A spread of inputs that all exercise the shared normalization authority:
    // scheme-less, already-absolute, uppercase host, default port, and a
    // scheme-less value carrying a valid port.
    const inputs = [
      'parity-one.example.com',
      'https://parity-two.example.com/a/b',
      'HTTPS://Parity-Three.Example.COM/',
      'https://parity-four.example.com:443/',
      'parity-five.example.com:8080/x',
    ];

    for (const input of inputs) {
      const expected = await storedUrlFromPublicLinkCrud(adminCookie, input);

      const document = (await (
        await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
      ).json()) as Record<string, unknown>;
      document['public_links'] = [
        {
          source_id: 1,
          category_source_id: (document['public_categories'] as Record<string, unknown>[])[0]![
            'source_id'
          ],
          title: 'Parity',
          url: input,
          description: null,
          icon_url: null,
          sort_order: 0,
          is_visible: true,
        },
      ];

      const response = await send('POST', '/api/admin/data-import/site/apply', {
        cookie: adminCookie,
        body: { confirm: true, document },
      });
      expect(response.status, `import rejected ${input}`).toBe(200);

      const links = temp.handle.db.select().from(publicLinks).all();
      expect(links, `expected exactly one link after importing ${input}`).toHaveLength(1);
      expect(links[0]!.url, `import/CRUD mismatch for ${input}`).toBe(expected);
    }
  });

  it('keeps the personal scope storing the caller-visible URL text', async () => {
    const { userCookie, userId } = await seed();

    // The product deliberately differs by scope: personal navigation renders
    // through `normalized_url`, so `personal_links.url` may retain the original
    // text. This asserts the remediation did not change that.
    const document = (await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json()) as Record<string, unknown>;
    const categoryId = (document['personal_categories'] as Record<string, unknown>[])[0]![
      'source_id'
    ];
    document['personal_links'] = [
      {
        source_id: 1,
        category_source_id: categoryId,
        title: 'Personal Original',
        url: 'personal-raw.example.com/path',
        icon_url: null,
        sort_order: 0,
      },
    ];

    const response = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    const link = temp.handle.db
      .select()
      .from(personalLinks)
      .all()
      .filter((row) => row.userId === userId)[0]!;

    // Original text retained, canonical form derived separately.
    expect(link.url).toBe('personal-raw.example.com/path');
    expect(link.normalizedUrl).toBe('https://personal-raw.example.com/path');
  });

  it('is atomic: a mid-import failure leaves previous data intact', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    document['site_settings'] = {
      site_name: 'Should Not Persist',
      tagline: null,
      primary_color: null,
      page_background_color: '#EEEEEE',
      surface_color: null,
      default_theme: 'light',
      footer_text: null,
      access_mode: 'public',
    };

    const snapshot = () =>
      JSON.stringify({
        settings: temp.handle.db.select().from(siteSettings).all(),
        categories: temp.handle.db.select().from(publicCategories).all(),
        links: temp.handle.db.select().from(publicLinks).all(),
      });

    const before = snapshot();

    // Force a failure after the settings UPDATE and the DELETEs have run.
    temp.handle.sqlite
      .prepare("create trigger tmp_import_fail before insert on public_links begin select raise(abort, 'forced'); end")
      .run();

    try {
      const response = await send('POST', '/api/admin/data-import/site/apply', {
        cookie: adminCookie,
        body: { confirm: true, document },
      });

      expect(response.status).toBe(500);
    } finally {
      temp.handle.sqlite.prepare('drop trigger tmp_import_fail').run();
    }

    // Every pre-existing row — including the replaced settings — is unchanged.
    expect(snapshot()).toBe(before);
    expect(temp.handle.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(temp.handle.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});

describe('personal import apply', () => {
  it('replaces the caller\u2019s navigation and preserves ordering', async () => {
    const { userCookie, userId } = await seed();

    const document = (await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json()) as Record<string, unknown>;
    document['personal_categories'] = [
      { source_id: 5, name: 'Beta', sort_order: 1, is_default: false },
      { source_id: 6, name: 'Alpha', sort_order: 0, is_default: true },
    ];
    document['personal_links'] = [
      { source_id: 20, category_source_id: 6, title: 'A2', url: 'https://a2.example.com/', icon_url: null, sort_order: 1 },
      { source_id: 21, category_source_id: 6, title: 'A1', url: 'https://a1.example.com/', icon_url: null, sort_order: 0 },
      { source_id: 22, category_source_id: 5, title: 'B1', url: 'https://b1.example.com/', icon_url: null, sort_order: 0 },
    ];

    const response = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { confirm: true, document },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      scope: 'personal',
      incomingCategories: 2,
      incomingLinks: 3,
    });

    const categories = temp.handle.db
      .select()
      .from(personalCategories)
      .all()
      .filter((row) => row.userId === userId)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    expect(categories.map((row) => row.name)).toEqual(['Alpha', 'Beta']);
    expect(categories.filter((row) => row.isDefault)).toHaveLength(1);
    expect(categories[0]!.isDefault).toBe(true);

    const links = temp.handle.db
      .select()
      .from(personalLinks)
      .all()
      .filter((row) => row.userId === userId);

    const alphaId = categories[0]!.id;
    const alphaLinks = links
      .filter((row) => row.categoryId === alphaId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(alphaLinks.map((row) => row.title)).toEqual(['A1', 'A2']);
    // Ordering is renumbered contiguously rather than trusting document numbers.
    expect(alphaLinks.map((row) => row.sortOrder)).toEqual([0, 1]);
  });

  it('preserves the original URL and derives normalized_url server-side', async () => {
    const { userCookie, userId } = await seed();

    const document = (await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json()) as Record<string, unknown>;
    const categoryId = (document['personal_categories'] as Record<string, unknown>[])[0]![
      'source_id'
    ];
    document['personal_links'] = [
      {
        source_id: 1,
        category_source_id: categoryId,
        title: 'Bare',
        url: 'bare-host.example.com',
        icon_url: null,
        sort_order: 0,
        // A forged canonical value must be ignored entirely.
        normalized_url: 'https://evil.example.com/',
      },
    ];

    const response = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    const link = temp.handle.db
      .select()
      .from(personalLinks)
      .all()
      .filter((row) => row.userId === userId)[0]!;
    // `url` keeps the caller's text; `normalizedUrl` is recomputed by the server.
    expect(link.url).toBe('bare-host.example.com');
    expect(link.normalizedUrl).toBe('https://bare-host.example.com/');
  });

  it('never writes to another user\u2019s rows', async () => {
    const { userCookie, userId } = await seed();

    const adminId = (
      temp.handle.sqlite.prepare('select id from user where username = ?').get('adminuser') as {
        id: string;
      }
    ).id;
    const adminCategory = temp.handle.db
      .insert(personalCategories)
      .values({ userId: adminId, name: 'Admin Category', sortOrder: 0, isDefault: true })
      .returning()
      .get();
    temp.handle.db
      .insert(personalLinks)
      .values({
        userId: adminId,
        categoryId: adminCategory.id,
        title: 'Admin Link',
        url: 'https://admin.example.com/',
        normalizedUrl: 'https://admin.example.com/',
        sortOrder: 0,
      })
      .run();

    const adminBefore = JSON.stringify(
      temp.handle.db.select().from(personalCategories).all().filter((row) => row.userId === adminId),
    );

    const document = await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json();

    const response = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    // The other user's rows survive untouched.
    expect(
      JSON.stringify(
        temp.handle.db.select().from(personalCategories).all().filter((row) => row.userId === adminId),
      ),
    ).toBe(adminBefore);

    // And the caller owns exactly the imported data.
    expect(
      temp.handle.db
        .select()
        .from(personalCategories)
        .all()
        .filter((row) => row.userId === userId),
    ).toHaveLength(1);
  });

  it('cannot be used to inject rows into another account via a forged owner field', async () => {
    const { userCookie, userId } = await seed();

    const adminId = (
      temp.handle.sqlite.prepare('select id from user where username = ?').get('adminuser') as {
        id: string;
      }
    ).id;

    const document = {
      schema_version: 1,
      type: 'personal',
      user_id: adminId,
      personal_categories: [
        { source_id: 1, name: 'Injected', sort_order: 0, is_default: true, user_id: adminId },
      ],
      personal_links: [],
    };

    const response = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    // The forged owner field is simply ignored.
    const injected = temp.handle.db
      .select()
      .from(personalCategories)
      .all()
      .filter((row) => row.name === 'Injected');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.userId).toBe(userId);
    expect(injected[0]!.userId).not.toBe(adminId);
  });

  it('is atomic: a mid-import failure preserves the previous navigation', async () => {
    const { userCookie, userId } = await seed();

    const document = (await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json()) as Record<string, unknown>;

    const snapshot = () =>
      JSON.stringify({
        categories: temp.handle.db
          .select()
          .from(personalCategories)
          .all()
          .filter((row) => row.userId === userId)
          .map((row) => row.name),
        links: temp.handle.db
          .select()
          .from(personalLinks)
          .all()
          .filter((row) => row.userId === userId)
          .map((row) => row.title),
      });

    const before = snapshot();

    temp.handle.sqlite
      .prepare("create trigger tmp_personal_fail before insert on personal_links begin select raise(abort, 'forced'); end")
      .run();

    try {
      const response = await send('POST', '/api/personal/data-import/apply', {
        cookie: userCookie,
        body: { confirm: true, document },
      });

      expect(response.status).toBe(500);
    } finally {
      temp.handle.sqlite.prepare('drop trigger tmp_personal_fail').run();
    }

    expect(snapshot()).toBe(before);
    expect(temp.handle.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                  */
/* -------------------------------------------------------------------------- */

describe('round trip', () => {
  it.each([
    [101, 'create'],
    [8192, 'create'],
    [8192, 'edit'],
  ] as const)('preserves a %i-character personal title through %s, export and import', async (length, operation) => {
    const { userCookie, userId } = await seed();
    const navigationResponse = await send('GET', '/api/personal/navigation', { cookie: userCookie });
    expect(navigationResponse.status).toBe(200);
    const navigation = (await navigationResponse.json()) as { categories: Array<{ id: number }> };
    const title = '长'.repeat(length);
    const url = 'https://long-title.example.com/';
    const created = await send('POST', '/api/personal/links', {
      cookie: userCookie,
      body: { categoryId: navigation.categories[0]!.id, title: operation === 'edit' ? 'Short title' : title, url },
    });
    expect(created.status).toBe(201);

    if (operation === 'edit') {
      const link = (await created.json()) as { id: number };
      const edited = await send('PATCH', `/api/personal/links/${String(link.id)}`, {
        cookie: userCookie,
        body: { title },
      });
      expect(edited.status).toBe(200);
    }

    const exported = await send('GET', '/api/personal/data-export', { cookie: userCookie });
    expect(exported.status).toBe(200);
    const document = (await exported.json()) as { personal_links: Array<{ title: string; url: string }> };
    expect(document.personal_links.find((link) => link.url === url)?.title).toBe(title);
    const preview = await send('POST', '/api/personal/data-import/preview', {
      cookie: userCookie, body: { document },
    });
    expect(preview.status).toBe(200);
    const applied = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie, body: { confirm: true, document },
    });
    expect(applied.status).toBe(200);

    const readback = await send('GET', '/api/personal/navigation', { cookie: userCookie });
    expect(readback.status).toBe(200);
    const restored = (await readback.json()) as {
      categories: Array<{ links: Array<{ title: string; url: string }> }>;
    };
    expect(restored.categories.flatMap((category) => category.links).find((link) => link.url === url)?.title).toBe(title);
    const stored = temp.handle.db.select().from(personalLinks).all().find((link) => link.url === url);
    expect(stored?.title).toBe(title);
    expect(stored?.userId).toBe(userId);
  });

  it('re-importing an exported personal document is stable', async () => {
    const { userCookie, userId } = await seed();

    const exported = await (await send('GET', '/api/personal/data-export', { cookie: userCookie })).json();

    const applied = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { confirm: true, document: exported },
    });
    expect(applied.status).toBe(200);

    const reexported = await (
      await send('GET', '/api/personal/data-export', { cookie: userCookie })
    ).json();
    const again = await send('POST', '/api/personal/data-import/apply', {
      cookie: userCookie,
      body: { confirm: true, document: reexported },
    });
    expect(again.status).toBe(200);

    // Logical content is stable across repeat round trips.
    const strip = (document: unknown) =>
      JSON.stringify({
        categories: (document as { personal_categories: { name: string; is_default: boolean; sort_order: number }[] })
          .personal_categories.map((category) => ({
            name: category.name,
            is_default: category.is_default,
            sort_order: category.sort_order,
          })),
        links: (document as { personal_links: { title: string; url: string; sort_order: number }[] })
          .personal_links.map((link) => ({ title: link.title, url: link.url, sort_order: link.sort_order })),
      });

    expect(strip(reexported)).toBe(strip(exported));
    expect(strip(await (await send('GET', '/api/personal/data-export', { cookie: userCookie })).json())).toBe(
      strip(exported),
    );

    expect(
      temp.handle.db
        .select()
        .from(personalCategories)
        .all()
        .filter((row) => row.userId === userId)
        .filter((row) => row.isDefault),
    ).toHaveLength(1);
  });

  it('re-importing an exported site document is stable', async () => {
    const { adminCookie } = await seed();

    const exported = await (await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })).json();

    const applied = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document: exported },
    });
    expect(applied.status).toBe(200);

    const reexported = await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json();

    const strip = (document: unknown) =>
      JSON.stringify({
        settings: (document as { site_settings: unknown }).site_settings,
        categories: (document as { public_categories: { name: string; sort_order: number }[] }).public_categories.map(
          (category) => ({ name: category.name, sort_order: category.sort_order }),
        ),
        links: (document as { public_links: { title: string; sort_order: number }[] }).public_links.map((link) => ({
          title: link.title,
          sort_order: link.sort_order,
        })),
      });

    expect(strip(reexported)).toBe(strip(exported));
    // Ids are re-created, so source ids are not required to be stable.
    expect((reexported as { public_categories: unknown[] }).public_categories).toHaveLength(1);
  });
});

describe('home theme config portability (UI-REDESIGN-v3.2 / T1)', () => {
  const CONFIG_JSON = JSON.stringify({
    version: 1,
    presetId: 'deep-sea',
    overrides: { accentBg: '#0A1929', accentInk: null, linkTitle: '#334455' },
  });

  it('round-trips an explicit configuration byte-identically', async () => {
    const { adminCookie } = await seed();

    // Seed through the settings API so the stored value is canonical.
    const current = (await (
      await send('GET', '/api/admin/branding', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;
    await send('PUT', '/api/admin/branding', {
      cookie: adminCookie,
      body: { ...(current as Record<string, unknown>), homeThemeConfig: JSON.parse(CONFIG_JSON) },
    });

    const first = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as { site_settings: Record<string, unknown> };
    expect(first.site_settings['home_theme_config']).toBe(CONFIG_JSON);

    // Import it straight back.
    await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document: first },
    });

    const second = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as { site_settings: Record<string, unknown> };
    expect(second.site_settings['home_theme_config']).toBe(CONFIG_JSON);
  });

  it('loads a document exported before the field existed', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;

    // Exactly what an older build would have written: no home_theme_config key.
    delete (document['site_settings'] as Record<string, unknown>)['home_theme_config'];
    expect('home_theme_config' in (document['site_settings'] as object)).toBe(false);

    const response = await send('POST', '/api/admin/data-import/site/apply', {
      cookie: adminCookie,
      body: { confirm: true, document },
    });
    expect(response.status).toBe(200);

    // Absent behaves exactly like an explicit null: everything automatic.
    const reexported = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as { site_settings: Record<string, unknown> };
    expect(reexported.site_settings['home_theme_config']).toBeNull();
  });

  it('rejects an imported document whose configuration violates the whitelist', async () => {
    const { adminCookie } = await seed();

    const document = (await (
      await send('GET', '/api/admin/data-export/site', { cookie: adminCookie })
    ).json()) as Record<string, unknown>;

    for (const bad of [
      JSON.stringify({ version: 1, overrides: { evil: '#FFFFFF' } }),
      JSON.stringify({ version: 1, overrides: { accentBg: 'red' } }),
      JSON.stringify({ version: 2, overrides: {} }),
      '{not json',
    ]) {
      (document['site_settings'] as Record<string, unknown>)['home_theme_config'] = bad;
      const response = await send('POST', '/api/admin/data-import/site/apply', {
        cookie: adminCookie,
        body: { confirm: true, document },
      });
      expect(response.status, bad).toBe(400);
    }
  });
});
