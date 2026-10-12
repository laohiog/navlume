import { useCallback, useEffect, useState } from 'react';

import { hashFromPage, pageFromHash, resolveEffectivePage, type Page, type PageAccess } from './page-state.js';

/** The hash-derived page request plus the navigation action. */
export interface HashPageState {
  /** The page the URL currently requests (before the role gate is applied). */
  requestedPage: Page;
  /** Navigate to a page by writing its hash (fires `hashchange` → re-render). */
  navigate: (next: Page) => void;
}

/**
 * Derive the requested page from the URL hash.
 *
 * The hash is the single source of truth for the page request: manual hash
 * edits and browser back/forward are just hash changes, and navigating writes
 * the hash, so there is no second state to keep in sync. The hash is
 * presentation only — `resolveEffectivePage` (applied by the caller with the
 * session-derived role) guarantees a non-admin can never render the Admin page,
 * and the server remains the real authorization boundary.
 *
 * Unauthorized hashes are normalized only after the session resolves, so a
 * signed-in visitor refreshing a protected page keeps the requested page.
 */
export function useHashPage(options: PageAccess): HashPageState {
  const { isAuthenticated, isAdmin, isSessionPending } = options;

  const [requestedHash, setRequestedHash] = useState(() => window.location.hash);

  // Manual hash edits and back/forward land here; navigating (below) also goes
  // through the hash, so this listener is the single update path.
  useEffect(() => {
    const handleHashChange = () => {
      setRequestedHash(window.location.hash);
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  // Replace an unauthorized history entry rather than adding another entry.
  // Notify the same hash listener because replaceState emits no hashchange.
  useEffect(() => {
    const requestedPage = pageFromHash(requestedHash);

    if (isSessionPending || resolveEffectivePage(requestedPage, {
      isAuthenticated, isAdmin, isSessionPending,
    }) === requestedPage) {
      return;
    }

    if (window.location.hash === requestedHash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, [isAuthenticated, isAdmin, isSessionPending, requestedHash]);

  const navigate = useCallback((next: Page) => {
    const target = hashFromPage(next);

    if (window.location.hash !== target) {
      window.location.hash = target;
    }
    // Logout must leave management before awaiting its network round trip.
    setRequestedHash(target);
  }, []);

  return { requestedPage: pageFromHash(requestedHash), navigate };
}
