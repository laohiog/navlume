import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../db/schema.js';
import { personalCategories, personalLinks } from '../db/schema.js';

/** The default category every user starts with. */
export const DEFAULT_PERSONAL_CATEGORY_NAME = '⭐ 我的常用';

/** A personal link as exposed to its owning user. */
export interface PersonalLinkView {
  id: number;
  title: string;
  url: string;
  normalizedUrl: string;
  iconUrl: string | null;
  sortOrder: number;
}

/** A personal category with the owner's links. */
export interface PersonalCategoryView {
  id: number;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  links: PersonalLinkView[];
}

/** Response body of `GET /api/personal/navigation`. */
export interface PersonalNavigation {
  categories: PersonalCategoryView[];
}

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Ensure the user has a default personal category and return its id.
 *
 * Ownership always comes from the caller's server-validated session user id; no
 * client-supplied identity participates.
 *
 * Concurrency safety relies on the database, not on application locking:
 * `onConflictDoNothing` makes a concurrent duplicate insert a no-op, and the
 * partial unique index `personal_categories_one_default_per_user` guarantees at
 * most one default row per user. The subsequent read therefore always finds
 * exactly one default category.
 */
function ensureDefaultCategory(db: Db, userId: string): number {
  return db.transaction((tx) => {
    tx.insert(personalCategories)
      .values({ userId, name: DEFAULT_PERSONAL_CATEGORY_NAME, sortOrder: 0, isDefault: true })
      .onConflictDoNothing()
      .run();

    const preferred = tx
      .select({ id: personalCategories.id })
      .from(personalCategories)
      .where(and(eq(personalCategories.userId, userId), eq(personalCategories.isDefault, true)))
      .limit(1)
      .get();

    // The insert above guarantees a default row exists for this user.
    if (preferred === undefined) {
      throw new Error('failed to initialize default personal category');
    }

    return preferred.id;
  });
}

/**
 * Read one user's personal navigation.
 *
 * Every query is bound to `userId`, which the route takes from the Better Auth
 * session — never from the request body, query string, or headers. This is the
 * `WHERE user_id = currentUser.id` invariant from the data model.
 *
 * Ordering is deterministic: `sort_order ASC, id ASC` for both levels.
 *
 * The default category is created lazily here so that a user's first visit
 * produces their `⭐ 我的常用` category. Deliberately not created at signup time.
 */
export function getPersonalNavigation(db: Db, userId: string): PersonalNavigation {
  ensureDefaultCategory(db, userId);

  const categories = db
    .select()
    .from(personalCategories)
    .where(eq(personalCategories.userId, userId))
    .orderBy(asc(personalCategories.sortOrder), asc(personalCategories.id))
    .all();

  const links = db
    .select()
    .from(personalLinks)
    .where(eq(personalLinks.userId, userId))
    .orderBy(asc(personalLinks.sortOrder), asc(personalLinks.id))
    .all();

  const linksByCategory = new Map<number, PersonalLinkView[]>();
  for (const link of links) {
    const entry: PersonalLinkView = {
      id: link.id,
      title: link.title,
      url: link.url,
      normalizedUrl: link.normalizedUrl,
      iconUrl: link.iconUrl,
      sortOrder: link.sortOrder,
    };

    const bucket = linksByCategory.get(link.categoryId);
    if (bucket === undefined) {
      linksByCategory.set(link.categoryId, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  return {
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
      isDefault: category.isDefault,
      links: linksByCategory.get(category.id) ?? [],
    })),
  };
}
