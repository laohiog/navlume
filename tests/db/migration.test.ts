import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, resolveDatabasePath, type DatabaseHandle } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { publicCategories, publicLinks, siteSettings } from '../../src/db/schema.js';

let tempDir: string;
let handle: DatabaseHandle;

/** Read raw SQLite metadata for a table's columns. */
function tableInfo(name: string): Array<{ name: string; notnull: number; dflt_value: string | null }> {
  return handle.sqlite.pragma(`table_info(${name})`) as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

function tableNames(): string[] {
  const rows = handle.sqlite
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bnp-db-'));
  handle = createDatabase(join(tempDir, 'test.sqlite'));
  runMigrations(handle);
});

afterEach(() => {
  handle.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('database factory', () => {
  it('uses DATABASE_PATH when set and falls back to the repository default', () => {
    const previous = process.env.DATABASE_PATH;

    try {
      process.env.DATABASE_PATH = '/data/nav.sqlite';
      expect(resolveDatabasePath()).toBe('/data/nav.sqlite');

      delete process.env.DATABASE_PATH;
      expect(resolveDatabasePath()).toBe('data/nav.sqlite');
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previous;
      }
    }
  });

  it('enables SQLite foreign-key enforcement on every connection', () => {
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('initial migration', () => {
  it('creates the three P1 tables', () => {
    const names = tableNames();

    expect(names).toContain('site_settings');
    expect(names).toContain('public_categories');
    expect(names).toContain('public_links');
  });

  it('creates the Better Auth tables alongside P1 (P2.1)', () => {
    const names = tableNames();

    // Better Auth core tables are now expected.
    for (const authTable of ['user', 'session', 'account', 'verification']) {
      expect(names).toContain(authTable);
    }
  });

  it('creates the personal navigation tables (P3.1)', () => {
    const names = tableNames();

    expect(names).toContain('personal_categories');
    expect(names).toContain('personal_links');
  });

  it('does not create multi-tenant tables', () => {
    const names = tableNames();

    for (const forbidden of [
      'users',
      'sessions',
      'accounts',
      'organization',
      'organizations',
      'member',
      'invitation',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('can be applied twice without duplicate-table failure or corruption', () => {
    expect(() => runMigrations(handle)).not.toThrow();

    const names = tableNames();
    expect(names.filter((name) => name === 'public_links')).toHaveLength(1);
    expect(names.filter((name) => name === 'public_categories')).toHaveLength(1);

    // Schema still usable after the second migration run.
    expect(() =>
      handle.db
        .insert(publicCategories)
        .values({ name: 'After re-run' })
        .run(),
    ).not.toThrow();
  });

  it('declares the expected columns for each table', () => {
    expect(tableInfo('site_settings').map((column) => column.name)).toEqual([
      'id',
      'site_name',
      'tagline',
      'logo_path',
      'favicon_path',
      'primary_color',
      'default_theme',
      'footer_text',
      'access_mode',
      'created_at',
      'updated_at',
      'page_background_color',
      'surface_color',
      'background_image_path',
      // UI-REDESIGN-v3.2 / T1: versioned, whitelisted home-page theme document.
      'home_theme_config',
    ]);

    expect(tableInfo('public_categories').map((column) => column.name)).toEqual([
      'id',
      'name',
      'icon',
      'sort_order',
      'is_visible',
      'created_at',
      'updated_at',
    ]);

    expect(tableInfo('public_links').map((column) => column.name)).toEqual([
      'id',
      'category_id',
      'title',
      'url',
      'description',
      'icon_url',
      'sort_order',
      'is_visible',
      'created_at',
      'updated_at',
    ]);
  });

  it('declares the public_links -> public_categories foreign key with cascade delete', () => {
    const foreignKeys = handle.sqlite.pragma('foreign_key_list(public_links)') as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;

    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]).toMatchObject({
      table: 'public_categories',
      from: 'category_id',
      to: 'id',
      on_delete: 'CASCADE',
    });
  });
});

describe('BRP1.1 branding migration', () => {
  it('creates nullable branding columns on a fresh database', () => {
    const columns = tableInfo('site_settings');
    for (const name of ['page_background_color', 'surface_color', 'background_image_path']) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        notnull: 0, dflt_value: null,
      });
    }
  });

  it('upgrades a populated 0002 database without changing existing data and can run again', () => {
    const source = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));
    const previousFolder = join(tempDir, 'through-0002');
    mkdirSync(join(previousFolder, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 2);
    expect(journal.entries).toHaveLength(3);
    writeFileSync(join(previousFolder, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) {
      copyFileSync(join(source, `${entry.tag}.sql`), join(previousFolder, `${entry.tag}.sql`));
    }

    const upgrade = createDatabase(join(tempDir, 'upgrade.sqlite'));
    try {
      runMigrations(upgrade, previousFolder);
      expect(upgrade.sqlite.pragma('table_info(site_settings)')).toHaveLength(11);
      upgrade.sqlite.exec(`
        INSERT INTO site_settings
          (id, site_name, tagline, logo_path, favicon_path, primary_color, default_theme,
           footer_text, access_mode, created_at, updated_at)
        VALUES (1, 'Existing Brand', 'Existing tagline', '/api/public/brand-assets/old-logo.png',
                '/api/public/brand-assets/old-favicon.ico', '#285B47', 'dark', 'Existing footer',
                'login_required', 1700000000, 1700000001);
        INSERT INTO user (id, name, email, email_verified, username, role, updated_at)
        VALUES ('existing-user', 'Existing user', 'existing@example.test', 1, 'existing', 'admin', 1700000000000);
        INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at)
        VALUES ('existing-account', 'existing-user', 'credential', 'existing-user', 'stored-hash', 1700000000000);
        INSERT INTO session (id, expires_at, token, user_id, updated_at)
        VALUES ('existing-session', 1800000000000, 'test-session-token', 'existing-user', 1700000000000);
        INSERT INTO verification (id, identifier, value, expires_at)
        VALUES ('existing-verification', 'existing@example.test', 'test-verification', 1800000000000);
        INSERT INTO public_categories (id, name, sort_order, is_visible) VALUES (1, 'Public tools', 3, 0);
        INSERT INTO public_links (category_id, title, url, description, sort_order)
        VALUES (1, 'Public link', 'https://example.test/public', 'Existing description', 2);
        INSERT INTO personal_categories (id, user_id, name, is_default)
        VALUES (1, 'existing-user', 'My links', 1);
        INSERT INTO personal_links (user_id, category_id, title, url, normalized_url)
        VALUES ('existing-user', 1, 'Personal link', 'https://example.test/me', 'https://example.test/me');
      `);

      const tables = ['user', 'account', 'session', 'verification', 'public_categories',
        'public_links', 'personal_categories', 'personal_links'];
      const before = tables.map((table) => upgrade.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
      const settingsBefore = upgrade.sqlite.prepare('SELECT * FROM site_settings').get() as Record<string, unknown>;

      runMigrations(upgrade);
      const expectedSettings = { ...settingsBefore,
        page_background_color: null, surface_color: null, background_image_path: null,
        // T1: the home-theme document is added nullable, so a pre-existing row
        // gains it as NULL — the "everything automatic" state.
        home_theme_config: null };
      expect(upgrade.sqlite.prepare('SELECT * FROM site_settings').get()).toEqual(expectedSettings);
      expect(tables.map((table) => upgrade.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(before);
      expect(upgrade.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(upgrade.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');

      runMigrations(upgrade);
      expect(upgrade.sqlite.prepare('SELECT * FROM site_settings').get()).toEqual(expectedSettings);
      expect(tables.map((table) => upgrade.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(before);
      expect(upgrade.sqlite.prepare('SELECT * FROM __drizzle_migrations').all()).toHaveLength(5);
    } finally {
      upgrade.close();
    }
  });
});

describe('data integrity', () => {
  it('rejects a public link whose category does not exist', () => {
    expect(() =>
      handle.db
        .insert(publicLinks)
        .values({ categoryId: 999, title: 'Orphan', url: 'https://example.com' })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('cascades category deletion to its public links', () => {
    const category = handle.db
      .insert(publicCategories)
      .values({ name: 'Tools' })
      .returning()
      .get();

    handle.db
      .insert(publicLinks)
      .values({
        categoryId: category.id,
        title: 'Example',
        url: 'https://example.com',
      })
      .run();

    expect(handle.db.select().from(publicLinks).all()).toHaveLength(1);

    handle.db.delete(publicCategories).where(eq(publicCategories.id, category.id)).run();

    expect(handle.db.select().from(publicLinks).all()).toHaveLength(0);
  });
});

describe('column defaults', () => {
  it('applies defaults for categories and links', () => {
    const category = handle.db
      .insert(publicCategories)
      .values({ name: 'Defaults' })
      .returning()
      .get();

    expect(category.sortOrder).toBe(0);
    expect(category.isVisible).toBe(true);
    expect(category.icon).toBeNull();

    const link = handle.db
      .insert(publicLinks)
      .values({ categoryId: category.id, title: 'Link', url: 'https://example.com' })
      .returning()
      .get();

    expect(link.sortOrder).toBe(0);
    expect(link.isVisible).toBe(true);
    expect(link.description).toBeNull();
    expect(link.iconUrl).toBeNull();
  });

  it('applies site_settings defaults and stores timestamps in Unix seconds', () => {
    const settings = handle.db
      .insert(siteSettings)
      .values({ siteName: 'Example Navigation' })
      .returning()
      .get();

    expect(settings.defaultTheme).toBe('light');
    expect(settings.accessMode).toBe('public');
    expect(settings.tagline).toBeNull();
    expect(settings.logoPath).toBeNull();
    expect(settings.pageBackgroundColor).toBeNull();
    expect(settings.surfaceColor).toBeNull();
    expect(settings.backgroundImagePath).toBeNull();

    // Database-generated defaults must be interpreted as seconds, not milliseconds.
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(Math.abs(settings.createdAt.getTime() / 1000 - nowSeconds)).toBeLessThan(60);
    expect(Math.abs(settings.updatedAt.getTime() / 1000 - nowSeconds)).toBeLessThan(60);
  });

  it('enforces NOT NULL on required columns', () => {
    expect(() =>
      handle.sqlite.prepare('insert into public_categories (name) values (null)').run(),
    ).toThrow(/NOT NULL constraint failed/i);
  });
});
