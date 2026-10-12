import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../src/db/index.js';
import { personalCategories, personalLinks } from '../../src/db/schema.js';
import { createTempDatabase, type TempDatabase } from '../helpers/temp-database.js';

/**
 * Database-level integrity for personal data.
 *
 * These assertions deliberately go through SQLite constraints rather than
 * application code: cross-user isolation must hold even if a caller bypasses the
 * HTTP layer entirely.
 */

let temp: TempDatabase;
let handle: DatabaseHandle;

/** Insert a Better Auth user row directly (this suite tests the DB, not auth). */
function insertUser(id: string, email: string): void {
  handle.sqlite
    .prepare(
      "insert into user (id, name, email, email_verified, role) values (?, ?, ?, 1, 'user')",
    )
    .run(id, id, email);
}

function insertCategory(userId: string, name: string, isDefault = false): number {
  return handle.db
    .insert(personalCategories)
    .values({ userId, name, sortOrder: 0, isDefault })
    .returning()
    .get().id;
}

function insertLink(userId: string, categoryId: number, title = 'Link'): void {
  handle.db
    .insert(personalLinks)
    .values({ userId, categoryId, title, url: 'https://example.com', normalizedUrl: 'https://example.com' })
    .run();
}

const counts = () => ({
  categories: handle.db.select().from(personalCategories).all().length,
  links: handle.db.select().from(personalLinks).all().length,
});

beforeEach(() => {
  temp = createTempDatabase();
  handle = temp.handle;
  insertUser('user-a', 'a@example.com');
  insertUser('user-b', 'b@example.com');
});

afterEach(() => {
  temp.dispose();
});

describe('personal tables exist with the expected shape', () => {
  it('creates both tables', () => {
    const names = (
      handle.sqlite.prepare("select name from sqlite_master where type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    expect(names).toContain('personal_categories');
    expect(names).toContain('personal_links');
  });

  it('declares the required columns', () => {
    const categoryCols = (
      handle.sqlite.pragma('table_info(personal_categories)') as Array<{ name: string }>
    ).map((column) => column.name);
    const linkCols = (
      handle.sqlite.pragma('table_info(personal_links)') as Array<{ name: string }>
    ).map((column) => column.name);

    expect(categoryCols).toEqual([
      'id',
      'user_id',
      'name',
      'sort_order',
      'is_default',
      'created_at',
      'updated_at',
    ]);
    expect(linkCols).toEqual([
      'id',
      'user_id',
      'category_id',
      'title',
      'url',
      'normalized_url',
      'icon_url',
      'sort_order',
      'created_at',
      'updated_at',
    ]);
  });
});

describe('user ownership integrity', () => {
  it('rejects a category whose user does not exist', () => {
    expect(() => insertCategory('ghost', 'X')).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('rejects a link whose user does not exist', () => {
    const categoryId = insertCategory('user-a', 'Cat');

    expect(() =>
      handle.db
        .insert(personalLinks)
        .values({
          userId: 'ghost',
          categoryId,
          title: 'T',
          url: 'https://x.test',
          normalizedUrl: 'https://x.test',
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('rejects a link whose category does not exist', () => {
    expect(() => insertLink('user-a', 99999)).toThrow(/FOREIGN KEY constraint failed/i);
  });
});

describe('cross-user category association is impossible', () => {
  it('rejects a link owned by A that points at B\'s category', () => {
    const categoryB = insertCategory('user-b', 'B Category');

    expect(() => insertLink('user-a', categoryB)).toThrow(/FOREIGN KEY constraint failed/i);
    expect(counts().links).toBe(0);
  });

  it('accepts a link owned by B pointing at B\'s own category', () => {
    const categoryB = insertCategory('user-b', 'B Category');

    expect(() => insertLink('user-b', categoryB)).not.toThrow();
    expect(counts().links).toBe(1);
  });

  it('rejects the swap direction too (B -> A category)', () => {
    const categoryA = insertCategory('user-a', 'A Category');

    expect(() => insertLink('user-b', categoryA)).toThrow(/FOREIGN KEY constraint failed/i);
  });
});

describe('one default category per user', () => {
  it('rejects a second default category for the same user', () => {
    insertCategory('user-a', '⭐ 我的常用', true);

    expect(() => insertCategory('user-a', 'Another Default', true)).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it('allows each user to have exactly one default', () => {
    insertCategory('user-a', '⭐ 我的常用', true);

    expect(() => insertCategory('user-b', '⭐ 我的常用', true)).not.toThrow();
  });

  it('allows multiple non-default categories for one user', () => {
    insertCategory('user-a', 'Cat 1');

    expect(() => insertCategory('user-a', 'Cat 2')).not.toThrow();
  });
});

describe('cascade behavior', () => {
  it('deletes a category\'s links with the category', () => {
    const categoryA = insertCategory('user-a', 'Cat');
    insertLink('user-a', categoryA);
    expect(counts().links).toBe(1);

    handle.db.delete(personalCategories).where(eq(personalCategories.id, categoryA)).run();

    expect(counts()).toEqual({ categories: 0, links: 0 });
  });

  it('deletes all personal data when the user is deleted', () => {
    const categoryA = insertCategory('user-a', 'A Cat');
    insertLink('user-a', categoryA);
    insertCategory('user-b', 'B Cat');

    handle.sqlite.prepare('delete from user where id = ?').run('user-a');

    expect(handle.db.select().from(personalCategories).all().map((c) => c.userId)).toEqual([
      'user-b',
    ]);
    expect(counts().links).toBe(0);
  });

  it('keeps User B data untouched when User A is deleted', () => {
    const categoryB = insertCategory('user-b', 'B Cat');
    insertLink('user-b', categoryB);
    insertCategory('user-a', 'A Cat');

    handle.sqlite.prepare('delete from user where id = ?').run('user-a');

    const remaining = handle.db.select().from(personalCategories).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.userId).toBe('user-b');
    expect(handle.db.select().from(personalLinks).all()).toHaveLength(1);
  });

  it('leaves no orphans after deletion', () => {
    const categoryA = insertCategory('user-a', 'A Cat');
    insertLink('user-a', categoryA);

    handle.sqlite.prepare('delete from user where id = ?').run('user-a');

    expect(handle.sqlite.pragma('foreign_key_check')).toHaveLength(0);
    expect(handle.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
