/**
 * Minimal hash page state for navigation and management.
 *
 * One hash value selects the page without a routing dependency.
 * The hash exists only for lightweight back/refresh behavior; it is presentation
 * state and is never an authorization boundary — the server session decides what
 * a caller may see, and `resolveEffectivePage` guarantees a non-admin can never
 * render the Admin page even when the URL says `#admin`.
 */

export type Page = 'home' | 'admin' | 'settings';

/** Session-derived presentation permissions; APIs authorize independently. */
export interface PageAccess {
  isAuthenticated: boolean;
  isAdmin: boolean;
  isSessionPending: boolean;
}

/** The hash that selects the Admin page. */
export const ADMIN_HASH = '#admin';
export const SETTINGS_HASH = '#settings';

/** The hash written when navigating Home explicitly (keeps back/forward working). */
export const HOME_HASH = '#home';

/** Parse a location hash into a page. Empty and unrecognized hashes are Home. */
export function pageFromHash(hash: string): Page {
  if (hash === ADMIN_HASH) return 'admin';
  if (hash === SETTINGS_HASH) return 'settings';
  return 'home';
}

/** The hash to write when explicitly navigating to a page. */
export function hashFromPage(page: Page): string {
  if (page === 'admin') return ADMIN_HASH;
  if (page === 'settings') return SETTINGS_HASH;
  return HOME_HASH;
}

/** Subscription for `useSyncExternalStore`: hash changes trigger re-render. */
export function subscribeToHash(onStoreChange: () => void): () => void {
  window.addEventListener('hashchange', onStoreChange);
  return () => {
    window.removeEventListener('hashchange', onStoreChange);
  };
}

/** Snapshot for `useSyncExternalStore`: the current location hash. */
export function getHashSnapshot(): string {
  return window.location.hash;
}

/**
 * The page that may actually render.
 *
 * Pending sessions render no management page, including cached session data.
 * Settings needs a signed-in user; Admin additionally needs the admin role.
 */
export function resolveEffectivePage(page: Page, access: PageAccess): Page {
  if (access.isSessionPending || !access.isAuthenticated) return 'home';
  if (page === 'admin' && !access.isAdmin) return 'home';
  return page;
}
