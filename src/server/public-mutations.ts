/**
 * Admin mutations for the site's Public Navigation.
 *
 * Public navigation is **site-wide** data owned by the site, not by a user, so
 * nothing here filters by `userId`. Authorization is entirely the caller's
 * responsibility: `app.ts` resolves the Better Auth session and requires the
 * `admin` role before invoking any of these functions. These functions
 * deliberately contain no role logic of their own, so a route cannot
 * accidentally become an authorization boundary.
 *
 * Two rules carried over from the rest of the codebase:
 *
 *  - **`normalized_url` does not exist for public links.** `public_links` has a
 *    single `url` column, so the *canonical absolute* URL produced by the shared
 *    server validator is stored there. A scheme-less input like `example.com`
 *    therefore persists as `https://example.com/`, which keeps the public anchor
 *    an absolute destination rather than something the browser could resolve
 *    relative to the current page.
 *  - **No new duplicate policy.** P4.3's same-category duplicate rule is a
 *    personal-navigation concept. Site-wide public links may legitimately repeat
 *    a URL, so no uniqueness is enforced and no index is added.
 *
 * No server-side request is ever made for a URL: `validateLinkUrl` is a pure
 * parser, so there is no metadata crawler and no SSRF surface.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../db/schema.js';
import { publicCategories, publicLinks } from '../db/schema.js';
import { validateLinkUrl } from './url.js';

type Db = BetterSQLite3Database<typeof schema>;

/** Raised for admin requests the caller could not legitimately make. */
export type PublicMutationErrorCode = 'not_found' | 'validation';

/**
 * A public mutation failure that maps cleanly onto an HTTP status.
 *
 * Deliberately separate from `PersonalMutationError`: public data has no
 * ownership dimension, so there is no `conflict` code and nothing to keep
 * indistinguishable from another user's rows.
 */
export class PublicMutationError extends Error {
  readonly code: PublicMutationErrorCode;

  constructor(code: PublicMutationErrorCode, message: string) {
    super(message);
    this.name = 'PublicMutationError';
    this.code = code;
  }
}

/** A public category as exposed to the admin editor, including hidden rows. */
export interface AdminPublicCategory {
  id: number;
  name: string;
  icon: string | null;
  sortOrder: number;
  isVisible: boolean;
}

/** A public link as exposed to the admin editor, including hidden rows. */
export interface AdminPublicLink {
  id: number;
  categoryId: number;
  title: string;
  url: string;
  description: string | null;
  iconUrl: string | null;
  sortOrder: number;
  isVisible: boolean;
}

/** Response body of `GET /api/admin/public-navigation`. */
export interface AdminPublicNavigation {
  categories: (AdminPublicCategory & { links: AdminPublicLink[] })[];
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

function requireNonEmptyName(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PublicMutationError('validation', `${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new PublicMutationError('validation', `${field} must not be empty`);
  }

  if (trimmed.length > 100) {
    throw new PublicMutationError('validation', `${field} is too long`);
  }

  return trimmed;
}

/**
 * Optional plain text: absent/`null`/blank becomes `null`.
 *
 * Text fields are stored verbatim as text. Category `icon` in particular is never
 * interpreted as markup, so it cannot become an HTML injection vector.
 */
function optionalText(value: unknown, field: string, maxLength = 500): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new PublicMutationError('validation', `${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new PublicMutationError('validation', `${field} is too long`);
  }

  return trimmed;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new PublicMutationError('validation', `${field} must be a positive integer`);
  }

  return value;
}

/** Optional boolean flag; `undefined` leaves the caller's default in place. */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new PublicMutationError('validation', `${field} must be a boolean`);
  }

  return value;
}

/**
 * Validate and canonicalize a public link URL.
 *
 * Reuses the shared server validator — the same one personal links use — so the
 * accept/reject rules cannot drift. The **normalized** value is returned because
 * `public_links` has no separate `normalized_url` column; storing the canonical
 * absolute form is what keeps the public anchor safe.
 */
function requireCanonicalUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PublicMutationError('validation', 'url must be a string');
  }

  const parsed = validateLinkUrl(value);

  if (parsed === null) {
    throw new PublicMutationError('validation', 'url must be a valid http(s) URL');
  }

  return parsed.normalizedUrl;
}

/** Optional HTTP(S) icon URL, canonicalized, or `null`. */
function optionalCanonicalUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new PublicMutationError('validation', `${field} must be a string`);
  }

  const parsed = validateLinkUrl(value);

  if (parsed === null) {
    throw new PublicMutationError('validation', `${field} must be a valid http(s) url`);
  }

  return parsed.normalizedUrl;
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

function requireCategory(db: Db, categoryId: number) {
  const row = db
    .select()
    .from(publicCategories)
    .where(eq(publicCategories.id, categoryId))
    .get();

  if (row === undefined) {
    throw new PublicMutationError('not_found', 'Category not found');
  }

  return row;
}

function requireLink(db: Db, linkId: number) {
  const row = db.select().from(publicLinks).where(eq(publicLinks.id, linkId)).get();

  if (row === undefined) {
    throw new PublicMutationError('not_found', 'Link not found');
  }

  return row;
}

/** Append position: one past the current maximum across the whole table. */
function nextCategorySortOrder(db: Db): number {
  const row = db
    .select({ max: sql<number | null>`max(${publicCategories.sortOrder})` })
    .from(publicCategories)
    .get();

  return (row?.max ?? -1) + 1;
}

/** Append position within one category. */
function nextLinkSortOrder(db: Db, categoryId: number): number {
  const row = db
    .select({ max: sql<number | null>`max(${publicLinks.sortOrder})` })
    .from(publicLinks)
    .where(eq(publicLinks.categoryId, categoryId))
    .get();

  return (row?.max ?? -1) + 1;
}

/* -------------------------------------------------------------------------- */
/* Admin read                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read **all** public categories and links, including hidden rows.
 *
 * The ordinary public endpoint deliberately excludes hidden rows, which would
 * make it impossible for an admin to unhide anything. This is the admin-facing
 * counterpart and must only ever be reachable behind the admin role check.
 *
 * Ordered by `sortOrder` then `id`, matching the rest of the project.
 */
export function getAdminPublicNavigation(db: Db): AdminPublicNavigation {
  const categories = db
    .select()
    .from(publicCategories)
    .orderBy(asc(publicCategories.sortOrder), asc(publicCategories.id))
    .all();

  const links = db
    .select()
    .from(publicLinks)
    .orderBy(asc(publicLinks.sortOrder), asc(publicLinks.id))
    .all();

  const linksByCategory = new Map<number, AdminPublicLink[]>();

  for (const link of links) {
    const entry: AdminPublicLink = {
      id: link.id,
      categoryId: link.categoryId,
      title: link.title,
      url: link.url,
      description: link.description,
      iconUrl: link.iconUrl,
      sortOrder: link.sortOrder,
      isVisible: link.isVisible,
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
      icon: category.icon,
      sortOrder: category.sortOrder,
      isVisible: category.isVisible,
      links: linksByCategory.get(category.id) ?? [],
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Category mutations                                                          */
/* -------------------------------------------------------------------------- */

function toAdminCategory(row: typeof publicCategories.$inferSelect): AdminPublicCategory {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
  };
}

/**
 * Create a public category.
 *
 * Client-supplied `id`, `sortOrder`, and timestamps are never read: the new row
 * is always appended, so ordering cannot be forged past the reorder endpoint.
 */
export function createPublicCategory(
  db: Db,
  body: { name?: unknown; icon?: unknown; isVisible?: unknown },
): AdminPublicCategory {
  const name = requireNonEmptyName(body.name, 'name');
  const icon = optionalText(body.icon, 'icon', 100);
  const isVisible = optionalBoolean(body.isVisible, 'isVisible') ?? true;

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;

    const created = tx
      .insert(publicCategories)
      .values({ name, icon, sortOrder: nextCategorySortOrder(txDb), isVisible })
      .returning()
      .get();

    return toAdminCategory(created);
  });
}

/**
 * Update a category's name, icon, and/or visibility.
 *
 * Hiding a category hides it from the ordinary public endpoint while leaving its
 * links untouched — links are not deleted or hidden as a side effect, so
 * unhiding the category restores exactly what was there before.
 */
export function updatePublicCategory(
  db: Db,
  categoryId: number,
  body: { name?: unknown; icon?: unknown; isVisible?: unknown },
): AdminPublicCategory {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireCategory(txDb, categoryId);

    const patch: Partial<typeof publicCategories.$inferInsert> = { updatedAt: new Date() };

    if (body.name !== undefined) {
      patch.name = requireNonEmptyName(body.name, 'name');
    }

    if (body.icon !== undefined) {
      patch.icon = optionalText(body.icon, 'icon', 100);
    }

    const isVisible = optionalBoolean(body.isVisible, 'isVisible');
    if (isVisible !== undefined) {
      patch.isVisible = isVisible;
    }

    const updated = tx
      .update(publicCategories)
      .set(patch)
      .where(eq(publicCategories.id, categoryId))
      .returning()
      .get();

    return toAdminCategory(updated);
  });
}

/**
 * Delete a category.
 *
 * Contained links are removed by the existing `public_links.category_id` foreign
 * key (`onDelete: 'cascade'`). No application-side cleanup is performed, so there
 * is exactly one source of truth for the cascade and no way to leave orphans.
 */
export function deletePublicCategory(db: Db, categoryId: number): void {
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireCategory(txDb, categoryId);

    tx.delete(publicCategories).where(eq(publicCategories.id, categoryId)).run();
  });
}

/**
 * Rewrite the public category order.
 *
 * `ids` must be exactly the current set of public category ids — **including
 * hidden ones** — with no duplicates, no unknowns, and nothing missing. Any
 * mismatch aborts inside the transaction before a single write, so a rejected
 * reorder is atomic. On success `sortOrder` is rewritten contiguously from 0.
 */
export function reorderPublicCategories(
  db: Db,
  body: { ids?: unknown },
): AdminPublicCategory[] {
  if (!Array.isArray(body.ids)) {
    throw new PublicMutationError('validation', 'ids must be an array');
  }

  const ids = body.ids.map((id) => requirePositiveInt(id, 'id'));

  if (new Set(ids).size !== ids.length) {
    throw new PublicMutationError('validation', 'ids must not contain duplicates');
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;

    const current = txDb.select({ id: publicCategories.id }).from(publicCategories).all();
    const currentIds = current.map((row) => row.id).sort((a, b) => a - b);
    const requestedIds = [...ids].sort((a, b) => a - b);

    if (
      currentIds.length !== requestedIds.length ||
      currentIds.some((id, index) => id !== requestedIds[index])
    ) {
      throw new PublicMutationError('validation', 'ids must be exactly the current category ids');
    }

    for (const [index, id] of ids.entries()) {
      tx.update(publicCategories)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(eq(publicCategories.id, id))
        .run();
    }

    return txDb
      .select()
      .from(publicCategories)
      .orderBy(asc(publicCategories.sortOrder), asc(publicCategories.id))
      .all()
      .map(toAdminCategory);
  });
}

/* -------------------------------------------------------------------------- */
/* Link mutations                                                              */
/* -------------------------------------------------------------------------- */

function toAdminLink(row: typeof publicLinks.$inferSelect): AdminPublicLink {
  return {
    id: row.id,
    categoryId: row.categoryId,
    title: row.title,
    url: row.url,
    description: row.description,
    iconUrl: row.iconUrl,
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
  };
}

/**
 * Create a public link inside an existing category.
 *
 * The URL is canonicalized through the shared server validator, so a scheme-less
 * `example.com` is stored as `https://example.com/`. `sortOrder` is never read
 * from the client; the link always appends to its category.
 */
export function createPublicLink(
  db: Db,
  body: {
    categoryId?: unknown;
    title?: unknown;
    url?: unknown;
    description?: unknown;
    iconUrl?: unknown;
    isVisible?: unknown;
  },
): AdminPublicLink {
  const categoryId = requirePositiveInt(body.categoryId, 'categoryId');
  const title = requireNonEmptyName(body.title, 'title');
  const url = requireCanonicalUrl(body.url);
  const description = optionalText(body.description, 'description', 500);
  const iconUrl = optionalCanonicalUrl(body.iconUrl, 'iconUrl');
  const isVisible = optionalBoolean(body.isVisible, 'isVisible') ?? true;

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireCategory(txDb, categoryId);

    const created = tx
      .insert(publicLinks)
      .values({
        categoryId,
        title,
        url,
        description,
        iconUrl,
        sortOrder: nextLinkSortOrder(txDb, categoryId),
        isVisible,
      })
      .returning()
      .get();

    return toAdminLink(created);
  });
}

/**
 * Update a link's text, URL, visibility, and/or category.
 *
 * Moving to another category appends to the destination's ordering; the client
 * never supplies a sort order. Any URL change re-runs full server validation. A
 * rejected update performs zero writes because every check happens before the
 * `UPDATE` statement inside the transaction.
 */
export function updatePublicLink(
  db: Db,
  linkId: number,
  body: {
    title?: unknown;
    url?: unknown;
    description?: unknown;
    iconUrl?: unknown;
    isVisible?: unknown;
    categoryId?: unknown;
  },
): AdminPublicLink {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const existing = requireLink(txDb, linkId);

    const patch: Partial<typeof publicLinks.$inferInsert> = { updatedAt: new Date() };

    if (body.title !== undefined) {
      patch.title = requireNonEmptyName(body.title, 'title');
    }

    if (body.url !== undefined) {
      patch.url = requireCanonicalUrl(body.url);
    }

    if (body.description !== undefined) {
      patch.description = optionalText(body.description, 'description', 500);
    }

    if (body.iconUrl !== undefined) {
      patch.iconUrl = optionalCanonicalUrl(body.iconUrl, 'iconUrl');
    }

    const isVisible = optionalBoolean(body.isVisible, 'isVisible');
    if (isVisible !== undefined) {
      patch.isVisible = isVisible;
    }

    if (body.categoryId !== undefined) {
      const categoryId = requirePositiveInt(body.categoryId, 'categoryId');
      requireCategory(txDb, categoryId);

      if (categoryId !== existing.categoryId) {
        patch.categoryId = categoryId;
        patch.sortOrder = nextLinkSortOrder(txDb, categoryId);
      }
    }

    const updated = tx
      .update(publicLinks)
      .set(patch)
      .where(eq(publicLinks.id, linkId))
      .returning()
      .get();

    return toAdminLink(updated);
  });
}

/** Delete exactly one public link. Unrelated rows are untouched. */
export function deletePublicLink(db: Db, linkId: number): void {
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireLink(txDb, linkId);

    tx.delete(publicLinks).where(eq(publicLinks.id, linkId)).run();
  });
}

/**
 * Rewrite the order of links within one category.
 *
 * `ids` must be exactly that category's current link ids — **including hidden
 * ones** — or the whole transaction aborts with zero writes. This endpoint does
 * not move links between categories; that is the update route's job.
 */
export function reorderPublicLinks(
  db: Db,
  body: { categoryId?: unknown; ids?: unknown },
): AdminPublicLink[] {
  const categoryId = requirePositiveInt(body.categoryId, 'categoryId');

  if (!Array.isArray(body.ids)) {
    throw new PublicMutationError('validation', 'ids must be an array');
  }

  const ids = body.ids.map((id) => requirePositiveInt(id, 'id'));

  if (new Set(ids).size !== ids.length) {
    throw new PublicMutationError('validation', 'ids must not contain duplicates');
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    requireCategory(txDb, categoryId);

    const current = txDb
      .select({ id: publicLinks.id })
      .from(publicLinks)
      .where(eq(publicLinks.categoryId, categoryId))
      .all();

    const currentIds = current.map((row) => row.id).sort((a, b) => a - b);
    const requestedIds = [...ids].sort((a, b) => a - b);

    if (
      currentIds.length !== requestedIds.length ||
      currentIds.some((id, index) => id !== requestedIds[index])
    ) {
      throw new PublicMutationError('validation', "ids must be exactly this category's links");
    }

    for (const [index, id] of ids.entries()) {
      tx.update(publicLinks)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(and(eq(publicLinks.id, id), eq(publicLinks.categoryId, categoryId)))
        .run();
    }

    return txDb
      .select()
      .from(publicLinks)
      .where(eq(publicLinks.categoryId, categoryId))
      .orderBy(asc(publicLinks.sortOrder), asc(publicLinks.id))
      .all()
      .map(toAdminLink);
  });
}
