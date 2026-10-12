import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/index.js';
import { publicCategories, publicLinks, siteSettings } from '../../src/db/schema.js';
import { seedDemoData } from '../../src/db/seed.js';
import { createApp } from '../../src/server/app.js';
import { createTempDatabase, type TempDatabase } from '../helpers/temp-database.js';

const NAVIGATION_ROUTE = '/api/public/navigation';

let temp: TempDatabase;
let handle: DatabaseHandle;

/** Minimal shape of the navigation response used by assertions. */
interface NavigationBody {
  site: { siteName: string; defaultTheme: string; accessMode: string; id: number } | null;
  categories: Array<{
    id: number;
    name: string;
    sortOrder: number;
    links: Array<{ id: number; title: string; url: string; sortOrder: number }>;
  }>;
}

async function fetchNavigation(): Promise<{ status: number; body: NavigationBody }> {
  const app = createApp({ db: handle.db, auth: temp.auth });
  const response = await app.request(NAVIGATION_ROUTE);

  return { status: response.status, body: (await response.json()) as NavigationBody };
}

beforeEach(() => {
  temp = createTempDatabase();
  handle = temp.handle;
});

afterEach(() => {
  temp.dispose();
});

describe('GET /api/public/navigation', () => {
  it('returns a safe empty payload on a migrated but unseeded database', async () => {
    const { status, body } = await fetchNavigation();

    expect(status).toBe(200);
    expect(body.site).toBeNull();
    expect(body.categories).toEqual([]);
  });

  it('returns site settings, visible categories and visible links after seeding', async () => {
    expect(seedDemoData(handle.db)).toBe('seeded');

    const { status, body } = await fetchNavigation();

    expect(status).toBe(200);
    expect(body.site).toMatchObject({
      siteName: 'Brandable Navigation Platform',
      defaultTheme: 'light',
      accessMode: 'public',
    });

    expect(body.categories).toHaveLength(2);
    expect(body.categories[0]).toMatchObject({ name: 'Example', sortOrder: 0 });
    expect(body.categories[0]?.links).toHaveLength(2);
    expect(body.categories[0]?.links[0]).toMatchObject({
      title: 'Example Domain',
      url: 'https://example.com',
      sortOrder: 0,
    });
    expect(body.categories[1]).toMatchObject({ name: 'Reference', sortOrder: 1 });
    expect(body.categories[1]?.links).toHaveLength(1);
  });

  it('exposes a small explicit shape without timestamps or visibility flags', async () => {
    seedDemoData(handle.db);

    const app = createApp({ db: handle.db, auth: temp.auth });
    const response = await app.request(NAVIGATION_ROUTE);
    const raw = (await response.json()) as Record<string, unknown>;

    const category = (raw.categories as Array<Record<string, unknown>>)[0];
    const link = (category?.links as Array<Record<string, unknown>>)[0];

    expect(Object.keys(category ?? {}).sort()).toEqual(['icon', 'id', 'links', 'name', 'sortOrder']);
    expect(Object.keys(link ?? {}).sort()).toEqual([
      'description',
      'iconUrl',
      'id',
      'sortOrder',
      'title',
      'url',
    ]);
    expect(Object.keys(raw.site as object).sort()).toEqual([
      'accessMode',
      'defaultTheme',
      'faviconPath',
      'footerText',
      'id',
      'logoPath',
      'primaryColor',
      'siteName',
      'tagline',
    ]);

    expect(JSON.stringify(raw)).not.toContain('createdAt');
    expect(JSON.stringify(raw)).not.toContain('updatedAt');
    expect(JSON.stringify(raw)).not.toContain('isVisible');
  });

  it('preserves the generic 404 JSON response for unknown API routes', async () => {
    const app = createApp({ db: handle.db, auth: temp.auth });
    const response = await app.request('/api/does-not-exist');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not Found' });
  });
});

describe('visibility filtering', () => {
  it('excludes hidden categories and their links, and hidden links in visible categories', async () => {
    handle.db
      .insert(siteSettings)
      .values({ siteName: 'Visibility Test' })
      .run();

    handle.db
      .insert(publicCategories)
      .values([
        { id: 1, name: 'Visible Category', sortOrder: 0, isVisible: true },
        { id: 2, name: 'Hidden Category', sortOrder: 1, isVisible: false },
        { id: 3, name: 'Visible But Empty', sortOrder: 2, isVisible: true },
      ])
      .run();

    handle.db
      .insert(publicLinks)
      .values([
        { id: 1, categoryId: 1, title: 'Visible Link', url: 'https://example.com', sortOrder: 0, isVisible: true },
        { id: 2, categoryId: 1, title: 'Hidden Link', url: 'https://hidden.example.com', sortOrder: 1, isVisible: false },
        { id: 3, categoryId: 2, title: 'Link In Hidden Category', url: 'https://secret.example.com', sortOrder: 0, isVisible: true },
      ])
      .run();

    const { body } = await fetchNavigation();

    expect(body.categories.map((category) => category.name)).toEqual([
      'Visible Category',
      'Visible But Empty',
    ]);

    const allLinkTitles = body.categories.flatMap((category) =>
      category.links.map((link) => link.title),
    );
    expect(allLinkTitles).toEqual(['Visible Link']);

    // A visible category with zero visible links is still returned.
    expect(body.categories[1]?.links).toEqual([]);
  });
});

describe('ordering', () => {
  it('orders categories and links by sort_order then id', async () => {
    handle.db.insert(siteSettings).values({ siteName: 'Ordering Test' }).run();

    // Inserted out of order, with deliberate sort_order ties.
    handle.db
      .insert(publicCategories)
      .values([
        { id: 10, name: 'Third', sortOrder: 2 },
        { id: 11, name: 'First (tie, lower id)', sortOrder: 0 },
        { id: 12, name: 'Tied Second (tie, higher id)', sortOrder: 0 },
        { id: 13, name: 'Second', sortOrder: 1 },
      ])
      .run();

    handle.db
      .insert(publicLinks)
      .values([
        { id: 20, categoryId: 11, title: 'Link C', url: 'https://c.example.com', sortOrder: 2 },
        { id: 21, categoryId: 11, title: 'Link A (tie, lower id)', url: 'https://a.example.com', sortOrder: 1 },
        { id: 22, categoryId: 11, title: 'Link B (tie, higher id)', url: 'https://b.example.com', sortOrder: 1 },
      ])
      .run();

    const { body } = await fetchNavigation();

    expect(body.categories.map((category) => category.name)).toEqual([
      'First (tie, lower id)',
      'Tied Second (tie, higher id)',
      'Second',
      'Third',
    ]);

    expect(body.categories[0]?.links.map((link) => link.title)).toEqual([
      'Link A (tie, lower id)',
      'Link B (tie, higher id)',
      'Link C',
    ]);
  });
});

describe('error handling', () => {
  it('returns a generic 500 without leaking internals when the database fails', async () => {
    handle.db.insert(siteSettings).values({ siteName: 'Error Test' }).run();

    // Force a genuine failure: drop a table the query depends on.
    handle.sqlite.exec('drop table public_categories');

    const app = createApp({ db: handle.db, auth: temp.auth });
    const response = await app.request(NAVIGATION_ROUTE);

    expect(response.status).toBe(500);

    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'Internal Server Error' });
    expect(body).not.toMatch(/SQLITE|no such table|\.sqlite|at Object\./i);
  });
});
