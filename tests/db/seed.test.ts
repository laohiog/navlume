import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/index.js';
import { publicCategories, publicLinks, siteSettings } from '../../src/db/schema.js';
import { seedDemoData } from '../../src/db/seed.js';
import { createTempDatabase, type TempDatabase } from '../helpers/temp-database.js';

let temp: TempDatabase;
let handle: DatabaseHandle;

function counts(): { site: number; categories: number; links: number } {
  return {
    site: handle.db.select().from(siteSettings).all().length,
    categories: handle.db.select().from(publicCategories).all().length,
    links: handle.db.select().from(publicLinks).all().length,
  };
}

beforeEach(() => {
  temp = createTempDatabase();
  handle = temp.handle;
});

afterEach(() => {
  temp.dispose();
});

describe('seedDemoData', () => {
  it('seeds an empty database', () => {
    expect(seedDemoData(handle.db)).toBe('seeded');
    expect(counts()).toEqual({ site: 1, categories: 2, links: 3 });
  });

  it('is idempotent: a second run does not duplicate data', () => {
    seedDemoData(handle.db);
    const afterFirst = counts();

    expect(seedDemoData(handle.db)).toBe('skipped');
    expect(counts()).toEqual(afterFirst);
  });

  it('does not modify an existing site_settings row', () => {
    handle.db.insert(siteSettings).values({ siteName: 'Real Site' }).run();

    expect(seedDemoData(handle.db)).toBe('skipped');
    expect(counts()).toEqual({ site: 1, categories: 0, links: 0 });
    expect(handle.db.select().from(siteSettings).get()?.siteName).toBe('Real Site');
  });

  it('does not append demo categories when categories already exist', () => {
    handle.db.insert(publicCategories).values({ name: 'Existing' }).run();

    expect(seedDemoData(handle.db)).toBe('skipped');
    expect(handle.db.select().from(publicCategories).all()).toHaveLength(1);
    expect(handle.db.select().from(publicLinks).all()).toHaveLength(0);
  });

  it('does not append demo links when links already exist', () => {
    handle.db.insert(publicCategories).values({ id: 1, name: 'Existing' }).run();
    handle.db
      .insert(publicLinks)
      .values({ title: 'Existing Link', url: 'https://example.com', categoryId: 1 })
      .run();

    expect(seedDemoData(handle.db)).toBe('skipped');
    expect(counts()).toEqual({ site: 0, categories: 1, links: 1 });
  });

  it('leaves the database unchanged when the transaction is rolled back', () => {
    expect(() =>
      handle.db.transaction((tx) => {
        seedDemoData(tx as unknown as typeof handle.db);
        throw new Error('forced rollback');
      }),
    ).toThrow('forced rollback');

    expect(counts()).toEqual({ site: 0, categories: 0, links: 0 });
  });
});
