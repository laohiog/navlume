/**
 * Logical JSON data portability for P6.1.
 *
 * Two independent scopes:
 *
 *  - **site** — `site_settings` (portable fields), `public_categories`,
 *    `public_links`. Admin only.
 *  - **personal** — the authenticated user's own `personal_categories` and
 *    `personal_links`. Never another user's.
 *
 * ## Design rules
 *
 * **Portable logical data only.** Raw rows are never serialized blindly. Database
 * identifiers are re-created on import; the document carries `source_id` purely to
 * preserve relationships *within the document*, and those values are never used as
 * destination ids.
 *
 * **Asset paths are not portable.** `logo_path`/`favicon_path`/`background_image_path` are
 * instance-local references to files on this deployment. Exporting them would make
 * a JSON document a way to point another instance at an arbitrary path, which
 * would defeat the P5.2 upload boundary. Site import therefore leaves the
 * destination's existing asset paths untouched. Asset portability belongs to P6.2.
 *
 * **Import is validate → preview → confirm → apply, and apply is atomic.**
 * Validation never writes. Apply revalidates from scratch (a preview is not a
 * credential) and performs the entire replacement inside one SQLite transaction,
 * so a failure at any point leaves the previous data completely intact.
 *
 * **`normalized_url` is server-derived.** It is never trusted from the document;
 * it is recomputed with the same `validateLinkUrl` the rest of the application
 * uses, which is also what rejects forbidden schemes.
 */

import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../db/schema.js';
import {
  personalCategories,
  personalLinks,
  publicCategories,
  publicLinks,
  siteSettings,
} from '../db/schema.js';
import { validateLinkUrl } from './url.js';
import { BrandingError, validateBrandColor } from './branding.js';

type Db = BetterSQLite3Database<typeof schema>;

/** The only document version this build understands. */
export const PORTABLE_SCHEMA_VERSION = 1;

/** Raised for any document the caller may not import. */
export class DataPortabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPortabilityError';
  }
}

/* -------------------------------------------------------------------------- */
/* Document types                                                              */
/* -------------------------------------------------------------------------- */

export interface SiteExportDocument {
  schema_version: number;
  type: 'site';
  site_settings: {
    site_name: string;
    tagline: string | null;
    primary_color: string | null;
    page_background_color?: string | null;
    surface_color?: string | null;
    default_theme: 'light' | 'dark';
    footer_text: string | null;
    access_mode: 'public' | 'login_required';
  };
  public_categories: {
    source_id: number;
    name: string;
    icon: string | null;
    sort_order: number;
    is_visible: boolean;
  }[];
  public_links: {
    source_id: number;
    category_source_id: number;
    title: string;
    url: string;
    description: string | null;
    icon_url: string | null;
    sort_order: number;
    is_visible: boolean;
  }[];
}

export interface PersonalExportDocument {
  schema_version: number;
  type: 'personal';
  personal_categories: {
    source_id: number;
    name: string;
    sort_order: number;
    is_default: boolean;
  }[];
  personal_links: {
    source_id: number;
    category_source_id: number;
    title: string;
    url: string;
    icon_url: string | null;
    sort_order: number;
  }[];
}

/** Result of a successful validation, in destination-ready shape. */
interface ValidatedSite {
  siteSettings: SiteExportDocument['site_settings'] & {
    page_background_color: string | null;
    surface_color: string | null;
  };
  categories: { sourceId: number; name: string; icon: string | null; isVisible: boolean }[];
  links: {
    sourceId: number;
    categorySourceId: number;
    title: string;
    url: string;
    normalizedUrl: string;
    description: string | null;
    iconUrl: string | null;
    isVisible: boolean;
  }[];
}

interface ValidatedPersonal {
  categories: { sourceId: number; name: string; isDefault: boolean }[];
  links: {
    sourceId: number;
    categorySourceId: number;
    title: string;
    url: string;
    normalizedUrl: string;
    iconUrl: string | null;
  }[];
}

/* -------------------------------------------------------------------------- */
/* Primitive validators                                                        */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataPortabilityError(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new DataPortabilityError(`${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new DataPortabilityError(`${field} must not be empty`);
  }

  if (trimmed.length > maxLength) {
    throw new DataPortabilityError(`${field} is too long`);
  }

  return trimmed;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new DataPortabilityError(`${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new DataPortabilityError(`${field} is too long`);
  }

  return trimmed;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DataPortabilityError(`${field} must be a boolean`);
  }

  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DataPortabilityError(`${field} must be a non-negative integer`);
  }

  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DataPortabilityError(`${field} must be a positive integer`);
  }

  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DataPortabilityError(`${field} must be an array`);
  }

  return value;
}

/**
 * Validate a URL with the application's single URL authority.
 *
 * Returns both the original text and the server-derived canonical form. Because
 * `validateLinkUrl` rejects every non-HTTP scheme, a forbidden scheme
 * (`javascript:`, `data:`, `file:`, `ftp:`, …) cannot reach storage through
 * import.
 */
function requireHttpUrl(value: unknown, field: string): { url: string; normalizedUrl: string } {
  if (typeof value !== 'string') {
    throw new DataPortabilityError(`${field} must be a string`);
  }

  const parsed = validateLinkUrl(value);

  if (parsed === null) {
    throw new DataPortabilityError(`${field} must be a valid http(s) URL`);
  }

  return parsed;
}

/** Optional HTTP(S) URL, canonicalized, or `null`. */
function optionalHttpUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }

  return requireHttpUrl(value, field).normalizedUrl;
}

function requireBrandColor(value: unknown, field: string): string | null {
  try {
    return validateBrandColor(value, field);
  } catch (error) {
    if (error instanceof BrandingError) {
      throw new DataPortabilityError(error.message);
    }
    throw error;
  }
}

function requireTheme(value: unknown): 'light' | 'dark' {
  if (value !== 'light' && value !== 'dark') {
    throw new DataPortabilityError('default_theme must be "light" or "dark"');
  }

  return value;
}

function requireAccessMode(value: unknown): 'public' | 'login_required' {
  if (value !== 'public' && value !== 'login_required') {
    throw new DataPortabilityError('access_mode must be "public" or "login_required"');
  }

  return value;
}

/** Read and verify the document envelope, returning the body for the right type. */
function requireEnvelope(raw: unknown, expectedType: 'site' | 'personal'): Record<string, unknown> {
  const doc = asRecord(raw, 'document');

  if (doc['schema_version'] !== PORTABLE_SCHEMA_VERSION) {
    throw new DataPortabilityError(
      `unsupported schema_version (expected ${String(PORTABLE_SCHEMA_VERSION)})`,
    );
  }

  if (doc['type'] !== expectedType) {
    throw new DataPortabilityError(`document type must be "${expectedType}"`);
  }

  return doc;
}

/* -------------------------------------------------------------------------- */
/* Site validation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Validate a site document completely, without touching the database.
 *
 * Enforces: envelope, portable settings, category/link field shapes, unique
 * `source_id`s, and that every link points at a category present in the document.
 */
export function validateSiteDocument(raw: unknown): ValidatedSite {
  const doc = requireEnvelope(raw, 'site');

  const settings = asRecord(doc['site_settings'], 'site_settings');
  const siteSettingsValidated: ValidatedSite['siteSettings'] = {
    site_name: requireString(settings['site_name'], 'site_name', 100),
    tagline: optionalString(settings['tagline'], 'tagline', 500),
    primary_color: requireBrandColor(settings['primary_color'], 'primary_color'),
    page_background_color: requireBrandColor(settings['page_background_color'], 'page_background_color'),
    surface_color: requireBrandColor(settings['surface_color'], 'surface_color'),
    default_theme: requireTheme(settings['default_theme']),
    footer_text: optionalString(settings['footer_text'], 'footer_text', 500),
    access_mode: requireAccessMode(settings['access_mode']),
  };

  const rawCategories = requireArray(doc['public_categories'], 'public_categories');
  const seenCategoryIds = new Set<number>();
  const categories: (ValidatedSite['categories'][number] & { sortOrder: number })[] = [];

  for (const [index, entry] of rawCategories.entries()) {
    const record = asRecord(entry, `public_categories[${String(index)}]`);
    const sourceId = requirePositiveInt(record['source_id'], `public_categories[${String(index)}].source_id`);

    if (seenCategoryIds.has(sourceId)) {
      throw new DataPortabilityError(`duplicate source_id ${String(sourceId)} in public_categories`);
    }
    seenCategoryIds.add(sourceId);

    categories.push({
      sourceId,
      name: requireString(record['name'], `public_categories[${String(index)}].name`, 100),
      icon: optionalString(record['icon'], `public_categories[${String(index)}].icon`, 100),
      isVisible: requireBoolean(record['is_visible'], `public_categories[${String(index)}].is_visible`),
      sortOrder: requireNonNegativeInt(record['sort_order'], `public_categories[${String(index)}].sort_order`),
    });
  }

  // Preserve the document's intended order, then discard the raw numbers — the
  // apply step renumbers contiguously so destination ids never leak in.
  categories.sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.sourceId - b.sourceId : a.sortOrder - b.sortOrder,
  );
  const orderedCategories = categories.map(({ sourceId, name, icon, isVisible }) => ({
    sourceId,
    name,
    icon,
    isVisible,
  }));

  const rawLinks = requireArray(doc['public_links'], 'public_links');
  const seenLinkIds = new Set<number>();
  const links: (ValidatedSite['links'][number] & { sortOrder: number })[] = [];

  for (const [index, entry] of rawLinks.entries()) {
    const record = asRecord(entry, `public_links[${String(index)}]`);
    const sourceId = requirePositiveInt(record['source_id'], `public_links[${String(index)}].source_id`);

    if (seenLinkIds.has(sourceId)) {
      throw new DataPortabilityError(`duplicate source_id ${String(sourceId)} in public_links`);
    }
    seenLinkIds.add(sourceId);

    const categorySourceId = requirePositiveInt(
      record['category_source_id'],
      `public_links[${String(index)}].category_source_id`,
    );

    if (!seenCategoryIds.has(categorySourceId)) {
      throw new DataPortabilityError(
        `public_links[${String(index)}].category_source_id ${String(categorySourceId)} references a category that is not in the document`,
      );
    }

    const parsed = requireHttpUrl(record['url'], `public_links[${String(index)}].url`);

    links.push({
      sourceId,
      categorySourceId,
      title: requireString(record['title'], `public_links[${String(index)}].title`, 100),
      url: parsed.url,
      normalizedUrl: parsed.normalizedUrl,
      description: optionalString(record['description'], `public_links[${String(index)}].description`, 500),
      iconUrl: optionalHttpUrl(record['icon_url'], `public_links[${String(index)}].icon_url`),
      isVisible: requireBoolean(record['is_visible'], `public_links[${String(index)}].is_visible`),
      sortOrder: requireNonNegativeInt(record['sort_order'], `public_links[${String(index)}].sort_order`),
    });
  }

  // Order links within each category, preserving the document's intent.
  const orderedLinks = links
    .slice()
    .sort((a, b) =>
      a.sortOrder === b.sortOrder ? a.sourceId - b.sourceId : a.sortOrder - b.sortOrder,
    )
    .map(({ sourceId, categorySourceId, title, url, normalizedUrl, description, iconUrl, isVisible }) => ({
      sourceId,
      categorySourceId,
      title,
      url,
      normalizedUrl,
      description,
      iconUrl,
      isVisible,
    }));

  return { siteSettings: siteSettingsValidated, categories: orderedCategories, links: orderedLinks };
}

/* -------------------------------------------------------------------------- */
/* Personal validation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Validate a personal document completely, without touching the database.
 *
 * Enforces the P4.3 product invariants: at least one category, exactly one
 * default, and no two links sharing a `normalized_url` inside the same category
 * (the duplicate rule the personal mutation path already enforces).
 */
export function validatePersonalDocument(raw: unknown): ValidatedPersonal {
  const doc = requireEnvelope(raw, 'personal');

  const rawCategories = requireArray(doc['personal_categories'], 'personal_categories');

  if (rawCategories.length === 0) {
    throw new DataPortabilityError('personal document must contain at least one category');
  }

  const seenCategoryIds = new Set<number>();
  const defaultFlags: boolean[] = [];
  const categories: (ValidatedPersonal['categories'][number] & { sortOrder: number })[] = [];

  for (const [index, entry] of rawCategories.entries()) {
    const record = asRecord(entry, `personal_categories[${String(index)}]`);
    const sourceId = requirePositiveInt(record['source_id'], `personal_categories[${String(index)}].source_id`);

    if (seenCategoryIds.has(sourceId)) {
      throw new DataPortabilityError(`duplicate source_id ${String(sourceId)} in personal_categories`);
    }
    seenCategoryIds.add(sourceId);

    const isDefault = requireBoolean(record['is_default'], `personal_categories[${String(index)}].is_default`);
    defaultFlags.push(isDefault);

    categories.push({
      sourceId,
      name: requireString(record['name'], `personal_categories[${String(index)}].name`, 100),
      isDefault,
      sortOrder: requireNonNegativeInt(record['sort_order'], `personal_categories[${String(index)}].sort_order`),
    });
  }

  const defaultCount = defaultFlags.filter(Boolean).length;

  if (defaultCount === 0) {
    throw new DataPortabilityError('personal document must mark exactly one category as default');
  }

  if (defaultCount > 1) {
    throw new DataPortabilityError('personal document must not contain multiple default categories');
  }

  categories.sort((a, b) => (a.sortOrder === b.sortOrder ? a.sourceId - b.sourceId : a.sortOrder - b.sortOrder));

  const rawLinks = requireArray(doc['personal_links'], 'personal_links');
  const seenLinkIds = new Set<number>();
  /** `${categorySourceId}:${normalizedUrl}` — the same-category duplicate key. */
  const seenPerCategoryUrl = new Set<string>();
  const links: (ValidatedPersonal['links'][number] & { sortOrder: number })[] = [];

  for (const [index, entry] of rawLinks.entries()) {
    const record = asRecord(entry, `personal_links[${String(index)}]`);
    const sourceId = requirePositiveInt(record['source_id'], `personal_links[${String(index)}].source_id`);

    if (seenLinkIds.has(sourceId)) {
      throw new DataPortabilityError(`duplicate source_id ${String(sourceId)} in personal_links`);
    }
    seenLinkIds.add(sourceId);

    const categorySourceId = requirePositiveInt(
      record['category_source_id'],
      `personal_links[${String(index)}].category_source_id`,
    );

    if (!seenCategoryIds.has(categorySourceId)) {
      throw new DataPortabilityError(
        `personal_links[${String(index)}].category_source_id ${String(categorySourceId)} references a category that is not in the document`,
      );
    }

    const parsed = requireHttpUrl(record['url'], `personal_links[${String(index)}].url`);
    const duplicateKey = `${String(categorySourceId)}:${parsed.normalizedUrl}`;

    if (seenPerCategoryUrl.has(duplicateKey)) {
      throw new DataPortabilityError(
        `personal_links[${String(index)}] duplicates an existing URL within the same category`,
      );
    }
    seenPerCategoryUrl.add(duplicateKey);

    links.push({
      sourceId,
      categorySourceId,
      // Personal Link CRUD has no title length cap; its exports must stay importable.
      title: requireString(record['title'], `personal_links[${String(index)}].title`, Number.POSITIVE_INFINITY),
      url: parsed.url,
      normalizedUrl: parsed.normalizedUrl,
      iconUrl: optionalHttpUrl(record['icon_url'], `personal_links[${String(index)}].icon_url`),
      sortOrder: requireNonNegativeInt(record['sort_order'], `personal_links[${String(index)}].sort_order`),
    });
  }

  links.sort((a, b) => (a.sortOrder === b.sortOrder ? a.sourceId - b.sourceId : a.sortOrder - b.sortOrder));

  return {
    categories: categories.map(({ sourceId, name, isDefault }) => ({ sourceId, name, isDefault })),
    links: links.map(({ sourceId, categorySourceId, title, url, normalizedUrl, iconUrl }) => ({
      sourceId,
      categorySourceId,
      title,
      url,
      normalizedUrl,
      iconUrl,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Export the site's portable logical data.
 *
 * Omits Logo, Favicon, and Background paths: those are instance-local asset
 * references, and including them would let a JSON file point an instance at an
 * arbitrary path (defeating the P5.2 upload boundary).
 */
export function exportSiteData(db: Db): SiteExportDocument {
  const site = db.select().from(siteSettings).orderBy(asc(siteSettings.id)).limit(1).get();

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

  return {
    schema_version: PORTABLE_SCHEMA_VERSION,
    type: 'site',
    site_settings: {
      // A missing settings row exports the product's effective defaults.
      site_name: site?.siteName ?? '导航',
      tagline: site?.tagline ?? null,
      primary_color: site?.primaryColor ?? null,
      page_background_color: site?.pageBackgroundColor ?? null,
      surface_color: site?.surfaceColor ?? null,
      default_theme: site?.defaultTheme ?? 'light',
      footer_text: site?.footerText ?? null,
      access_mode: site?.accessMode ?? 'public',
    },
    public_categories: categories.map((category) => ({
      source_id: category.id,
      name: category.name,
      icon: category.icon,
      sort_order: category.sortOrder,
      is_visible: category.isVisible,
    })),
    public_links: links.map((link) => ({
      source_id: link.id,
      category_source_id: link.categoryId,
      title: link.title,
      url: link.url,
      description: link.description,
      icon_url: link.iconUrl,
      sort_order: link.sortOrder,
      is_visible: link.isVisible,
    })),
  };
}

/**
 * Export one user's personal navigation.
 *
 * Ownership is the caller-supplied `userId`, which the route takes from the
 * Better Auth session — never from the request. The document contains no
 * `user_id`, so it can never assert ownership on import.
 */
export function exportPersonalData(db: Db, userId: string): PersonalExportDocument {
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

  return {
    schema_version: PORTABLE_SCHEMA_VERSION,
    type: 'personal',
    personal_categories: categories.map((category) => ({
      source_id: category.id,
      name: category.name,
      sort_order: category.sortOrder,
      is_default: category.isDefault,
    })),
    personal_links: links.map((link) => ({
      source_id: link.id,
      category_source_id: link.categoryId,
      title: link.title,
      url: link.url,
      icon_url: link.iconUrl,
      // `normalized_url` is intentionally not exported: it is server-derived state
      // and is recomputed on import.
      sort_order: link.sortOrder,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

export interface SiteImportPreview {
  scope: 'site';
  incomingCategories: number;
  incomingLinks: number;
  currentCategories: number;
  currentLinks: number;
  brandingUpdated: true;
  /** Always true: Logo, Favicon, and Background asset paths are never imported. */
  assetsPreserved: true;
  replacementWarning: string;
}

export interface PersonalImportPreview {
  scope: 'personal';
  incomingCategories: number;
  incomingLinks: number;
  currentCategories: number;
  currentLinks: number;
  replacementWarning: string;
}

/**
 * Validate a site document and summarize what applying it would do.
 *
 * Performs **zero writes**: validation is pure and the counts are reads.
 */
export function previewSiteImport(db: Db, raw: unknown): SiteImportPreview {
  const validated = validateSiteDocument(raw);

  const currentCategories = db.select({ id: publicCategories.id }).from(publicCategories).all().length;
  const currentLinks = db.select({ id: publicLinks.id }).from(publicLinks).all().length;

  return {
    scope: 'site',
    incomingCategories: validated.categories.length,
    incomingLinks: validated.links.length,
    currentCategories,
    currentLinks,
    brandingUpdated: true,
    assetsPreserved: true,
    replacementWarning: '导入将替换当前的公共导航与品牌文字设置。',
  };
}

/** Validate a personal document and summarize what applying it would do. Zero writes. */
export function previewPersonalImport(db: Db, userId: string, raw: unknown): PersonalImportPreview {
  const validated = validatePersonalDocument(raw);

  const currentCategories = db
    .select({ id: personalCategories.id })
    .from(personalCategories)
    .where(eq(personalCategories.userId, userId))
    .all().length;

  const currentLinks = db
    .select({ id: personalLinks.id })
    .from(personalLinks)
    .where(eq(personalLinks.userId, userId))
    .all().length;

  return {
    scope: 'personal',
    incomingCategories: validated.categories.length,
    incomingLinks: validated.links.length,
    currentCategories,
    currentLinks,
    replacementWarning: '导入将替换当前个人导航。',
  };
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Atomically replace public navigation and portable branding settings.
 *
 * One transaction covers the settings update, the delete of the previous public
 * navigation, and every insert — so a failure at any point leaves the previous
 * state exactly as it was. Logo, Favicon, and Background paths are not part of
 * the write, preserving the destination's existing assets.
 */
export function applySiteImport(db: Db, raw: unknown): SiteImportPreview {
  // Revalidate from scratch: a prior preview is not a credential.
  const validated = validateSiteDocument(raw);

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;

    const existing = txDb.select().from(siteSettings).orderBy(asc(siteSettings.id)).limit(1).get();

    const portable = {
      siteName: validated.siteSettings.site_name,
      tagline: validated.siteSettings.tagline,
      primaryColor: validated.siteSettings.primary_color,
      pageBackgroundColor: validated.siteSettings.page_background_color,
      surfaceColor: validated.siteSettings.surface_color,
      defaultTheme: validated.siteSettings.default_theme,
      footerText: validated.siteSettings.footer_text,
      accessMode: validated.siteSettings.access_mode,
    };

    if (existing === undefined) {
      // No row yet: create one. Asset paths start empty and stay instance-local.
      tx.insert(siteSettings).values(portable).run();
    } else {
      // Only portable fields are written; all three managed asset paths are untouched.
      tx.update(siteSettings)
        .set({ ...portable, updatedAt: new Date() })
        .where(eq(siteSettings.id, existing.id))
        .run();
    }

    // Replace public navigation entirely. Links first, then categories.
    tx.delete(publicLinks).run();
    tx.delete(publicCategories).run();

    const categoryIdBySource = new Map<number, number>();

    for (const [index, category] of validated.categories.entries()) {
      const created = tx
        .insert(publicCategories)
        .values({
          name: category.name,
          icon: category.icon,
          sortOrder: index,
          isVisible: category.isVisible,
        })
        .returning()
        .get();

      categoryIdBySource.set(category.sourceId, created.id);
    }

    // Renumber links contiguously per category so ordering matches the document.
    const perCategoryIndex = new Map<number, number>();

    for (const link of validated.links) {
      const categoryId = categoryIdBySource.get(link.categorySourceId);

      if (categoryId === undefined) {
        // Unreachable: validation guarantees every link has a category.
        throw new DataPortabilityError('link references a category that is not in the document');
      }

      const nextIndex = perCategoryIndex.get(categoryId) ?? 0;
      perCategoryIndex.set(categoryId, nextIndex + 1);

      tx.insert(publicLinks)
        .values({
          categoryId,
          title: link.title,
          // Canonical absolute form, matching Public Link CRUD exactly.
          //
          // `public_links.url` is what Public Navigation renders as `<a href>`,
          // so it must be directly navigable: a scheme-less input would render as
          // a relative href against this application's own origin. The existing
          // CRUD path stores `validateLinkUrl(...).normalizedUrl` for the same
          // reason, and `validateLinkUrl` stays the single normalization
          // authority — no second implementation is introduced here.
          //
          // The document's raw `url` text is intentionally not used.
          url: link.normalizedUrl,
          description: link.description,
          iconUrl: link.iconUrl,
          sortOrder: nextIndex,
          isVisible: link.isVisible,
        })
        .run();
    }

    return previewSiteImport(txDb, raw);
  });
}

/**
 * Atomically replace the current user's personal navigation.
 *
 * Every inserted row uses `userId` — the authenticated session user — so the
 * document can never place data in another account. Deletes are scoped to
 * `userId`, leaving other users' rows untouched.
 */
export function applyPersonalImport(db: Db, userId: string, raw: unknown): PersonalImportPreview {
  const validated = validatePersonalDocument(raw);

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;

    // Scoped to this user only.
    tx.delete(personalLinks)
      .where(eq(personalLinks.userId, userId))
      .run();
    tx.delete(personalCategories)
      .where(eq(personalCategories.userId, userId))
      .run();

    const categoryIdBySource = new Map<number, number>();

    for (const [index, category] of validated.categories.entries()) {
      const created = tx
        .insert(personalCategories)
        .values({
          userId,
          name: category.name,
          sortOrder: index,
          isDefault: category.isDefault,
        })
        .returning()
        .get();

      categoryIdBySource.set(category.sourceId, created.id);
    }

    const perCategoryIndex = new Map<number, number>();

    for (const link of validated.links) {
      const categoryId = categoryIdBySource.get(link.categorySourceId);

      if (categoryId === undefined) {
        throw new DataPortabilityError('link references a category that is not in the document');
      }

      const nextIndex = perCategoryIndex.get(categoryId) ?? 0;
      perCategoryIndex.set(categoryId, nextIndex + 1);

      tx.insert(personalLinks)
        .values({
          userId,
          categoryId,
          title: link.title,
          url: link.url,
          // Recomputed server-side from `url`; the document's value is ignored.
          normalizedUrl: link.normalizedUrl,
          iconUrl: link.iconUrl,
          sortOrder: nextIndex,
        })
        .run();
    }

    return previewPersonalImport(txDb, userId, raw);
  });
}
