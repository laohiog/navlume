/**
 * Site branding: settings, validated image uploads, and safe asset storage.
 *
 * Three concerns live here because they share one invariant — the database must
 * never point at a missing or unsafe asset:
 *
 *  1. **Effective settings** — the MVP has exactly one effective `site_settings`
 *     row. Reads fall back to safe defaults when no row exists yet, and the first
 *     successful mutation creates that row. No multi-site logic.
 *  2. **Validation** — text stays plain bounded text, `primaryColor` must be a
 *     strict `#RRGGBB` literal (so it can never carry CSS), and enumerated fields
 *     are matched exactly.
 *  3. **Asset storage** — uploads are validated by declared MIME *and* magic
 *     bytes, stored under a server-generated filename inside one directory, and
 *     referenced from the database by an application URL rather than a
 *     filesystem path. The original filename is ignored entirely, so a name like
 *     `../../evil.png` cannot influence the path.
 *
 * Authorization is the caller's responsibility: `app.ts` resolves the Better Auth
 * admin session before invoking anything here. No role logic appears in this
 * module, so a route cannot accidentally become its own authorization boundary.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../db/schema.js';
import { siteSettings } from '../db/schema.js';
import {
  parseStoredHomeThemeConfig,
  serializeHomeThemeConfig,
  validateHomeThemeConfig,
  type StoredHomeThemeConfig,
} from './home-theme-config.js';

type Db = BetterSQLite3Database<typeof schema>;

/** Raised for branding requests the caller could not legitimately make. */
export type BrandingErrorCode = 'validation' | 'not_found';

export class BrandingError extends Error {
  readonly code: BrandingErrorCode;

  constructor(code: BrandingErrorCode, message: string) {
    super(message);
    this.name = 'BrandingError';
    this.code = code;
  }
}

/** Site access policy, reusing the schema's own enumerated values. */
export type AccessMode = 'public' | 'login_required';
export type DefaultTheme = 'light' | 'dark';

/** The editable branding state exposed to the admin editor. */
export interface BrandingSettings {
  siteName: string;
  tagline: string | null;
  logoPath: string | null;
  faviconPath: string | null;
  primaryColor: string | null;
  pageBackgroundColor: string | null;
  surfaceColor: string | null;
  backgroundImagePath: string | null;
  defaultTheme: DefaultTheme;
  footerText: string | null;
  accessMode: AccessMode;
  /**
   * Explicit home-page appearance overrides.
   *
   * `null` means "no explicit configuration" — every home-page colour then comes
   * from the automatic contrast derivation, which is exactly the behaviour of a
   * database that predates this column.
   */
  homeThemeConfig: StoredHomeThemeConfig | null;
}

/** The subset of branding that is public presentation data. */
export type PublicBranding = Omit<BrandingSettings, 'accessMode'>;

/** Effective defaults for a database with no `site_settings` row yet. */
export const DEFAULT_BRANDING: BrandingSettings = {
  siteName: '导航',
  tagline: null,
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  pageBackgroundColor: null,
  surfaceColor: null,
  backgroundImagePath: null,
  defaultTheme: 'light',
  footerText: null,
  accessMode: 'public',
  homeThemeConfig: null,
};

/** Repository-local development fallback for the uploads root. */
export const DEFAULT_UPLOADS_DIR = 'data/uploads';

/** Subdirectory (under the uploads root) that holds brand assets. */
export const BRANDING_SUBDIR = 'branding';

/** Public URL prefix under which stored brand assets are served. */
export const BRAND_ASSET_URL_PREFIX = '/api/public/brand-assets/';

/**
 * Resolve the uploads root.
 *
 * Docker deployments will map `UPLOADS_DIR` to a persistent volume in P6; local
 * development falls back to a repository-local directory. Mirrors
 * `resolveDatabasePath` in `src/db/index.ts`.
 */
export function resolveUploadsDir(): string {
  const configured = process.env.UPLOADS_DIR?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_UPLOADS_DIR;
}

/** Absolute-ish path of the branding asset directory for a given uploads root. */
export function brandingDir(uploadsDir: string = resolveUploadsDir()): string {
  return join(uploadsDir, BRANDING_SUBDIR);
}

/* -------------------------------------------------------------------------- */
/* Settings read / write                                                       */
/* -------------------------------------------------------------------------- */

/** Load the effective settings row, or `undefined` when none exists yet. */
function loadRow(db: Db) {
  return db.select().from(siteSettings).orderBy(asc(siteSettings.id)).limit(1).get();
}

/**
 * Read the effective branding settings.
 *
 * A missing row yields `DEFAULT_BRANDING`, so a fresh install serves a sane
 * branded shell rather than nulls.
 */
export function getBranding(db: Db): BrandingSettings {
  const row = loadRow(db);

  if (row === undefined) {
    return { ...DEFAULT_BRANDING };
  }

  return {
    siteName: row.siteName,
    tagline: row.tagline,
    logoPath: row.logoPath,
    faviconPath: row.faviconPath,
    primaryColor: row.primaryColor,
    pageBackgroundColor: row.pageBackgroundColor,
    surfaceColor: row.surfaceColor,
    backgroundImagePath: row.backgroundImagePath,
    defaultTheme: row.defaultTheme,
    footerText: row.footerText,
    accessMode: row.accessMode,
    // A malformed stored document surfaces as a BrandingError rather than a
    // silent reset, so a corrupted column is visible instead of quietly
    // reverting the administrator's saved appearance.
    homeThemeConfig: readStoredHomeThemeConfig(row.homeThemeConfig),
  };
}

/** Parse a stored column, translating the contract's errors into BrandingError. */
function readStoredHomeThemeConfig(raw: string | null): StoredHomeThemeConfig | null {
  try {
    return parseStoredHomeThemeConfig(raw);
  } catch (error) {
    throw new BrandingError('validation', error instanceof Error ? error.message : 'homeThemeConfig is invalid');
  }
}

/** The public presentation subset. Deliberately omits `accessMode`. */
export function getPublicBranding(db: Db): PublicBranding {
  const branding = getBranding(db);

  return {
    siteName: branding.siteName,
    tagline: branding.tagline,
    logoPath: branding.logoPath,
    faviconPath: branding.faviconPath,
    primaryColor: branding.primaryColor,
    pageBackgroundColor: branding.pageBackgroundColor,
    surfaceColor: branding.surfaceColor,
    backgroundImagePath: branding.backgroundImagePath,
    defaultTheme: branding.defaultTheme,
    footerText: branding.footerText,
    // Public presentation data: the home page needs these to render the saved
    // appearance for every visitor, so the field belongs here rather than in an
    // admin-only projection.
    homeThemeConfig: branding.homeThemeConfig,
  };
}

function requireBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new BrandingError('validation', `${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new BrandingError('validation', `${field} must not be empty`);
  }

  if (trimmed.length > maxLength) {
    throw new BrandingError('validation', `${field} is too long`);
  }

  return trimmed;
}

/** Optional plain text: absent/blank becomes `null`. Never interpreted as markup. */
function optionalBoundedText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new BrandingError('validation', `${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new BrandingError('validation', `${field} is too long`);
  }

  return trimmed;
}

/**
 * Validate an editable brand color as `null` or a strict `#RRGGBB` literal.
 *
 * Strictness is the security property: the client applies this value to a CSS
 * custom property, so allowing an arbitrary string would turn admin branding into
 * a stylesheet-injection vector. `url(...)`, `var(...)`, `!important`, and CSS
 * expressions are all rejected simply because they do not match `#RRGGBB`.
 */
export function validateBrandColor(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new BrandingError('validation', `${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    throw new BrandingError('validation', `${field} must be a #RRGGBB hex color`);
  }

  // Canonicalize to upper case so stored values are consistent.
  return `#${trimmed.slice(1).toUpperCase()}`;
}

/**
 * Validate a requested `homeThemeConfig` and serialize it for storage.
 *
 * `null` clears the column; anything else must survive the strict whitelist in
 * `home-theme-config.ts`. Contract errors are re-thrown as `BrandingError` so the
 * route layer can map them to a 400 without knowing about the inner contract.
 */
function serializeValidatedHomeThemeConfig(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  try {
    return serializeHomeThemeConfig(validateHomeThemeConfig(value));
  } catch (error) {
    throw new BrandingError('validation', error instanceof Error ? error.message : 'homeThemeConfig is invalid');
  }
}

function requireDefaultTheme(value: unknown): DefaultTheme {
  if (value !== 'light' && value !== 'dark') {
    throw new BrandingError('validation', 'defaultTheme must be "light" or "dark"');
  }

  return value;
}

function requireAccessMode(value: unknown): AccessMode {
  if (value !== 'public' && value !== 'login_required') {
    throw new BrandingError('validation', 'accessMode must be "public" or "login_required"');
  }

  return value;
}

/**
 * Apply a full settings update.
 *
 * Existing fields retain full-update semantics; omitted new colors are preserved.
 * `logoPath`, `faviconPath`, and `backgroundImagePath`
 * are deliberately **not** accepted here — they may only change through the
 * upload/remove routes, so a JSON body can never point the site at an arbitrary
 * path. `id` and timestamps are likewise never read.
 *
 * Creates the single settings row on first use, and updates that same row
 * thereafter; it never inserts a second row.
 */
export function updateBranding(
  db: Db,
  body: {
    siteName?: unknown;
    tagline?: unknown;
    primaryColor?: unknown;
    pageBackgroundColor?: unknown;
    surfaceColor?: unknown;
    defaultTheme?: unknown;
    footerText?: unknown;
    accessMode?: unknown;
    /**
     * Explicit home-page appearance overrides.
     *
     * Follows the same tri-state convention as `pageBackgroundColor`:
     * `undefined` leaves the stored document untouched, `null` clears it, and an
     * object replaces it wholesale.
     */
    homeThemeConfig?: unknown;
  },
): BrandingSettings {
  const siteName = requireBoundedText(body.siteName, 'siteName', 100);
  const tagline = optionalBoundedText(body.tagline, 'tagline', 500);
  const primaryColor = validateBrandColor(body.primaryColor, 'primaryColor');
  const colorOverrides = {
    ...(body.pageBackgroundColor === undefined ? {} : {
      pageBackgroundColor: validateBrandColor(body.pageBackgroundColor, 'pageBackgroundColor'),
    }),
    ...(body.surfaceColor === undefined ? {} : {
      surfaceColor: validateBrandColor(body.surfaceColor, 'surfaceColor'),
    }),
  };
  // Validated outside the transaction: rejecting a malformed document must not
  // open a write transaction, and the value is immutable from here on.
  const homeThemeOverride =
    body.homeThemeConfig === undefined
      ? {}
      : { homeThemeConfig: serializeValidatedHomeThemeConfig(body.homeThemeConfig) };
  const defaultTheme = requireDefaultTheme(body.defaultTheme);
  const footerText = optionalBoundedText(body.footerText, 'footerText', 500);
  const accessMode = requireAccessMode(body.accessMode);

  return db.transaction((tx) => {
    const existing = loadRow(tx as unknown as Db);

    if (existing === undefined) {
      tx.insert(siteSettings)
        .values({ siteName, tagline, primaryColor, ...colorOverrides, ...homeThemeOverride, defaultTheme, footerText, accessMode })
        .run();
    } else {
      tx.update(siteSettings)
        .set({ siteName, tagline, primaryColor, ...colorOverrides, ...homeThemeOverride, defaultTheme, footerText, accessMode, updatedAt: new Date() })
        .where(eq(siteSettings.id, existing.id))
        .run();
    }

    return getBranding(tx as unknown as Db);
  });
}

/**
 * Persist a managed brand asset path for the effective row.
 *
 * Shared by upload and removal. Creates the row with defaults if it is missing,
 * so an admin can upload before ever saving the settings form.
 */
function setAssetPath(db: Db, column: 'logoPath' | 'faviconPath' | 'backgroundImagePath', value: string | null): BrandingSettings {
  return db.transaction((tx) => {
    const existing = loadRow(tx as unknown as Db);

    if (existing === undefined) {
      // `DEFAULT_BRANDING` is the application-level shape (its `homeThemeConfig`
      // is already a parsed object), so it cannot be spread straight into a
      // column insert. The stored home-theme column is `NULL` here, which is the
      // correct "everything automatic" starting point.
      tx.insert(siteSettings)
        .values({
          siteName: DEFAULT_BRANDING.siteName,
          tagline: DEFAULT_BRANDING.tagline,
          logoPath: DEFAULT_BRANDING.logoPath,
          faviconPath: DEFAULT_BRANDING.faviconPath,
          primaryColor: DEFAULT_BRANDING.primaryColor,
          pageBackgroundColor: DEFAULT_BRANDING.pageBackgroundColor,
          surfaceColor: DEFAULT_BRANDING.surfaceColor,
          backgroundImagePath: DEFAULT_BRANDING.backgroundImagePath,
          defaultTheme: DEFAULT_BRANDING.defaultTheme,
          footerText: DEFAULT_BRANDING.footerText,
          accessMode: DEFAULT_BRANDING.accessMode,
          homeThemeConfig: null,
          [column]: value,
        })
        .run();
    } else {
      tx.update(siteSettings)
        .set({ [column]: value, updatedAt: new Date() })
        .where(eq(siteSettings.id, existing.id))
        .run();
    }

    return getBranding(tx as unknown as Db);
  });
}

/* -------------------------------------------------------------------------- */
/* Upload validation                                                           */
/* -------------------------------------------------------------------------- */

export type AssetKind = 'logo' | 'favicon' | 'background';

const ASSET_COLUMNS = {
  logo: 'logoPath',
  favicon: 'faviconPath',
  background: 'backgroundImagePath',
} as const satisfies Record<AssetKind, keyof BrandingSettings>;

/** Detected image type. Only raster formats; SVG is deliberately absent. */
export type ImageType = 'png' | 'jpeg' | 'webp' | 'ico';

interface ImageSignature {
  type: ImageType;
  extension: string;
  mime: string;
  /** Declared MIME types accepted for this detected format. */
  acceptedMime: readonly string[];
  matches(bytes: Uint8Array): boolean;
}

const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  {
    type: 'png',
    extension: 'png',
    mime: 'image/png',
    acceptedMime: ['image/png'],
    // 89 50 4E 47 0D 0A 1A 0A
    matches: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    type: 'jpeg',
    extension: 'jpg',
    mime: 'image/jpeg',
    acceptedMime: ['image/jpeg'],
    // FF D8 FF
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'webp',
    extension: 'webp',
    mime: 'image/webp',
    acceptedMime: ['image/webp'],
    // RIFF....WEBP
    matches: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    type: 'ico',
    extension: 'ico',
    mime: 'image/x-icon',
    acceptedMime: ['image/x-icon', 'image/vnd.microsoft.icon'],
    // 00 00 01 00
    matches: (b) => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
  },
];

/** Per-kind policy: allowed formats and maximum size. */
const ASSET_POLICY: Record<AssetKind, { allowed: readonly ImageType[]; maxBytes: number }> = {
  // Logo: PNG / JPEG / WebP. SVG excluded (active same-origin content).
  logo: { allowed: ['png', 'jpeg', 'webp'], maxBytes: 2 * 1024 * 1024 },
  // Favicon: PNG / ICO only.
  favicon: { allowed: ['png', 'ico'], maxBytes: 512 * 1024 },
  background: { allowed: ['png', 'jpeg', 'webp'], maxBytes: 5 * 1024 * 1024 },
};

/** Exposed for tests and error messages. */
export const ASSET_LIMITS: Record<AssetKind, { maxBytes: number; formats: readonly ImageType[] }> = {
  logo: { maxBytes: ASSET_POLICY.logo.maxBytes, formats: ASSET_POLICY.logo.allowed },
  favicon: { maxBytes: ASSET_POLICY.favicon.maxBytes, formats: ASSET_POLICY.favicon.allowed },
  background: { maxBytes: ASSET_POLICY.background.maxBytes, formats: ASSET_POLICY.background.allowed },
};

/** Detect the actual image type from magic bytes. */
function detectImageType(bytes: Uint8Array): ImageSignature | null {
  return IMAGE_SIGNATURES.find((signature) => signature.matches(bytes)) ?? null;
}

export interface ValidatedAsset {
  type: ImageType;
  extension: string;
  mime: string;
  bytes: Uint8Array;
}

/**
 * Validate an uploaded file for the given asset kind.
 *
 * Requires **both** an allowed declared MIME type and a matching magic-byte
 * signature. A PNG declaring `image/png` whose bytes are HTML fails the signature
 * check; a real PNG declared `text/html` fails the declared-MIME check. The
 * original filename is never consulted, so it cannot influence validation or
 * storage.
 */
export async function validateAssetUpload(
  kind: AssetKind,
  file: { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<ValidatedAsset> {
  const policy = ASSET_POLICY[kind];

  if (file.size === 0) {
    throw new BrandingError('validation', 'file must not be empty');
  }

  // Size is checked before reading, but also verified against the real byte
  // length below, since a declared size is attacker-controlled.
  if (file.size > policy.maxBytes) {
    throw new BrandingError('validation', 'file is too large');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (bytes.byteLength === 0) {
    throw new BrandingError('validation', 'file must not be empty');
  }

  if (bytes.byteLength > policy.maxBytes) {
    throw new BrandingError('validation', 'file is too large');
  }

  const detected = detectImageType(bytes);

  if (detected === null) {
    throw new BrandingError('validation', 'unsupported image format');
  }

  if (!policy.allowed.includes(detected.type)) {
    throw new BrandingError('validation', `unsupported image format for ${kind}`);
  }

  // The declared MIME must agree with the detected format. Either half alone is
  // spoofable, so both must hold.
  if (!detected.acceptedMime.includes(file.type.toLowerCase())) {
    throw new BrandingError('validation', 'file type does not match its contents');
  }

  return { type: detected.type, extension: detected.extension, mime: detected.mime, bytes };
}

/* -------------------------------------------------------------------------- */
/* Filesystem storage                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the stored (database) public URL for a generated filename.
 *
 * An application URL, not a filesystem path. All brand asset paths are
 * instance-local references; logical JSON does not export them.
 */
export function brandAssetUrl(filename: string): string {
  return `${BRAND_ASSET_URL_PREFIX}${filename}`;
}

/** Generated filenames are `<uuid>.<ext>`; this is the only served shape. */
const GENERATED_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|ico)$/;

/**
 * Resolve a requested asset filename to an on-disk path, or `null` if the name is
 * not one this application generated.
 *
 * This is the traversal defence for the serving route: only the exact generated
 * shape is accepted, so `..`, `/`, absolute paths, and percent-encoded variants
 * are rejected by construction rather than by string stripping.
 */
export function resolveBrandAssetPath(filename: string, uploadsDir?: string): string | null {
  if (!GENERATED_FILENAME.test(filename)) {
    return null;
  }

  return join(brandingDir(uploadsDir), filename);
}

/**
 * Whether a stored brand asset path is one of our own assets.
 *
 * Removal only deletes a file when the stored value matches this pattern, so an
 * unexpected database string can never be turned into a deletion path.
 */
export function managedAssetFilename(publicPath: string | null): string | null {
  if (publicPath === null || !publicPath.startsWith(BRAND_ASSET_URL_PREFIX)) {
    return null;
  }

  const filename = publicPath.slice(BRAND_ASSET_URL_PREFIX.length);
  return GENERATED_FILENAME.test(filename) ? filename : null;
}

/** Best-effort removal of a previously managed file; never throws. */
function removeManagedFile(publicPath: string | null, uploadsDir?: string): void {
  const filename = managedAssetFilename(publicPath);

  if (filename === null) {
    return;
  }

  try {
    rmSync(join(brandingDir(uploadsDir), filename), { force: true });
  } catch {
    // An orphaned file is harmless; the site must not fail because of it.
  }
}

/**
 * Store a validated asset and point the effective settings row at it.
 *
 * Order matters and is the point of this function:
 *
 *  1. write the new uniquely-named file;
 *  2. update the database to the new public URL;
 *  3. only then remove the previous file, best-effort.
 *
 * If the database update throws, the newly written file is removed and the old
 * database value is left untouched — so the site never points at a missing asset.
 * A unique filename per upload also avoids stale caches and partial overwrites.
 */
export function storeBrandAsset(
  db: Db,
  kind: AssetKind,
  asset: ValidatedAsset,
  uploadsDir?: string,
): BrandingSettings {
  const directory = brandingDir(uploadsDir);
  mkdirSync(directory, { recursive: true });

  // Filename is entirely server-generated; the client's filename is discarded.
  const filename = `${randomUUID()}.${asset.extension}`;
  const target = join(directory, filename);

  const column = ASSET_COLUMNS[kind];
  const previous = getBranding(db)[column];
  writeFileSync(target, asset.bytes);

  let settings: BrandingSettings;
  try {
    settings = setAssetPath(db, column, brandAssetUrl(filename));
  } catch (error) {
    // Roll back the orphaned new file; the old DB value still stands.
    try {
      rmSync(target, { force: true });
    } catch {
      // Best-effort only.
    }
    throw error;
  }

  removeManagedFile(previous, uploadsDir);
  return settings;
}

/**
 * Detach and delete the current asset.
 *
 * The database is cleared first, so the active configuration never references a
 * file that has already been deleted. Deletion is best-effort and only ever
 * applies to a path matching our own generated-asset pattern.
 */
export function removeBrandAsset(db: Db, kind: AssetKind, uploadsDir?: string): BrandingSettings {
  const column = ASSET_COLUMNS[kind];
  const previous = getBranding(db)[column];

  const settings = setAssetPath(db, column, null);
  removeManagedFile(previous, uploadsDir);

  return settings;
}

/**
 * Read a stored asset's bytes for serving, or `null` when it is absent.
 *
 * Returns the file content only; the caller derives the response MIME type from
 * the generated extension. The bytes are read from disk rather than echoed from
 * the upload, so what is served is exactly what was validated and stored.
 */
export function readBrandAsset(
  filename: string,
  uploadsDir?: string,
): { bytes: Uint8Array<ArrayBuffer>; mime: string } | null {
  const path = resolveBrandAssetPath(filename, uploadsDir);

  if (path === null) {
    return null;
  }

  const extension = filename.slice(filename.lastIndexOf('.') + 1);
  const mime =
    extension === 'png'
      ? 'image/png'
      : extension === 'jpg'
        ? 'image/jpeg'
        : extension === 'webp'
          ? 'image/webp'
          : 'image/x-icon';

  try {
    const buffer = readFileSync(path);
    // Copy into a fresh ArrayBuffer-backed view so the type is a plain
    // `Uint8Array<ArrayBuffer>`, matching what the response body accepts.
    const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength));
    bytes.set(buffer);
    return { bytes, mime };
  } catch {
    return null;
  }
}
