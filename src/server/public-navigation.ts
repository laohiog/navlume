import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../db/schema.js';
import { publicCategories, publicLinks, siteSettings } from '../db/schema.js';

/** Site branding/access subset exposed to the public client. */
export interface PublicNavigationSite {
  id: number;
  siteName: string;
  tagline: string | null;
  logoPath: string | null;
  faviconPath: string | null;
  primaryColor: string | null;
  defaultTheme: 'light' | 'dark';
  footerText: string | null;
  accessMode: 'public' | 'login_required';
}

/** A visible public link as exposed to the public client. */
export interface PublicNavigationLink {
  id: number;
  title: string;
  url: string;
  description: string | null;
  iconUrl: string | null;
  sortOrder: number;
}

/** A visible public category with its visible links. */
export interface PublicNavigationCategory {
  id: number;
  name: string;
  icon: string | null;
  sortOrder: number;
  links: PublicNavigationLink[];
}

/** Response body of `GET /api/public/navigation`. */
export interface PublicNavigation {
  site: PublicNavigationSite | null;
  categories: PublicNavigationCategory[];
}

type Db = BetterSQLite3Database<typeof schema>;

/** Site access policy, or `null` when no site_settings row exists yet. */
export type SiteAccessMode = 'public' | 'login_required' | null;

/**
 * Read the configured access mode.
 *
 * A missing site_settings row means the site has not been configured yet, which
 * is treated as `public` so a fresh install still serves its empty state.
 * This is the single server-side source of truth for the access boundary.
 */
export function getSiteAccessMode(db: Db): SiteAccessMode {
  const row = db
    .select({ accessMode: siteSettings.accessMode })
    .from(siteSettings)
    .orderBy(asc(siteSettings.id))
    .limit(1)
    .get();

  return row?.accessMode ?? null;
}

/**
 * Read the public navigation payload.
 *
 * Uses three explicit queries (site, categories, links) and groups the links in
 * memory rather than issuing one query per category.
 *
 * Visibility: only `is_visible` categories and links are considered, so links
 * belonging to hidden categories are excluded as a side effect. Timestamps and
 * visibility flags are intentionally not exposed — every returned row is
 * already filtered to visible.
 *
 * Callers MUST enforce `access_mode` before calling this function; the route in
 * `app.ts` does so. `accessMode` is also returned verbatim for the client to
 * choose its UI, but that is presentation only, never authorization.
 */
export function getPublicNavigation(db: Db): PublicNavigation {
  const site = db.select().from(siteSettings).orderBy(asc(siteSettings.id)).limit(1).get();

  const categories = db
    .select()
    .from(publicCategories)
    .where(eq(publicCategories.isVisible, true))
    .orderBy(asc(publicCategories.sortOrder), asc(publicCategories.id))
    .all();

  const links = db
    .select()
    .from(publicLinks)
    .where(eq(publicLinks.isVisible, true))
    .orderBy(asc(publicLinks.sortOrder), asc(publicLinks.id))
    .all();

  const linksByCategory = new Map<number, PublicNavigationLink[]>();
  for (const link of links) {
    const bucket = linksByCategory.get(link.categoryId);
    const entry: PublicNavigationLink = {
      id: link.id,
      title: link.title,
      url: link.url,
      description: link.description,
      iconUrl: link.iconUrl,
      sortOrder: link.sortOrder,
    };

    if (bucket === undefined) {
      linksByCategory.set(link.categoryId, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  return {
    site:
      site === undefined
        ? null
        : {
            id: site.id,
            siteName: site.siteName,
            tagline: site.tagline,
            logoPath: site.logoPath,
            faviconPath: site.faviconPath,
            primaryColor: site.primaryColor,
            defaultTheme: site.defaultTheme,
            footerText: site.footerText,
            accessMode: site.accessMode,
          },
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      icon: category.icon,
      sortOrder: category.sortOrder,
      links: linksByCategory.get(category.id) ?? [],
    })),
  };
}
