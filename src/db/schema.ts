import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { user } from './auth-schema.js';

/**
 * Timestamp columns shared by every P1 table.
 *
 * Declared as a factory (not a shared object) because Drizzle column builders
 * carry per-table state and must not be reused across tables.
 *
 * Stored as Unix seconds (`mode: 'timestamp'`). The database default is written
 * explicitly as SQLite `unixepoch()` rather than Drizzle's `defaultNow()`:
 * `defaultNow()` emits a millisecond expression while `mode: 'timestamp'`
 * interprets stored values as seconds, which would make database-generated
 * defaults read back as dates far in the future.
 */
function timestamps() {
  const now = sql`(unixepoch())`;
  return {
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
  };
}

/**
 * Site-wide branding and access configuration.
 *
 * MVP uses a single active row; multi-site/tenant logic is explicitly out of scope.
 */
export const siteSettings = sqliteTable('site_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteName: text('site_name').notNull(),
  tagline: text('tagline'),
  logoPath: text('logo_path'),
  faviconPath: text('favicon_path'),
  primaryColor: text('primary_color'),
  pageBackgroundColor: text('page_background_color'),
  surfaceColor: text('surface_color'),
  backgroundImagePath: text('background_image_path'),
  defaultTheme: text('default_theme', { enum: ['light', 'dark'] }).notNull().default('light'),
  footerText: text('footer_text'),
  accessMode: text('access_mode', { enum: ['public', 'login_required'] })
    .notNull()
    .default('public'),
  ...timestamps(),
});

/** Admin-managed public navigation categories. */
export const publicCategories = sqliteTable('public_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
  isVisible: integer('is_visible', { mode: 'boolean' }).notNull().default(true),
  ...timestamps(),
});

/** Admin-managed public links. Always belong to exactly one public category. */
export const publicLinks = sqliteTable('public_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  categoryId: integer('category_id')
    .notNull()
    .references(() => publicCategories.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),
  sortOrder: integer('sort_order').notNull().default(0),
  isVisible: integer('is_visible', { mode: 'boolean' }).notNull().default(true),
  ...timestamps(),
});

export type SiteSettings = typeof siteSettings.$inferSelect;
export type PublicCategory = typeof publicCategories.$inferSelect;
export type PublicLink = typeof publicLinks.$inferSelect;

/**
 * A user's personal navigation category.
 *
 * `user_id` references the Better Auth user. The `(user_id, id)` unique index is
 * not decorative: it is the parent key of `personal_links`' composite foreign
 * key, which is what makes "a personal link can only reference a category owned
 * by the same user" a database guarantee rather than an application convention.
 */
export const personalCategories = sqliteTable(
  'personal_categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    index('personal_categories_userId_idx').on(table.userId),
    uniqueIndex('personal_categories_userId_id_unique').on(table.userId, table.id),
    // At most one default category per user, enforced by the database.
    uniqueIndex('personal_categories_one_default_per_user')
      .on(table.userId)
      .where(sql`${table.isDefault} = 1`),
  ],
);

/**
 * A user's personal navigation link.
 *
 * Two foreign keys share `user_id`:
 * - `user_id -> user.id`: deleting a user removes their links;
 * - `(user_id, category_id) -> personal_categories(user_id, id)`: the category
 *   must belong to the same user, so User A cannot attach a link to User B's
 *   category even with a forged request body.
 */
export const personalLinks = sqliteTable(
  'personal_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    iconUrl: text('icon_url'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    index('personal_links_userId_idx').on(table.userId),
    index('personal_links_categoryId_idx').on(table.categoryId),
    foreignKey({
      columns: [table.userId, table.categoryId],
      foreignColumns: [personalCategories.userId, personalCategories.id],
      name: 'personal_links_same_user_category_fk',
    }).onDelete('cascade'),
  ],
);

export type PersonalCategory = typeof personalCategories.$inferSelect;
export type PersonalLink = typeof personalLinks.$inferSelect;
