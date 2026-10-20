/**
 * Branding snapshot comparison for the admin form's server-state sync.
 *
 * Split out of `AdminBranding.tsx` for two reasons: the component file must
 * only export components (the `react-refresh` lint rule), and the decision
 * below is the load-bearing boundary of T4.3.1 — it deserves to be driven
 * directly by tests instead of through a rendered page.
 */

import type { BrandingSettings } from './api/admin-branding.js';
import { homeThemeDraftFromConfig } from './admin-home-theme-draft.js';

/**
 * Everything an asset operation cannot change, as one comparable value.
 *
 * Uploading or removing a brand asset refetches branding exactly like a save
 * does, and the admin form's render-phase sync used to answer both
 * identically — overwriting every field. That silently discarded an unsaved
 * draft the moment an image was touched: measured before the fix, an edited
 * site name and colour reverted to the server values while the save bar went
 * on claiming "everything saved" (T4.3.1).
 *
 * `homeThemeConfig` is compared through `homeThemeDraftFromConfig` rather
 * than by reference: every fetch produces a fresh object, so an identity
 * check would call an unchanged theme "changed" and defeat the guard.
 */
function formStateSignature(settings: BrandingSettings): string {
  return JSON.stringify([
    settings.siteName,
    settings.tagline,
    settings.primaryColor,
    settings.pageBackgroundColor,
    settings.surfaceColor,
    settings.defaultTheme,
    settings.footerText,
    settings.accessMode,
    settings.homeThemeConfig?.presetId ?? null,
    homeThemeDraftFromConfig(settings.homeThemeConfig),
  ]);
}

/**
 * True when a server snapshot change was caused by a brand-asset operation.
 *
 * Both conditions are load-bearing (T4.3.1 review fix):
 *
 *  1. the non-asset fields are unchanged — otherwise the refetch carries real
 *     form data and the form must adopt it;
 *  2. an asset path actually changed — otherwise this was **not** an asset
 *     operation at all.
 *
 * The second condition exists because the server normalises what it stores:
 * text is trimmed and colours are canonicalised to upper case. Saving a draft
 * of ` 示例导航 ` therefore produces a snapshot whose name is `示例导航` —
 * byte-identical to the snapshot before the save. Without condition 2 that
 * pair looked "asset-only", the form kept the unnormalised draft, and the
 * save bar reported unsaved changes forever after a save that had succeeded
 * (measured: the input kept ` 示例导航 ` and `#285b47`). "Nothing but the
 * assets moved" is the question; "the assets moved" is half of it.
 *
 * `previous === null` means the form has never synced, so there is nothing to
 * protect yet and the form must adopt the payload.
 */
export function isAssetOnlySnapshotChange(
  previous: BrandingSettings | null,
  next: BrandingSettings,
): boolean {
  if (previous === null) {
    return false;
  }
  return formStateSignature(previous) === formStateSignature(next)
    && (previous.logoPath !== next.logoPath
      || previous.faviconPath !== next.faviconPath
      || previous.backgroundImagePath !== next.backgroundImagePath);
}
