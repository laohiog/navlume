import { and, asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../db/schema.js';
import { personalCategories, personalLinks } from '../db/schema.js';
import { validateLinkUrl } from './url.js';

type Db = BetterSQLite3Database<typeof schema>;

/** Raised for requests the caller could not legitimately make. */
export type PersonalMutationErrorCode =
  | 'not_found'
  | 'validation'
  | 'conflict';

/**
 * A mutation failure that maps cleanly onto an HTTP status.
 *
 * `not_found` deliberately covers three cases — unknown id, another user's id,
 * and (for links) a category that is not the caller's — so the API cannot be
 * used to probe which resources exist or who owns them.
 */
export class PersonalMutationError extends Error {
  readonly code: PersonalMutationErrorCode;

  constructor(code: PersonalMutationErrorCode, message: string) {
    super(message);
    this.name = 'PersonalMutationError';
    this.code = code;
  }
}

/** Client-facing category representation. Never includes `user_id`. */
export interface CategoryDto {
  id: number;
  name: string;
  sortOrder: number;
  isDefault: boolean;
}

/** Client-facing link representation. Never includes `user_id`. */
export interface LinkDto {
  id: number;
  categoryId: number;
  title: string;
  url: string;
  normalizedUrl: string;
  iconUrl: string | null;
  sortOrder: number;
}

/* -------------------------------------------------------------------------- */
/* Lookups — every one is scoped by userId                                     */
/* -------------------------------------------------------------------------- */

/** Load a category only if it belongs to `userId`; otherwise `not_found`. */
function requireOwnCategory(db: Db, userId: string, categoryId: number) {
  const row = db
    .select()
    .from(personalCategories)
    .where(and(eq(personalCategories.id, categoryId), eq(personalCategories.userId, userId)))
    .get();

  if (row === undefined) {
    throw new PersonalMutationError('not_found', 'Category not found');
  }

  return row;
}

/** Load a link only if it belongs to `userId`; otherwise `not_found`. */
function requireOwnLink(db: Db, userId: string, linkId: number) {
  const row = db
    .select()
    .from(personalLinks)
    .where(and(eq(personalLinks.id, linkId), eq(personalLinks.userId, userId)))
    .get();

  if (row === undefined) {
    throw new PersonalMutationError('not_found', 'Link not found');
  }

  return row;
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

function requireNonEmptyName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersonalMutationError('validation', 'name must be a string');
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new PersonalMutationError('validation', 'name must not be empty');
  }

  if (trimmed.length > 100) {
    throw new PersonalMutationError('validation', 'name is too long');
  }

  return trimmed;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new PersonalMutationError('validation', `${field} must be a positive integer`);
  }

  return value;
}

/**
 * Reject a duplicate `normalized_url` within the same user's category.
 *
 * Duplicate identity for P4.3 is exactly:
 *
 *   authenticated user + target category + server-generated normalized_url
 *
 * The same URL in two different categories is intentionally allowed — a user may
 * keep the same site in `⭐ 我的常用` and in another category — so this is scoped
 * to one category and is deliberately not a per-user uniqueness rule.
 *
 * `normalizedUrl` must come from `validateLinkUrl`; a client-supplied value is
 * never read. `exceptLinkId` excludes the row being edited, so a link can always
 * save its own unchanged URL/category without conflicting with itself.
 *
 * Runs inside the caller's transaction, so a conflict performs zero writes — the
 * check aborts before the insert/update statement executes. The `userId` and
 * `categoryId` predicates are what keep the check from leaking whether another
 * user or another category holds the same URL.
 */
function assertNotDuplicateLink(
  db: Db,
  userId: string,
  categoryId: number,
  normalizedUrl: string,
  exceptLinkId?: number,
): void {
  const duplicate = db
    .select({ id: personalLinks.id })
    .from(personalLinks)
    .where(
      and(
        eq(personalLinks.userId, userId),
        eq(personalLinks.categoryId, categoryId),
        eq(personalLinks.normalizedUrl, normalizedUrl),
      ),
    )
    .all()
    .find((row) => row.id !== exceptLinkId);

  if (duplicate !== undefined) {
    throw new PersonalMutationError('conflict', 'link already exists in this category');
  }
}

/** Append position: one past the current maximum within the user's rows. */
function nextCategorySortOrder(db: Db, userId: string): number {
  const row = db
    .select({ max: sql<number | null>`max(${personalCategories.sortOrder})` })
    .from(personalCategories)
    .where(eq(personalCategories.userId, userId))
    .get();

  return (row?.max ?? -1) + 1;
}

function nextLinkSortOrder(db: Db, userId: string, categoryId: number): number {
  const row = db
    .select({ max: sql<number | null>`max(${personalLinks.sortOrder})` })
    .from(personalLinks)
    .where(and(eq(personalLinks.userId, userId), eq(personalLinks.categoryId, categoryId)))
    .get();

  return (row?.max ?? -1) + 1;
}

/* -------------------------------------------------------------------------- */
/* Category mutations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Create a category for `userId`.
 *
 * Deliberately ignores any client-supplied `userId`/`isDefault` — new categories
 * are always non-default so the user keeps exactly one default (a database
 * invariant). The new row is appended after the user's existing categories.
 */
export function createCategory(db: Db, userId: string, body: { name?: unknown }): CategoryDto {
  const name = requireNonEmptyName(body.name);

  return db.transaction((tx) => {
    const sortOrder = nextCategorySortOrder(tx as unknown as Db, userId);

    const created = tx
      .insert(personalCategories)
      .values({ userId, name, sortOrder, isDefault: false })
      .returning()
      .get();

    return {
      id: created.id,
      name: created.name,
      sortOrder: created.sortOrder,
      isDefault: created.isDefault,
    };
  });
}

/** Rename a category. `is_default` is not client-modifiable. */
export function updateCategory(
  db: Db,
  userId: string,
  categoryId: number,
  body: { name?: unknown },
): CategoryDto {
  const name = requireNonEmptyName(body.name);

  return db.transaction((tx) => {
    requireOwnCategory(tx as unknown as Db, userId, categoryId);

    const updated = tx
      .update(personalCategories)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(personalCategories.id, categoryId), eq(personalCategories.userId, userId)))
      .returning()
      .get();

    return {
      id: updated.id,
      name: updated.name,
      sortOrder: updated.sortOrder,
      isDefault: updated.isDefault,
    };
  });
}

/**
 * Delete a category and (via the existing foreign key) its links.
 *
 * The default category cannot be deleted: doing so would leave the user with no
 * default target for Quick Add.
 */
export function deleteCategory(db: Db, userId: string, categoryId: number): void {
  db.transaction((tx) => {
    const category = requireOwnCategory(tx as unknown as Db, userId, categoryId);

    if (category.isDefault) {
      throw new PersonalMutationError('conflict', 'The default category cannot be deleted');
    }

    tx.delete(personalCategories)
      .where(and(eq(personalCategories.id, categoryId), eq(personalCategories.userId, userId)))
      .run();
  });
}

/**
 * Rewrite the caller's category order.
 *
 * `ids` must be exactly the set of the user's category ids — no duplicates, no
 * missing rows, and nothing belonging to another user. Any mismatch aborts the
 * whole transaction, so a rejected reorder performs zero writes.
 */
export function reorderCategories(
  db: Db,
  userId: string,
  body: { ids?: unknown },
): CategoryDto[] {
  if (!Array.isArray(body.ids)) {
    throw new PersonalMutationError('validation', 'ids must be an array');
  }

  const ids = body.ids.map((id) => requirePositiveInt(id, 'id'));

  if (new Set(ids).size !== ids.length) {
    throw new PersonalMutationError('validation', 'ids must not contain duplicates');
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const owned = txDb
      .select({ id: personalCategories.id })
      .from(personalCategories)
      .where(eq(personalCategories.userId, userId))
      .all();

    const ownedIds = owned.map((row) => row.id).sort((a, b) => a - b);
    const requestedIds = [...ids].sort((a, b) => a - b);

    if (
      ownedIds.length !== requestedIds.length ||
      ownedIds.some((id, index) => id !== requestedIds[index])
    ) {
      // Union of "unknown", "foreign", and "missing" — one indistinguishable error.
      throw new PersonalMutationError('validation', 'ids must be exactly your category ids');
    }

    for (const [index, id] of ids.entries()) {
      tx.update(personalCategories)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(and(eq(personalCategories.id, id), eq(personalCategories.userId, userId)))
        .run();
    }

    return txDb
      .select()
      .from(personalCategories)
      .where(eq(personalCategories.userId, userId))
      .orderBy(asc(personalCategories.sortOrder), asc(personalCategories.id))
      .all()
      .map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
        isDefault: category.isDefault,
      }));
  });
}

/* -------------------------------------------------------------------------- */
/* Link mutations                                                              */
/* -------------------------------------------------------------------------- */

function toLinkDto(link: typeof personalLinks.$inferSelect): LinkDto {
  return {
    id: link.id,
    categoryId: link.categoryId,
    title: link.title,
    url: link.url,
    normalizedUrl: link.normalizedUrl,
    iconUrl: link.iconUrl,
    sortOrder: link.sortOrder,
  };
}

/**
 * Create a link inside one of the caller's own categories.
 *
 * `normalizedUrl` is always derived on the server; a client-supplied value is
 * never read. The target category must belong to `userId`.
 */
export function createLink(
  db: Db,
  userId: string,
  body: { categoryId?: unknown; title?: unknown; url?: unknown },
): LinkDto {
  const categoryId = requirePositiveInt(body.categoryId, 'categoryId');

  if (typeof body.title !== 'string') {
    throw new PersonalMutationError('validation', 'title must be a string');
  }
  const title = body.title.trim();
  if (title.length === 0) {
    throw new PersonalMutationError('validation', 'title must not be empty');
  }

  if (typeof body.url !== 'string') {
    throw new PersonalMutationError('validation', 'url must be a string');
  }
  const parsedUrl = validateLinkUrl(body.url);
  if (parsedUrl === null) {
    throw new PersonalMutationError('validation', 'url must be a valid http(s) URL');
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireOwnCategory(txDb, userId, categoryId);

    // Duplicate check before any insert: the same URL in the same category is a
    // conflict, while the same URL in another category is allowed.
    assertNotDuplicateLink(txDb, userId, categoryId, parsedUrl.normalizedUrl);

    const sortOrder = nextLinkSortOrder(txDb, userId, categoryId);

    const created = tx
      .insert(personalLinks)
      .values({
        userId,
        categoryId,
        title,
        url: parsedUrl.url,
        normalizedUrl: parsedUrl.normalizedUrl,
        sortOrder,
      })
      .returning()
      .get();

    return toLinkDto(created);
  });
}

/**
 * Update a link's title, url, and/or category.
 *
 * A `categoryId` change moves the link; the destination must also belong to the
 * caller. Any URL change re-runs full validation and normalization server-side.
 */
export function updateLink(
  db: Db,
  userId: string,
  linkId: number,
  body: { title?: unknown; url?: unknown; categoryId?: unknown },
): LinkDto {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const existing = requireOwnLink(txDb, userId, linkId);

    const patch: Partial<typeof personalLinks.$inferInsert> = { updatedAt: new Date() };

    if (body.title !== undefined) {
      if (typeof body.title !== 'string') {
        throw new PersonalMutationError('validation', 'title must be a string');
      }
      const title = body.title.trim();
      if (title.length === 0) {
        throw new PersonalMutationError('validation', 'title must not be empty');
      }
      patch.title = title;
    }

    if (body.url !== undefined) {
      if (typeof body.url !== 'string') {
        throw new PersonalMutationError('validation', 'url must be a string');
      }
      const parsedUrl = validateLinkUrl(body.url);
      if (parsedUrl === null) {
        throw new PersonalMutationError('validation', 'url must be a valid http(s) URL');
      }
      patch.url = parsedUrl.url;
      patch.normalizedUrl = parsedUrl.normalizedUrl;
    }

    if (body.categoryId !== undefined) {
      const categoryId = requirePositiveInt(body.categoryId, 'categoryId');
      // Destination must be the caller's own category.
      requireOwnCategory(txDb, userId, categoryId);

      if (categoryId !== existing.categoryId) {
        patch.categoryId = categoryId;
        // Keep ordering simple: the moved link appends to the destination.
        patch.sortOrder = nextLinkSortOrder(txDb, userId, categoryId);
      }
    }

    // Effective post-update values: a partial patch keeps whatever it does not
    // change. The duplicate check therefore covers plain edits, URL edits, moves,
    // and a move combined with a URL change alike, and excludes this link so it
    // can save its own unchanged URL/category.
    const effectiveCategoryId = patch.categoryId ?? existing.categoryId;
    const effectiveNormalizedUrl = patch.normalizedUrl ?? existing.normalizedUrl;

    assertNotDuplicateLink(txDb, userId, effectiveCategoryId, effectiveNormalizedUrl, linkId);

    const updated = tx
      .update(personalLinks)
      .set(patch)
      .where(and(eq(personalLinks.id, linkId), eq(personalLinks.userId, userId)))
      .returning()
      .get();

    return toLinkDto(updated);
  });
}

/** Delete one of the caller's links. Foreign/unknown ids are `not_found`. */
export function deleteLink(db: Db, userId: string, linkId: number): void {
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireOwnLink(txDb, userId, linkId);

    tx.delete(personalLinks)
      .where(and(eq(personalLinks.id, linkId), eq(personalLinks.userId, userId)))
      .run();
  });
}

/**
 * Rewrite the order of links within one of the caller's categories.
 *
 * `ids` must be exactly that category's current link ids. Like the category
 * reorder, any mismatch aborts before any write.
 */
export function reorderLinks(
  db: Db,
  userId: string,
  body: { categoryId?: unknown; ids?: unknown },
): LinkDto[] {
  const categoryId = requirePositiveInt(body.categoryId, 'categoryId');

  if (!Array.isArray(body.ids)) {
    throw new PersonalMutationError('validation', 'ids must be an array');
  }

  const ids = body.ids.map((id) => requirePositiveInt(id, 'id'));

  if (new Set(ids).size !== ids.length) {
    throw new PersonalMutationError('validation', 'ids must not contain duplicates');
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireOwnCategory(txDb, userId, categoryId);

    const current = txDb
      .select({ id: personalLinks.id })
      .from(personalLinks)
      .where(and(eq(personalLinks.userId, userId), eq(personalLinks.categoryId, categoryId)))
      .all();

    const currentIds = current.map((row) => row.id).sort((a, b) => a - b);
    const requestedIds = [...ids].sort((a, b) => a - b);

    if (
      currentIds.length !== requestedIds.length ||
      currentIds.some((id, index) => id !== requestedIds[index])
    ) {
      throw new PersonalMutationError('validation', 'ids must be exactly this category\'s links');
    }

    for (const [index, id] of ids.entries()) {
      tx.update(personalLinks)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(and(eq(personalLinks.id, id), eq(personalLinks.userId, userId)))
        .run();
    }

    return txDb
      .select()
      .from(personalLinks)
      .where(and(eq(personalLinks.userId, userId), eq(personalLinks.categoryId, categoryId)))
      .orderBy(asc(personalLinks.sortOrder), asc(personalLinks.id))
      .all()
      .map(toLinkDto);
  });
}
