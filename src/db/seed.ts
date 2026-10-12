import { pathToFileURL } from 'node:url';

import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { createDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import * as schema from './schema.js';
import { publicCategories, publicLinks, siteSettings } from './schema.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Deterministic, brand-neutral demo dataset.
 *
 * IDs are explicit so repeatable tests and screenshots stay stable. No network
 * access is performed and no instance-specific data is included.
 */
const DEMO_SITE = {
  id: 1,
  siteName: 'Brandable Navigation Platform',
  tagline: 'Simple · Brandable · Self-hosted · Portable · Fast',
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  defaultTheme: 'light' as const,
  footerText: null,
  accessMode: 'public' as const,
};

const DEMO_CATEGORIES = [
  { id: 1, name: 'Example', icon: null, sortOrder: 0, isVisible: true },
  { id: 2, name: 'Reference', icon: null, sortOrder: 1, isVisible: true },
];

const DEMO_LINKS = [
  {
    id: 1,
    categoryId: 1,
    title: 'Example Domain',
    url: 'https://example.com',
    description: null,
    iconUrl: null,
    sortOrder: 0,
    isVisible: true,
  },
  {
    id: 2,
    categoryId: 1,
    title: 'Example Org',
    url: 'https://example.org',
    description: null,
    iconUrl: null,
    sortOrder: 1,
    isVisible: true,
  },
  {
    id: 3,
    categoryId: 2,
    title: 'MDN Web Docs',
    url: 'https://developer.mozilla.org',
    description: null,
    iconUrl: null,
    sortOrder: 0,
    isVisible: true,
  },
];

export type SeedResult = 'seeded' | 'skipped';

/**
 * Insert the demo dataset only when every public-data table is empty.
 *
 * The emptiness check and the inserts run inside a single transaction so a
 * partially-populated database can never receive demo rows. An existing
 * non-empty dataset is left completely untouched.
 */
export function seedDemoData(db: Db): SeedResult {
  return db.transaction((tx) => {
    const siteCount = tx.select({ count: sql<number>`count(*)` }).from(siteSettings).get()?.count ?? 0;
    const categoryCount =
      tx.select({ count: sql<number>`count(*)` }).from(publicCategories).get()?.count ?? 0;
    const linkCount =
      tx.select({ count: sql<number>`count(*)` }).from(publicLinks).get()?.count ?? 0;

    if (siteCount > 0 || categoryCount > 0 || linkCount > 0) {
      return 'skipped';
    }

    tx.insert(siteSettings).values(DEMO_SITE).run();
    tx.insert(publicCategories).values(DEMO_CATEGORIES).run();
    tx.insert(publicLinks).values(DEMO_LINKS).run();

    return 'seeded';
  });
}

/**
 * CLI entry point: `npm run db:seed`.
 *
 * Explicit, development/demo-only. It migrates first (so a fresh database is
 * usable), then inserts demo data only if the public tables are empty.
 */
function main(): void {
  const databasePath = process.argv[2];
  const handle = databasePath === undefined ? createDatabase() : createDatabase(databasePath);

  try {
    runMigrations(handle);
    const result = seedDemoData(handle.db);

    if (result === 'seeded') {
      console.log('[db] demo data seeded');
    } else {
      console.log('[db] existing public data found; seeding skipped');
    }
  } finally {
    handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
