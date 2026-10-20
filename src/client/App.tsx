import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  createPersonalCategory,
  createPersonalLink,
  deletePersonalCategory,
  deletePersonalLink,
  fetchPersonalNavigation,
  reorderPersonalCategories,
  reorderPersonalLinks,
  updatePersonalCategory,
  updatePersonalLink,
  type PersonalMutationOutcome,
  type PersonalNavigation,
  type PersonalNavigationResult,
} from './api/personal-navigation.js';
import { authClient } from './api/auth-client.js';
import { fetchPublicNavigation, type PublicNavigationSite } from './api/public-navigation.js';
import { mutationErrorMessage } from './personal-error.js';
import { countMatchingLinks, normalizeSearchQuery } from './navigation-search.js';
import { isEditableTarget } from './quick-add.js';
import {
  createAdminPublicCategory,
  createAdminPublicLink,
  deleteAdminPublicCategory,
  deleteAdminPublicLink,
  fetchAdminPublicNavigation,
  reorderAdminPublicCategories,
  reorderAdminPublicLinks,
  updateAdminPublicCategory,
  updateAdminPublicLink,
  type AdminMutationOutcome,
  type AdminPublicNavigation,
  type AdminNavigationResult,
} from './api/admin-public-navigation.js';
import {
  AdminPublicNavigationView,
  type AdminPublicNavigationActions,
  type AdminPublicNavigationState,
} from './AdminPublicNavigation.js';
import {
  FALLBACK_BRANDING,
  fetchAdminBranding,
  fetchPublicBranding,
  removeBrandFavicon,
  removeBrandLogo,
  removeBrandBackground,
  updateAdminBranding,
  uploadBrandFavicon,
  uploadBrandLogo,
  uploadBrandBackground,
  type AdminBrandingResult,
  type BrandingMutationOutcome,
  type PublicBranding,
} from './api/admin-branding.js';
import {
  BRANDING_THEME_PROPERTIES,
  HOME_THEME_COLOR_VARIABLE_NAMES,
  HOME_THEME_GATE_NAMES,
  brandingThemeProperties,
  homeThemeOverrideGates,
  homeThemeOverrides,
} from './branding-theme.js';
import { HOME_THEME_BASIS_ATTRIBUTE, HOME_THEME_PRESET_ATTRIBUTE } from './home-theme-presets.js';
import {
  AdminBrandingView,
  type AdminBrandingActions,
  type UnsavedChangesGuard,
  type AdminBrandingState,
} from './AdminBranding.js';
import {
  createAdminUser,
  deleteAdminUser,
  disableAdminUser,
  enableAdminUser,
  fetchAdminUsers,
  resetAdminUserPassword,
  ADMIN_USERS_PAGE_SIZE,
  type AdminUserMutationOutcome,
} from './api/admin-users.js';
import {
  AdminUsersView,
  type AdminUsersActions,
  type AdminUsersState,
} from './AdminUsers.js';
import {
  DataPortabilityView,
  type PortabilityPanelActions,
  type PortabilityResult,
  type PortabilitySummary,
} from './DataPortability.js';
import {
  applyPersonalImport,
  applySiteImport,
  downloadDocument,
  exportFilename,
  exportSiteDocument,
  previewPersonalImport,
  previewSiteImport,
  saveJsonFile,
  PERSONAL_EXPORT_ENDPOINT,
  type PortableDocument,
} from './api/data-portability.js';
import { planCategoryReorder, planLinkReorder } from './personal-reorder.js';
import { planLinkMove, type LinkMoveOutcome } from './link-reorder.js';
import { captureGeneration, isCurrentGeneration } from './portability-flow.js';
import {
  PersonalNavigationView,
  type PersonalNavigationActions,
  type PersonalNavigationState,
} from './PersonalNavigation.js';
import {
  BrandHeader,
  PublicNavigationView,
  SessionBar,
  type PublicNavigationState,
  type SessionSummary,
} from './PublicNavigation.js';
import { AdminManagementView } from './AdminManagement.js';
import { PersonalSettingsView } from './PersonalSettings.js';
import { FooterContent } from './FooterContent.js';
import { pageFromHash, resolveEffectivePage } from './page-state.js';
import { useHashPage } from './use-hash-page.js';

/** Generic credential failure text. Never distinguishes username from password. */
const GENERIC_LOGIN_ERROR = '用户名或密码错误';
const RATE_LIMIT_MESSAGE = '尝试次数过多，请稍后再试';

/** Public reads retain their access policy and the server session that fetched them. */
interface PublicFetch {
  sessionKey: string | null;
  accessMode: PublicNavigationSite['accessMode'] | null;
  state: PublicNavigationState;
}

interface AdminUsersFetch {
  sessionKey: string;
  page: number;
  total: number | null;
  state: AdminUsersState;
}

/** A personal read result together with the identity that produced it. */
interface PersonalFetch {
  sessionKey: string;
  result: PersonalNavigationResult;
}

/** A mutation failure together with the identity it was reported for. */
interface PersonalMutationError {
  sessionKey: string;
  message: string;
}

/**
 * Public homepage container.
 *
 * Owns:
 *  1. fetching public navigation (the server enforces `access_mode`);
 *  2. fetching personal navigation for the authenticated user;
 *  3. Better Auth session state;
 *  4. login / logout actions and their effect on both payloads.
 *
 * ## Why public and personal are separate
 *
 * They have independent states, so a personal failure never replaces the public
 * page with an error. Each has its own abort controller and its own reload token.
 *
 * ## Session-change safety without stale data
 *
 * Personal data is the sensitive case: it must never outlive the session that
 * fetched it. Rather than imperatively clearing state, every personal payload is
 * stored *tagged with the identity that produced it*, and the render state is
 * derived from that tag:
 *
 *  - `personalFetch.sessionKey` must equal the current `personalSessionKey` to be
 *    used at all. A payload from a previous user is therefore unreadable, not
 *    merely overwritten — and a logout needs no imperative clearing, because
 *    `sessionUserId === null` derives `absent` in the same render as the identity
 *    change.
 *  - The fetch effect's cleanup sets `active = false` and aborts, so a response
 *    from a superseded session cannot be applied. This closes the
 *    "A logs out, B logs in, A's response arrives late" window.
 *  - Mutation errors are tagged the same way, so a late failure from a previous
 *    identity is never shown to the new one.
 *
 * No global state library is used. A window `focus` listener re-reads personal
 * navigation, which is how a second device reflects changes made elsewhere. There
 * is no polling, interval, websocket, or client-side sync engine: the server
 * database is the source of truth and this component only re-reads it.
 */
export function App({ initialLogin = false }: { initialLogin?: boolean } = {}) {
  const [publicFetch, setPublicFetch] = useState<PublicFetch>({
    sessionKey: null, accessMode: null, state: { status: 'loading' },
  });
  const publicNavigationEpochRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [personalFetch, setPersonalFetch] = useState<PersonalFetch | null>(null);
  const [personalReloadToken, setPersonalReloadToken] = useState(0);
  const [isPersonalMutating, setIsPersonalMutating] = useState(false);
  const linkMoveBusyRef = useRef({ personal: false, admin: false });
  const [personalMutationError, setPersonalMutationError] =
    useState<PersonalMutationError | null>(null);
  const [isLoginVisible, setIsLoginVisible] = useState(initialLogin);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  /**
   * Admin public-navigation state (P5.1).
   *
   * `adminNavigation` holds the server's admin read payload plus the identity key
   * that produced it, exactly like the personal payload, so a logout or account
   * switch cannot leave another session's admin data on screen.
   */
  const [adminNavigation, setAdminNavigation] = useState<AdminNavigationResult | null>(null);
  const [adminReloadToken, setAdminReloadToken] = useState(0);
  const [isAdminMutating, setIsAdminMutating] = useState(false);
  const [adminMutationError, setAdminMutationError] = useState<string | null>(null);

  /**
   * Public branding, deliberately independent of navigation.
   *
   * Loaded separately so a branding failure cannot break navigation and vice
   * versa. It is unauthenticated, which is what keeps the `login_required` login
   * screen branded even though navigation is protected.
   */
  const [publicBranding, setPublicBranding] = useState<PublicBranding>(FALLBACK_BRANDING);
  const [publicBrandingToken, setPublicBrandingToken] = useState(0);

  /** Admin branding settings (admin only). */
  const [adminBranding, setAdminBranding] = useState<AdminBrandingResult | null>(null);
  const [adminBrandingToken, setAdminBrandingToken] = useState(0);
  const [isBrandingMutating, setIsBrandingMutating] = useState(false);
  const [brandingMutationError, setBrandingMutationError] = useState<string | null>(null);
  /*
   * Guard registered by the branding view while it holds unsaved changes.
   *
   * Kept in a ref so the admin page can call it without depending on identity,
   * and so registering it does not re-render the surrounding page. It is the one
   * channel between "a module owns a draft" and "the page that unmounts it" —
   * the alternative, hoisting the draft itself into App, would move colour state
   * well away from the form that owns it.
   */
  const brandingUnsavedGuardRef = useRef<UnsavedChangesGuard | null>(null);
  const setBrandingUnsavedGuard = useCallback((guard: UnsavedChangesGuard | null) => {
    brandingUnsavedGuardRef.current = guard;
  }, []);

  /**
   * Protected Admin user-management state (P5.3).
   *
   * Holds the server's user list plus the identical protected-state discipline used
   * for personal and branding data: cleared synchronously on logout, and guarded by
   * an epoch so a request that began before logout cannot repopulate the list,
   * error, or busy flag afterwards.
   */
  const [adminUsers, setAdminUsers] = useState<AdminUsersFetch | null>(null);
  const [adminUsersToken, setAdminUsersToken] = useState(0);
  const [adminUsersPage, setAdminUsersPage] = useState<{ sessionKey: string | null; page: number }>({ sessionKey: null, page: 0 });
  const [adminUsersMutation, setAdminUsersMutation] = useState<{
    sessionKey: string; isMutating: boolean; error: string | null;
  } | null>(null);
  const adminUsersEpochRef = useRef(0);

  /**
   * Invalidate in-flight protected user-management work and clear its state.
   *
   * Called when logout begins and when the identity changes, before any await, so a
   * stale completion cannot land under a new session. Mirrors the branding guard
   * rather than introducing a shared request registry.
   */
  const invalidateAdminUsers = useCallback(() => {
    adminUsersEpochRef.current += 1;
    setAdminUsers(null);
    setAdminUsersPage({ sessionKey: null, page: 0 });
    setAdminUsersMutation(null);
  }, []);

  /**
   * Monotonic epoch guarding **every** in-flight JSON data-portability request (P6.1).
   *
   * Portability holds no background-loaded payload, so there is no protected form
   * state to clear on logout. The epoch exists because three client continuations
   * must not outlive the identity that started them:
   *
   *  - saving an exported file,
   *  - rendering a preview (summary, error, re-armed confirmation), and
   *  - rendering apply success/failure or triggering a post-import refetch.
   *
   * It is advanced synchronously at logout start, before any `await`, so a request
   * that began under the old identity is detectable the instant it completes —
   * even while Better Auth still caches the prior session identity.
   *
   * Only ever incremented, never reset: a later login captures the current value and
   * its work is accepted normally.
   */
  const portabilityEpochRef = useRef(0);

  /**
   * Portability subtree key.
   *
   * Changing this key remounts `DataPortabilityView`, discarding its local state
   * (pasted/selected JSON, parsed document, preview summary, confirmation, error,
   * notice, and busy flag) in the same render pass. It is advanced synchronously
   * at logout start so that state cannot remain usable during the sign-out round
   * trip, and it also covers an account switch. A later login gets a fresh key and
   * therefore a fresh panel.
   */
  const [portabilitySessionKey, setPortabilitySessionKey] = useState(0);

  /**
   * Monotonic epoch guarding all **protected Admin Branding** async work.
   *
   * Logout increments this before any await, which synchronously invalidates every
   * Admin Branding read/mutation that began under an older epoch: their completions
   * are discarded rather than repopulating `adminBranding` (or its error and busy
   * flags) while the session is being torn down.
   *
   * The immediate epoch also guards work before the pending-page render and
   * effect cleanup run, and guards mutations independently of read effects.
   *
   * Only ever incremented, never reset — a later Admin login captures the current
   * value and its work is accepted normally.
   */
  const adminBrandingEpochRef = useRef(0);

  /**
   * Invalidate in-flight protected Admin Branding work and clear its state.
   *
   * Called when logout begins and when the identity changes, both before any
   * await, so a stale completion can never land under a new session.
   */
  const invalidateAdminBranding = useCallback(() => {
    adminBrandingEpochRef.current += 1;
    setAdminBranding(null);
    setBrandingMutationError(null);
    setIsBrandingMutating(false);
  }, []);


  const { data: sessionData, isPending: isSessionPending, refetch: refetchSession } =
    authClient.useSession();

  const sessionUserId = sessionData?.user?.id ?? null;
  const isAuthenticated = !isSigningOut && sessionUserId !== null;
  const publicSessionKey = isAuthenticated ? sessionData?.session?.id ?? null : null;

  // Invalidate before passive effect cleanup, including a session change from another tab.
  useLayoutEffect(() => {
    publicNavigationEpochRef.current += 1;
  }, [publicSessionKey, isSessionPending]);

  // Protected data never renders under a missing or different session. Public-mode
  // data remains usable across identity changes, including the logout round trip.
  const state: PublicNavigationState =
    publicFetch.accessMode === 'login_required'
      ? !isAuthenticated
        ? { status: 'unauthenticated' }
        : isSessionPending || !isAuthenticated || publicFetch.sessionKey !== publicSessionKey
          ? { status: 'loading' }
          : publicFetch.state
      : publicFetch.state;

  /**
   * Whether to offer the admin surface at all.
   *
   * Read from the session for **presentation only** — it decides whether the
   * management entry is rendered, never whether an admin request is allowed.
   * Every `/api/admin/*` route re-derives the role from the session server-side,
   * so a spoofed client value cannot grant access.
   */
  const isAdmin = isAuthenticated && (sessionData?.user as { role?: string | null } | undefined)?.role === 'admin';
  const adminUsersSessionKey = isAdmin && !isSessionPending ? sessionData?.session?.id ?? null : null;
  const usersPage = adminUsersPage.sessionKey === adminUsersSessionKey ? adminUsersPage.page : 0;
  const isUsersMutating = adminUsersMutation?.sessionKey === adminUsersSessionKey && adminUsersMutation.isMutating;
  const usersMutationError = adminUsersMutation?.sessionKey === adminUsersSessionKey ? adminUsersMutation.error : null;
  const usersTotal = adminUsers?.sessionKey === adminUsersSessionKey ? adminUsers.total : null;

  useLayoutEffect(() => {
    adminUsersEpochRef.current += 1;
  }, [adminUsersSessionKey]);

  const changeUsersPage = useCallback((page: number) => {
    if (adminUsersSessionKey === null || isUsersMutating || !Number.isInteger(page) || page < 0 ||
      (usersTotal !== null && page > Math.max(0, Math.ceil(usersTotal / ADMIN_USERS_PAGE_SIZE) - 1))) return;
    adminUsersEpochRef.current += 1;
    setAdminUsersPage({ sessionKey: adminUsersSessionKey, page });
    setAdminUsersMutation(null);
  }, [adminUsersSessionKey, isUsersMutating, usersTotal]);
  const personalSessionKey = sessionUserId ?? 'guest';

  // Reuse the portability epoch for identity changes that happen without this
  // tab's logout action (e.g. another tab switches accounts). Layout timing
  // invalidates continuations before the new identity's UI can be used.
  useLayoutEffect(() => {
    portabilityEpochRef.current += 1;
    if (linkMoveBusyRef.current.personal) setIsPersonalMutating(false);
    if (linkMoveBusyRef.current.admin) setIsAdminMutating(false);
  }, [sessionUserId]);

  /**
   * UX-IA page state (see `useHashPage`): the URL hash is the single source of
   * truth for the requested page; the role gate below decides what may render.
   */
  const pageAccess = { isAuthenticated, isAdmin, isSessionPending: isSessionPending || isSigningOut };
  const { requestedPage, navigate } = useHashPage(pageAccess);

  /**
   * The page that may actually render.
   *
   * A non-admin can never resolve to the Admin page, no matter what the hash
   * says — the session-derived role is the client-side gate, and the server
   * remains the real authorization boundary.
   */
  const effectivePage = resolveEffectivePage(requestedPage, pageAccess);
  const adminPageActive = effectivePage === 'admin';
  const homePageActive = effectivePage === 'home';

  /**
   * Render state for the personal section, derived rather than stored.
   *
   * `absent` for a guest; `loading` until a payload tagged with the current
   * identity exists; otherwise the tagged read outcome. Only ever a function of
   * the current identity, so no previous user's data can be rendered.
   */
  const personalState: PersonalNavigationState =
    sessionUserId === null
      ? { status: 'absent' }
      : personalFetch === null || personalFetch.sessionKey !== personalSessionKey
        ? { status: 'loading' }
        : personalFetch.result.status === 'ok'
          ? { status: 'ready', data: personalFetch.result.data }
          : personalFetch.result.status === 'unauthenticated'
            ? { status: 'absent' }
            : { status: 'error' };

  /** Mutation failure text, shown only when it belongs to the current identity. */
  const personalError =
    personalMutationError !== null && personalMutationError.sessionKey === personalSessionKey
      ? personalMutationError.message
      : null;

  useEffect(() => {
    if (isSigningOut) return;

    const controller = new AbortController();
    let active = true;
    const epoch = publicNavigationEpochRef.current;
    const isCurrent = () => active && epoch === publicNavigationEpochRef.current;

    fetchPublicNavigation(controller.signal)
      .then((result) => {
        if (!isCurrent()) return;

        setPublicFetch((current) => ({
          sessionKey: publicSessionKey,
          accessMode: result.status === 'ok'
            ? result.data.site?.accessMode ?? 'public'
            : result.status === 'unauthenticated' ? 'login_required' : current.accessMode,
          state: result.status === 'ok'
            ? { status: 'ready', data: result.data }
            : { status: result.status === 'unauthenticated' ? 'unauthenticated' : 'error' },
        }));
      })
      .catch(() => {
        if (isCurrent()) {
          setPublicFetch((current) => ({ ...current, sessionKey: publicSessionKey, state: { status: 'error' } }));
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadToken, publicSessionKey, isSessionPending, isSigningOut]);

  // Personal navigation: never requested for a guest.
  useEffect(() => {
    if (sessionUserId === null) {
      return () => {};
    }

    const controller = new AbortController();
    let active = true;
    const requestKey = sessionUserId;

    fetchPersonalNavigation(controller.signal)
      .then((result) => {
        // Cleanup clears `active` on every identity or token change, so a result
        // from a superseded session is never stored.
        if (active) {
          setPersonalFetch({ sessionKey: requestKey, result });
        }
      })
      .catch(() => {
        if (active) {
          setPersonalFetch({ sessionKey: requestKey, result: { status: 'error' } });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionUserId, personalReloadToken]);

  // Focus refresh: re-read server state when the window regains focus.
  useEffect(() => {
    if (!isAuthenticated) {
      return () => {};
    }

    const handleFocus = () => {
      setPersonalReloadToken((token) => token + 1);
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [isAuthenticated]);

  /**
   * `/` focuses the existing search field.
   *
   * A convenience, never the only way in — the field stays visible and usable.
   * It is ignored while typing (`isEditableTarget` keeps `/` a literal character
   * in any input, textarea or contenteditable), while a modal is open, and during
   * IME composition, where `/` belongs to the input method rather than the page.
   *
   * `Ctrl/⌘+K` rides the same path but cannot be promised: a browser that
   * reserves the combination never delivers the event, and this handler simply
   * never runs. `/` is the shortcut that is actually guaranteed.
   */
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) {
        return;
      }

      const isSlash = event.key === '/';
      const isCommandK = (event.ctrlKey || event.metaKey) && !event.altKey
        && event.key.toLowerCase() === 'k';

      if (!isSlash && !isCommandK) {
        return;
      }

      // A modified `/` belongs to the browser or the OS, not to this page.
      if (isSlash && (event.ctrlKey || event.metaKey || event.altKey)) {
        return;
      }

      if (isEditableTarget(event.target) || document.querySelector('dialog[open]') !== null) {
        return;
      }

      const input = document.querySelector<HTMLInputElement>('input.search__input');
      if (input === null || input.disabled || input.getClientRects().length === 0) {
        return;
      }

      event.preventDefault();
      input.focus();
    };

    window.addEventListener('keydown', handleShortcut);
    return () => {
      window.removeEventListener('keydown', handleShortcut);
    };
  }, []);

  // Admin public-navigation state: only ever requested for an admin session.
  useEffect(() => {
    if (!isAdmin) {
      return () => {};
    }

    const controller = new AbortController();
    let active = true;

    fetchAdminPublicNavigation(controller.signal)
      .then((result) => {
        // Cleanup clears `active` on identity/token change, so a superseded
        // session's result can never be stored.
        if (active) {
          setAdminNavigation(result);
        }
      })
      .catch(() => {
        if (active) {
          setAdminNavigation({ status: 'error' });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [isAdmin, adminReloadToken]);

  // Public branding: independent of navigation and of the access boundary.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    fetchPublicBranding(controller.signal)
      .then((result) => {
        if (!active) {
          return;
        }

        // A branding failure keeps the safe fallback rather than clearing the
        // page; navigation is unaffected either way.
        setPublicBranding(result.status === 'ok' ? result.data : FALLBACK_BRANDING);
      })
      .catch(() => {
        if (active) {
          setPublicBranding(FALLBACK_BRANDING);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [publicBrandingToken]);

  /**
   * Apply branding to the document and to the CSS custom properties.
   *
   * - `data-theme` drives both themes through one stylesheet;
   * - `--brand-primary` receives only a server-validated `#RRGGBB` literal, so it
   *   can never carry CSS;
   * - the managed `<link rel="icon">` is created/updated/removed by this effect
   *   alone, so unrelated `<link>` elements are never touched.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset['theme'] = publicBranding.defaultTheme;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) themeColor.content = publicBranding.pageBackgroundColor ??
      (publicBranding.defaultTheme === 'dark' ? '#161c25' : '#f5f7fa');

    const properties = brandingThemeProperties(publicBranding, homePageActive);
    for (const name of BRANDING_THEME_PROPERTIES) {
      const value = properties[name];
      if (value === undefined) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }

    /*
     * Home-page colour overrides.
     *
     * Applied to `.app--home` rather than the root element on purpose: the
     * defaults for these properties are declared on `.app--home` itself, so
     * writing them anywhere else would be shadowed by that declaration. The
     * effect also flips `data-home-overrides`, which is what lets the stylesheet
     * escalate specificity past the `:root[data-brand-colors='true']` brand
     * rules without relying on declaration order alone.
     *
     * **Only while the real home page is the active view (T4.3.1).** The admin
     * branding page mounts its own `.app--home` — the draft preview — and owns
     * that element's values, and the root's gates, itself (see
     * `AdminBrandingView`'s gate effect). Writing the *saved* values here on
     * every refetch reached straight through to the preview: measured,
     * uploading a favicon flipped the preview's gate to the saved `false` and
     * stripped its inline draft colour, so the miniature stopped showing a
     * draft the form was still holding. Two owners for one element is the
     * defect — the app manages the real page, the preview manages itself, and
     * the two are never mounted at the same time.
     */
    if (homePageActive) {
      const homeOverrides = homeThemeOverrides(publicBranding.homeThemeConfig);
      for (const name of HOME_THEME_COLOR_VARIABLE_NAMES) {
        root.style.removeProperty(name);
      }
      // Per-slot gates, cleared before being re-set. A single shared flag would
      // switch on every rule together and re-declare untouched slots with their
      // defaults, which is exactly the partial-override regression T1.1 fixes.
      for (const gate of HOME_THEME_GATE_NAMES) {
        root.dataset[gate] = 'false';
      }
      for (const gate of homeThemeOverrideGates(homeOverrides)) {
        root.dataset[gate] = 'true';
      }
      /*
       * Theme preset shape.
       *
       * Written onto each `.app--home` element, not onto `<html>`.
       *
       * T3 mirrored it on the root so the shape would survive navigation without
       * per-mount bookkeeping. T3.1 showed that is exactly what makes an unsaved
       * draft unpreviewable: `<html data-theme>` is the *saved* basis, so its
       * dark-variant rule outranked anything the preview could declare, and the
       * miniature showed light shadows over dark colours. Gating on the element
       * that is actually styled removes the conflict — and the effect already
       * re-runs on navigation (`homePageActive` is in its dependency list) and
       * already writes the seven `--home-*` values the same way, so this adds no
       * new lifecycle to keep in sync.
       *
       * Removed rather than blanked when no preset is stored: an older site with
       * no `presetId` must keep rendering exactly as it did before T3.
       */
      const presetId = publicBranding.homeThemeConfig?.presetId;
      const basis = publicBranding.defaultTheme === 'dark' ? 'dark' : 'light';
      for (const home of Array.from(document.querySelectorAll<HTMLElement>('.app--home'))) {
        for (const name of HOME_THEME_COLOR_VARIABLE_NAMES) {
          home.style.removeProperty(name);
        }
        for (const [name, value] of Object.entries(homeOverrides)) {
          home.style.setProperty(name, value);
        }
        if (presetId === undefined) {
          home.removeAttribute(HOME_THEME_PRESET_ATTRIBUTE);
        } else {
          home.setAttribute(HOME_THEME_PRESET_ATTRIBUTE, presetId);
        }
        home.setAttribute(HOME_THEME_BASIS_ATTRIBUTE, basis);
      }
    }

    root.dataset['brandColors'] = String(publicBranding.primaryColor !== null || publicBranding.pageBackgroundColor !== null || publicBranding.surfaceColor !== null);
    root.dataset['brandImage'] = String(homePageActive && properties['--brand-background-image'] !== undefined);

    document.title = publicBranding.siteName;

    const MANAGED_ATTRIBUTE = 'data-app-managed-brand-icon';
    const existing = document.head.querySelector<HTMLLinkElement>(
      `link[${MANAGED_ATTRIBUTE}]`,
    );

    if (publicBranding.faviconPath === null) {
      if (existing !== null) {
        existing.remove();
      }
      return;
    }

    if (existing === null) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.setAttribute(MANAGED_ATTRIBUTE, '');
      link.href = publicBranding.faviconPath;
      document.head.append(link);
      return;
    }

    existing.href = publicBranding.faviconPath;
  }, [publicBranding, homePageActive]);

  // Admin branding settings: only ever requested for an admin session.
  useEffect(() => {
    if (!isAdmin) {
      return () => {};
    }

    const controller = new AbortController();
    let active = true;
    // Capture the epoch this request belongs to. If logout (or an identity
    // change) advances it while this request is in flight, the result is stale
    // and must not touch protected state, regardless of effect cleanup timing.
    const epoch = adminBrandingEpochRef.current;

    const isCurrent = () => active && epoch === adminBrandingEpochRef.current;

    fetchAdminBranding(controller.signal)
      .then((result) => {
        if (isCurrent()) {
          setAdminBranding(result);
        }
      })
      .catch(() => {
        if (isCurrent()) {
          setAdminBranding({ status: 'error' });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [isAdmin, adminBrandingToken]);

  // Admin user management: only ever requested for an admin session.
  useEffect(() => {
    if (adminUsersSessionKey === null) {
      return () => {};
    }

    const controller = new AbortController();
    let active = true;
    // Same immediate epoch guard as branding, independent of effect cleanup.
    const epoch = adminUsersEpochRef.current;
    const isCurrent = () => active && epoch === adminUsersEpochRef.current;

    fetchAdminUsers(usersPage * ADMIN_USERS_PAGE_SIZE, controller.signal)
      .then((result) => {
        if (!isCurrent()) return;
        if (result.status === 'ok') {
          const lastPage = Math.max(0, Math.ceil(result.data.total / ADMIN_USERS_PAGE_SIZE) - 1);
          if (usersPage > lastPage) {
            adminUsersEpochRef.current += 1;
            setAdminUsersPage({ sessionKey: adminUsersSessionKey, page: lastPage });
            setAdminUsersMutation(null);
            return;
          }
        }
        setAdminUsers((previous) => ({
          sessionKey: adminUsersSessionKey, page: usersPage,
          total: result.status === 'ok' ? result.data.total
            : result.status === 'error' && previous?.sessionKey === adminUsersSessionKey ? previous.total : null,
          state: result.status === 'ok' ? { status: 'ready', users: result.data.users }
            : { status: result.status === 'error' ? 'error' : 'absent' },
        }));
        if (result.status === 'unauthenticated' || result.status === 'forbidden') void refetchSession();
      })
      .catch(() => {
        if (isCurrent()) {
          setAdminUsers((previous) => ({
            sessionKey: adminUsersSessionKey, page: usersPage,
            total: previous?.sessionKey === adminUsersSessionKey ? previous.total : null,
            state: { status: 'error' },
          }));
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [adminUsersSessionKey, usersPage, adminUsersToken, refetchSession]);

  const reloadNavigation = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const reloadPersonal = useCallback(() => {
    setPersonalReloadToken((token) => token + 1);
  }, []);

  const reloadAdmin = useCallback(() => {
    setAdminReloadToken((token) => token + 1);
  }, []);

  const reloadAdminBranding = useCallback(() => {
    setAdminBrandingToken((token) => token + 1);
  }, []);

  const reloadAdminUsers = useCallback(() => {
    adminUsersEpochRef.current += 1;
    setAdminUsersToken((token) => token + 1);
  }, []);

  /**
   * Run one user-management mutation, then refetch the authoritative user list.
   *
   * Captures the epoch before awaiting, so a logout that happens mid-request is
   * detectable on completion: nothing may refetch or restore protected state that
   * logout deliberately cleared.
   */
  /** Non-technical text for a user-management failure. Raw Better Auth errors are never surfaced. */
  const adminUserFailureMessage = (outcome: AdminUserMutationOutcome): string => {
    switch (outcome.status) {
      case 'invalid':
        return '操作失败，请检查输入（用户名或邮箱可能已被占用）。';
      case 'forbidden':
        return '没有管理权限。';
      case 'unauthenticated':
        return '登录状态已失效，请重新登录。';
      case 'notfound':
        return '该用户已不存在，请刷新后重试。';
      default:
        return '操作失败，请稍后重试。';
    }
  };

  const runUsersMutation = useCallback(
    async (mutate: () => Promise<AdminUserMutationOutcome>): Promise<AdminUserMutationOutcome> => {
      if (adminUsersSessionKey === null) return { status: 'unauthenticated' };
      const epoch = adminUsersEpochRef.current;

      setAdminUsersMutation({ sessionKey: adminUsersSessionKey, isMutating: true, error: null });

      let outcome: AdminUserMutationOutcome;

      try {
        outcome = await mutate();
      } catch {
        outcome = { status: 'error' };
      }

      // Identity changed mid-flight: logout has already invalidated this epoch and
      // cleared the state, so skip every protected continuation.
      if (epoch !== adminUsersEpochRef.current) {
        return outcome;
      }

      if (outcome.status === 'ok') {
        reloadAdminUsers();
      } else if (outcome.status === 'unauthenticated' || outcome.status === 'forbidden') {
        setAdminUsers({ sessionKey: adminUsersSessionKey, page: usersPage, total: null, state: { status: 'absent' } });
        await refetchSession();
      }

      setAdminUsersMutation({
        sessionKey: adminUsersSessionKey, isMutating: false,
        error: outcome.status === 'ok' ? null : adminUserFailureMessage(outcome),
      });
      return outcome;
    },
    [reloadAdminUsers, refetchSession, adminUsersSessionKey, usersPage],
  );

  /**
   * Refetch every branding-dependent surface.
   *
   * Public branding drives the header/theme/favicon, and a change to `accessMode`
   * can change whether navigation is available to a guest — so navigation is
   * refetched too when settings are saved.
   */
  const reloadBranding = useCallback((includeNavigation: boolean) => {
    setPublicBrandingToken((token) => token + 1);
    reloadAdminBranding();

    if (includeNavigation) {
      reloadNavigation();
    }
  }, [reloadAdminBranding, reloadNavigation]);

  const handleLogin = useCallback(
    async (credentials: { username: string; password: string }) => {
      setIsSubmitting(true);
      setLoginError(null);

      try {
        const result = await authClient.signIn.username({
          username: credentials.username,
          password: credentials.password,
        });

        if (result.error !== null && result.error !== undefined) {
          // Rate limiting is surfaced with its own generic message; everything
          // else uses one indistinguishable credential error.
          setLoginError(result.error.status === 429 ? RATE_LIMIT_MESSAGE : GENERIC_LOGIN_ERROR);
          return;
        }

        // Drop the previous identity's payload and error before the new session
        // is read; the tag check would ignore them anyway, but this keeps the
        // cache from holding another user's data.
        setPersonalFetch(null);
        setPersonalMutationError(null);

        // The server has set the session cookie. Refresh session state so the
        // header updates, then re-request both navigations for the new session.
        await refetchSession();
        setIsLoginVisible(false);
        reloadNavigation();
        reloadPersonal();
      } catch {
        setLoginError(GENERIC_LOGIN_ERROR);
      } finally {
        setIsSubmitting(false);
      }
    },
    [reloadNavigation, reloadPersonal, refetchSession],
  );

  const handleLogout = useCallback(async () => {
    // Abort is best-effort: block old public reads before the sign-out await.
    publicNavigationEpochRef.current += 1;
    // Better Auth retains the last session until sign-out/refetch completes.
    // Treat this transition as pending so Back or manual hashes cannot reopen
    // management while that cached session still identifies the old user.
    setIsSigningOut(true);
    if (pageFromHash(window.location.hash) !== 'home') {
      navigate('home');
    }

    // Remove protected data and any pending error before the network round trip.
    // `sessionUserId` becoming null would already derive `absent`, but clearing
    // here means nothing survives if the session refetch is slow.
    setPersonalFetch(null);
    setPersonalMutationError(null);
    setIsPersonalMutating(false);
    // Admin state is protected too, and `isAdmin` is derived from the session —
    // clearing it explicitly keeps the discipline uniform so no admin payload can
    // survive a slow session refetch.
    setAdminNavigation(null);
    setAdminMutationError(null);
    setIsAdminMutating(false);
    // Clear Admin Branding while Better Auth still caches the prior identity.
    //
    // This also advances the Admin Branding epoch, which discards any read or
    // mutation that started before logout and would otherwise complete later and
    // repopulate the protected state this call just cleared.
    invalidateAdminBranding();
    // User management is protected state too, with the same stale-async risk.
    invalidateAdminUsers();
    // Data portability: advance the generation so no export, preview, or apply
    // that began before logout can save a file, render into the old panel, or
    // trigger a protected refetch. Done here, before `await authClient.signOut()`,
    // while Better Auth may still cache the prior identity.
    portabilityEpochRef.current += 1;
    // Remount the portability subtree in this same render pass, discarding the
    // pasted JSON, parsed document, preview, confirmation, notices, and busy flag
    // immediately rather than leaving them active while sign-out is pending.
    setPortabilitySessionKey((key) => key + 1);

    try {
      await authClient.signOut();
    } finally {
      // Whether or not the call succeeded, drop local protected state and ask
      // the server again — the server remains the authority.
      setLoginError(null);
      setIsLoginVisible(false);
      try {
        await refetchSession();
      } finally {
        setIsSigningOut(false);
        reloadNavigation();
        reloadPersonal();
      }
    }
  }, [navigate, invalidateAdminBranding, invalidateAdminUsers, refetchSession, reloadNavigation, reloadPersonal]);

  /**
   * Run one mutation, then re-read server state.
   *
   * No optimistic cache is maintained: a successful mutation is always followed
   * by `GET /api/personal/navigation`, so rendered data is whatever the server
   * last returned.
   */
  const runMutation = useCallback(
    async (
      mutate: () => Promise<PersonalMutationOutcome>,
      isLink: boolean,
      reloadOnSuccess = true,
    ): Promise<PersonalMutationOutcome> => {
      const requestKey = sessionUserId ?? 'guest';
      const generation = portabilityEpochRef.current;

      setIsPersonalMutating(true);
      setPersonalMutationError(null);

      let outcome: PersonalMutationOutcome;

      try {
        outcome = await mutate();
      } catch {
        outcome = { status: 'error' };
      }

      if (!reloadOnSuccess && generation !== portabilityEpochRef.current) return { status: 'unauthenticated' };
      if (outcome.status === 'ok') {
        if (reloadOnSuccess) reloadPersonal();
      } else if (outcome.status === 'unauthenticated') {
        // The session is gone: drop protected state, then re-check it.
        setPersonalFetch(null);
        setPersonalMutationError(null);
        await refetchSession();
        reloadPersonal();
      } else {
        // Tagged with the identity that made the request, so it is ignored if
        // the user changed while the request was in flight.
        setPersonalMutationError({
          sessionKey: requestKey,
          message: mutationErrorMessage(outcome, isLink),
        });
      }

      setIsPersonalMutating(false);
      return outcome;
    },
    [reloadPersonal, refetchSession, sessionUserId],
  );

  /**
   * Plan and submit a reorder.
   *
   * Planning is delegated to the pure helpers in `personal-reorder.ts`, whose
   * payloads are unit-tested. This keeps the frozen server contract — in
   * particular the required `categoryId` on the link reorder — verifiable
   * without a browser, and makes it impossible to send a link reorder without an
   * owning category.
   */
  const applyReorder = useCallback(
    async (
      current: PersonalNavigation,
      kind: 'category' | 'link',
      targetId: number,
      direction: -1 | 1,
    ): Promise<PersonalMutationOutcome> => {
      if (kind === 'category') {
        const plan = planCategoryReorder(current, targetId, direction);
        return plan === null
          ? { status: 'ok' }
          : runMutation(() => reorderPersonalCategories(plan.ids), false);
      }

      const plan = planLinkReorder(current, targetId, direction);
      return plan === null
        ? { status: 'ok' }
        : runMutation(() => reorderPersonalLinks(plan.categoryId, plan.ids), false);
    },
    [runMutation],
  );

  const personalData = personalState.status === 'ready' ? personalState.data : null;

  /**
   * Client-side search query, owned here so one input spans both navigation
   * sections. Purely local view state: it never triggers a request, never mutates
   * the loaded payloads, and is not persisted anywhere.
   */
  const [searchQuery, setSearchQuery] = useState('');

  /**
   * Whether to show the shared no-results message.
   *
   * Only true once a non-empty query has been evaluated against the data that is
   * successfully loaded: public data must be ready, and for an authenticated
   * user so must personal data. Loading or failed reads cannot prove no results.
   */
  const publicCategories = state.status === 'ready' ? state.data.categories : [];
  const publicResolved = state.status === 'ready';
  const personalResolved = !isAuthenticated || personalState.status === 'ready';
  const searchResultCount = normalizeSearchQuery(searchQuery).length > 0 && !isSessionPending && publicResolved && personalResolved
    ? countMatchingLinks([publicCategories, personalData?.categories ?? []], searchQuery) : null;
  const showNoResults = searchResultCount === 0;

  const personalActions: PersonalNavigationActions = {
    moveLinkTo: (linkId, position) => moveLinkTo('personal', linkId, position),
    createCategory: (name) => runMutation(() => createPersonalCategory(name), false),
    renameCategory: (categoryId, name) =>
      runMutation(() => updatePersonalCategory(categoryId, name), false),
    deleteCategory: (categoryId) => runMutation(() => deletePersonalCategory(categoryId), false),
    moveCategory: (categoryId, direction) =>
      personalData === null
        ? Promise.resolve({ status: 'error' })
        : applyReorder(personalData, 'category', categoryId, direction),
    createLink: (input) => runMutation(() => createPersonalLink(input), true),
    updateLink: (linkId, input) => runMutation(() => updatePersonalLink(linkId, input), true),
    deleteLink: (linkId) => runMutation(() => deletePersonalLink(linkId), true),
    moveLink: (linkId, direction) => {
      if (personalData === null) {
        return Promise.resolve({ status: 'error' });
      }

      // Ownership is resolved inside `planLinkReorder` from the rendered payload.
      return applyReorder(personalData, 'link', linkId, direction);
    },
  };

  const adminUsersState: AdminUsersState =
    adminUsersSessionKey === null
      ? { status: 'absent' }
      : adminUsers === null || adminUsers.sessionKey !== adminUsersSessionKey || adminUsers.page !== usersPage
        ? { status: 'loading' }
        : adminUsers.state;

  const adminUsersActions: AdminUsersActions = {
    createUser: (input) => runUsersMutation(() => createAdminUser(input)),
    disableUser: (userId) => runUsersMutation(() => disableAdminUser(userId)),
    enableUser: (userId) => runUsersMutation(() => enableAdminUser(userId)),
    resetPassword: (userId, newPassword) =>
      runUsersMutation(() => resetAdminUserPassword(userId, newPassword)),
    deleteUser: (userId) => runUsersMutation(() => deleteAdminUser(userId)),
  };

  /**
   * Refetch every surface a successful import could have changed.
   *
   * A site import can change public navigation, branding text, and `accessMode`;
   * a personal import changes only the caller's own navigation. The import itself
   * is authoritative on the server, so the client simply re-reads.
   */
  const reloadAfterImport = useCallback(
    (scope: 'site' | 'personal') => {
      reloadPersonal();

      if (scope === 'site') {
        reloadAdmin();
        reloadBranding(true);
      }
    },
    [reloadAdmin, reloadBranding, reloadPersonal],
  );

  /**
   * Run one import apply, then re-read server state.
   *
   * The generation is captured **before the first `await`**, so a logout that
   * begins while the request is in flight is detectable the moment it completes.
   *
   * A stale completion returns `stale`, not the original result: the caller is the
   * still-mounted panel, and returning `ok` would let it render success and write
   * portability flow state for an identity that no longer exists. Discarding the
   * client continuation does not undo the import — the server already committed it
   * authoritatively, and the next login reads that state normally.
   */
  const runImportApply = useCallback(
    async (
      scope: 'site' | 'personal',
      apply: () => Promise<PortabilityResult>,
    ): Promise<PortabilityResult> => {
      // Before any await.
      const generation = captureGeneration(portabilityEpochRef.current);

      let result: PortabilityResult;

      try {
        result = await apply();
      } catch {
        result = { status: 'error' };
      }

      if (!isCurrentGeneration(generation, portabilityEpochRef.current)) {
        // The identity changed; nothing below may run.
        return { status: 'stale' };
      }

      if (result.status === 'ok') {
        reloadAfterImport(scope);
      } else if (result.status === 'unauthenticated') {
        await refetchSession();
      }

      return result;
    },
    [reloadAfterImport, refetchSession],
  );

  /**
   * Personal-scope portability actions.
   *
   * Export downloads the caller's own navigation; the server derives ownership from
   * the session, so no identity value is ever sent. Apply replaces the caller's
   * navigation and then refreshes the rendered personal section.
   */
  const personalPortabilityActions: PortabilityPanelActions = {
    export: async () => {
      // Captured before the await. Capturing it afterwards would fold an already-
      // completed logout into the captured value and wrongly accept a stale export.
      const generation = captureGeneration(portabilityEpochRef.current);
      const result = await downloadDocument(PERSONAL_EXPORT_ENDPOINT);

      if (!isCurrentGeneration(generation, portabilityEpochRef.current)) {
        // No file is written on behalf of an identity that has been torn down.
        return { status: 'stale' };
      }

      if (result.status !== 'ok') {
        return { status: result.status };
      }

      // `saveJsonFile` is a local browser action; guarded by the generation check
      // immediately above rather than by a post-hoc comparison.
      saveJsonFile(exportFilename('personal'), result.text);

      return { status: 'ok' };
    },
    preview: async (document: PortableDocument): Promise<PortabilityResult> => {
      const generation = captureGeneration(portabilityEpochRef.current);
      const result = await previewPersonalImport(document);

      if (!isCurrentGeneration(generation, portabilityEpochRef.current)) {
        // A stale preview must not render, re-arm confirmation, or restore an error.
        return { status: 'stale' };
      }

      return result.status === 'ok'
        ? { status: 'ok', summary: result.summary as PortabilitySummary }
        : result;
    },
    apply: (document: PortableDocument): Promise<PortabilityResult> =>
      runImportApply('personal', async () => {
        const result = await applyPersonalImport(document);

        return result.status === 'ok'
          ? { status: 'ok', summary: result.summary as PortabilitySummary }
          : result;
      }),
  };

  /**
   * Site-scope portability actions (admin only).
   *
   * Replacing branding settings can change `accessMode`, so a successful apply
   * refetches navigation as well as branding. Asset files are never part of the
   * document, so uploads are untouched.
   */
  const sitePortabilityActions: PortabilityPanelActions = {
    export: async () => {
      // Captured before the await, for the same reason as the personal export.
      const generation = captureGeneration(portabilityEpochRef.current);
      const result = await exportSiteDocument();

      if (!isCurrentGeneration(generation, portabilityEpochRef.current)) {
        return { status: 'stale' };
      }

      if (result.status !== 'ok') {
        return { status: result.status };
      }

      saveJsonFile(exportFilename('site'), result.text);

      return { status: 'ok' };
    },
    preview: async (document: PortableDocument): Promise<PortabilityResult> => {
      const generation = captureGeneration(portabilityEpochRef.current);
      const result = await previewSiteImport(document);

      if (!isCurrentGeneration(generation, portabilityEpochRef.current)) {
        return { status: 'stale' };
      }

      return result.status === 'ok'
        ? { status: 'ok', summary: result.summary as PortabilitySummary }
        : result;
    },
    apply: (document: PortableDocument): Promise<PortabilityResult> =>
      runImportApply('site', async () => {
        const result = await applySiteImport(document);

        return result.status === 'ok'
          ? { status: 'ok', summary: result.summary as PortabilitySummary }
          : result;
      }),
  };

  const session: SessionSummary = {
    isPending: isSessionPending || isSigningOut,
    username: sessionData?.user?.username ?? null,
  };

  /** Non-technical text for an admin mutation failure. */
  const adminFailureMessage = (outcome: AdminMutationOutcome): string => {
    switch (outcome.status) {
      case 'invalid':
        return '保存失败，请检查输入。';
      case 'notfound':
        return '该分类或网址已不存在，请刷新后重试。';
      case 'forbidden':
        return '没有管理权限。';
      case 'unauthenticated':
        return '登录状态已失效，请重新登录。';
      default:
        return '操作失败，请稍后重试。';
    }
  };

  /**
   * Run one admin mutation, then refetch authoritative Admin and public state.
   *
   * No optimistic cache: after a success both the admin view and the ordinary
   * public view are re-read from the server, so an admin immediately sees the
   * effect of a hide/show on the public homepage.
   */
  const runAdminMutation = useCallback(
    async (mutate: () => Promise<AdminMutationOutcome>, reloadOnSuccess = true): Promise<AdminMutationOutcome> => {
      const generation = portabilityEpochRef.current;
      setIsAdminMutating(true);
      setAdminMutationError(null);

      let outcome: AdminMutationOutcome;

      try {
        outcome = await mutate();
      } catch {
        outcome = { status: 'error' };
      }

      if (!reloadOnSuccess && generation !== portabilityEpochRef.current) return { status: 'unauthenticated' };
      if (outcome.status === 'ok') {
        if (reloadOnSuccess) { reloadAdmin(); reloadNavigation(); }
      } else if (outcome.status === 'unauthenticated') {
        // Session gone: drop admin state and re-check the session.
        setAdminNavigation(null);
        await refetchSession();
      } else {
        setAdminMutationError(adminFailureMessage(outcome));
      }

      setIsAdminMutating(false);
      return outcome;
    },
    [reloadAdmin, reloadNavigation, refetchSession],
  );

  const adminState: AdminPublicNavigationState =
    !isAdmin
      ? { status: 'absent' }
      : adminNavigation === null
        ? { status: 'loading' }
        : adminNavigation.status === 'ok'
          ? { status: 'ready', data: adminNavigation.data }
          : adminNavigation.status === 'error'
            ? { status: 'error' }
            : { status: 'absent' };

  const adminData = adminState.status === 'ready' ? adminState.data : null;

  /**
   * Swap a target with its neighbour and submit the full resulting id list.
   *
   * The server requires exactly the current id set, so the ids always come from
   * the rendered server payload rather than being reconstructed.
   */
  const applyAdminReorder = async (
    current: AdminPublicNavigation,
    kind: 'category' | 'link',
    targetId: number,
    direction: -1 | 1,
    owningCategoryId?: number,
  ): Promise<AdminMutationOutcome> => {
    if (kind === 'category') {
      const ids = current.categories.map((category) => category.id);
      const index = ids.indexOf(targetId);
      const swapWith = index + direction;

      if (index < 0 || swapWith < 0 || swapWith >= ids.length) {
        return { status: 'ok' };
      }

      [ids[index], ids[swapWith]] = [ids[swapWith] as number, ids[index] as number];
      return runAdminMutation(() => reorderAdminPublicCategories(ids));
    }

    const category = current.categories.find((item) => item.id === owningCategoryId);
    const ids = category?.links.map((link) => link.id) ?? [];
    const index = ids.indexOf(targetId);
    const swapWith = index + direction;

    if (category === undefined || index < 0 || swapWith < 0 || swapWith >= ids.length) {
      return { status: 'ok' };
    }

    [ids[index], ids[swapWith]] = [ids[swapWith] as number, ids[index] as number];
    return runAdminMutation(() => reorderAdminPublicLinks(category.id, ids));
  };

  const adminActions: AdminPublicNavigationActions = {    createCategory: (input) => runAdminMutation(() => createAdminPublicCategory(input)),
    moveLinkTo: (linkId, position) => moveLinkTo('admin', linkId, position),
    updateCategory: (categoryId, input) =>
      runAdminMutation(() => updateAdminPublicCategory(categoryId, input)),
    deleteCategory: (categoryId) => runAdminMutation(() => deleteAdminPublicCategory(categoryId)),
    moveCategory: (categoryId, direction) =>
      adminData === null
        ? Promise.resolve({ status: 'error' })
        : applyAdminReorder(adminData, 'category', categoryId, direction),
    createLink: (input) => runAdminMutation(() => createAdminPublicLink(input)),
    updateLink: (linkId, input) => runAdminMutation(() => updateAdminPublicLink(linkId, input)),
    deleteLink: (linkId) => runAdminMutation(() => deleteAdminPublicLink(linkId)),
    moveLink: (linkId, direction) => {
      if (adminData === null) {
        return Promise.resolve({ status: 'error' });
      }

      const owning = adminData.categories.find((category) =>
        category.links.some((link) => link.id === linkId),
      );

      if (owning === undefined) {
        return Promise.resolve({ status: 'error' });
      }

      return applyAdminReorder(adminData, 'link', linkId, direction, owning.id);
    },
    toggleLinkVisibility: (linkId, isVisible) =>
      runAdminMutation(() => updateAdminPublicLink(linkId, { isVisible })),
    toggleCategoryVisibility: (categoryId, isVisible) =>
      runAdminMutation(() => updateAdminPublicCategory(categoryId, { isVisible })),
  };

  /** An explicit move checks current membership, then awaits the authoritative read. */
  async function moveLinkTo(scope: 'personal' | 'admin', linkId: number, position: number): Promise<LinkMoveOutcome> {
    const current = scope === 'personal' ? personalData : adminData;
    const owners = current?.categories.filter((category) => category.links.some((link) => link.id === linkId)) ?? [];
    const owner = owners[0];
    if (owners.length !== 1 || !owner) return { status: 'error', message: '该网址已不在当前分类，请刷新后重试。' };
    const initial = planLinkMove(owner.links.map((link) => link.id), linkId, position);
    if (initial.status === 'invalid') return { status: 'error', message: '位置或分类内容已变化，请检查后重试。' };
    if (initial.status === 'unchanged') return { status: 'unchanged' };
    if (linkMoveBusyRef.current[scope] || (scope === 'personal' ? isPersonalMutating : isAdminMutating)) {
      return { status: 'error', message: '正在保存其他操作，请稍后重试。' };
    }
    const generation = portabilityEpochRef.current;
    const requestUser = sessionUserId;
    const isCurrent = () => generation === portabilityEpochRef.current;
    let saved = false;
    linkMoveBusyRef.current[scope] = true;
    const read = () => scope === 'personal' ? fetchPersonalNavigation() : fetchAdminPublicNavigation();
    const acceptRead = (data: PersonalNavigation | AdminPublicNavigation) => {
      if (scope === 'personal') setPersonalFetch({ sessionKey: requestUser ?? 'guest', result: { status: 'ok', data: data as PersonalNavigation } });
      else { setAdminNavigation({ status: 'ok', data: data as AdminPublicNavigation }); reloadNavigation(); }
      if (!data.categories.some((category) => category.id === owner.id && category.links.some((link) => link.id === linkId))) {
        requestAnimationFrame(() => {
          if (!isCurrent()) return;
          const prefix = scope === 'personal' ? 'personal-category-' : 'admin-category-';
          (document.getElementById(`${prefix}${owner.id}`) ?? document.getElementById(scope === 'personal' ? 'personal-title' : 'admin-title'))?.focus();
        });
      }
    };
    const operation = async (): Promise<PersonalMutationOutcome | AdminMutationOutcome> => {
      const before = await read();
      if (!isCurrent()) return { status: 'unauthenticated' };
      if (before.status !== 'ok') return before;
      const category = before.data.categories.find((item) => item.id === owner.id);
      if (!category || !category.links.some((link) => link.id === linkId)) return { status: 'notfound' };
      const plan = planLinkMove(category.links.map((link) => link.id), linkId, position);
      if (plan.status === 'invalid') return { status: 'invalid' };
      // An uncertain previous request may already have reached its destination.
      if (plan.status === 'unchanged') { acceptRead(before.data); return { status: 'ok' }; }
      const outcome = scope === 'personal'
        ? await reorderPersonalLinks(category.id, plan.ids)
        : await reorderAdminPublicLinks(category.id, plan.ids);
      if (!isCurrent()) return { status: 'unauthenticated' };
      if (outcome.status !== 'ok') return outcome;
      saved = true;
      const after = await read();
      if (!isCurrent()) return { status: 'unauthenticated' };
      if (after.status !== 'ok') return after;
      acceptRead(after.data);
      return { status: 'ok' };
    };
    try {
      const outcome = scope === 'personal'
        ? await runMutation(async () => { const result = await operation(); return result.status === 'forbidden' ? { status: 'error' } : result; }, true, false)
        : await runAdminMutation(async () => { const result = await operation(); return result.status === 'conflict' ? { status: 'invalid' } : result; }, false);
      if (!isCurrent()) return { status: 'cancelled' };
      if (outcome.status === 'ok') return { status: 'ok' };
      const message = saved ? '已保存，但列表刷新失败；重试前会先重新读取。'
        : outcome.status === 'unauthenticated' ? '登录状态已失效，请重新登录。'
        : outcome.status === 'forbidden' ? '没有管理权限。'
        : outcome.status === 'invalid' || outcome.status === 'notfound' || outcome.status === 'conflict'
          ? '分类内容或位置已变化，请刷新后重试。'
          : '未能确认保存结果；重试前会先重新读取列表。';
      return { status: 'error', message };
    } finally { linkMoveBusyRef.current[scope] = false; }
  }

  /** Non-technical text for a branding mutation failure. */
  const brandingFailureMessage = (outcome: BrandingMutationOutcome): string => {
    switch (outcome.status) {
      case 'invalid':
        return '保存失败，请检查输入。';
      case 'forbidden':
        return '没有管理权限。';
      case 'unauthenticated':
        return '登录状态已失效，请重新登录。';
      default:
        return '操作失败，请稍后重试。';
    }
  };

  /**
   * Run one branding mutation, then refetch authoritative branding state.
   *
   * Settings saves additionally refetch navigation, because `accessMode` can
   * change whether a guest may see it. Asset uploads/removals only affect
   * presentation, so they skip that.
   */
  const runBrandingMutation = useCallback(
    async (
      mutate: () => Promise<BrandingMutationOutcome>,
      includeNavigation: boolean,
    ): Promise<BrandingMutationOutcome> => {
      // Captured before the await so a logout that happens mid-request is
      // detectable when the response arrives.
      const epoch = adminBrandingEpochRef.current;

      setIsBrandingMutating(true);
      setBrandingMutationError(null);

      let outcome: BrandingMutationOutcome;

      try {
        outcome = await mutate();
      } catch {
        outcome = { status: 'error' };
      }

      // The identity may have changed while the request was in flight. Logout has
      // already invalidated this epoch and cleared the branding state, so nothing
      // here may run: refetching would start a protected Admin read under a
      // torn-down session, and reporting an error or busy flag would resurrect
      // state that logout deliberately cleared.
      if (epoch !== adminBrandingEpochRef.current) {
        return outcome;
      }

      if (outcome.status === 'ok') {
        reloadBranding(includeNavigation);
      } else if (outcome.status === 'unauthenticated') {
        setAdminBranding(null);
        await refetchSession();
      } else {
        setBrandingMutationError(brandingFailureMessage(outcome));
      }

      setIsBrandingMutating(false);
      return outcome;
    },
    [reloadBranding, refetchSession],
  );

  const adminBrandingState: AdminBrandingState =
    !isAdmin
      ? { status: 'absent' }
      : adminBranding === null
        ? { status: 'loading' }
        : adminBranding.status === 'ok'
          ? { status: 'ready', data: adminBranding.data }
          : adminBranding.status === 'error'
            ? { status: 'error' }
            : { status: 'absent' };

  const adminBrandingActions: AdminBrandingActions = {
    save: (input) => runBrandingMutation(() => updateAdminBranding(input), true),
    uploadLogo: (file) => runBrandingMutation(() => uploadBrandLogo(file), false),
    uploadFavicon: (file) => runBrandingMutation(() => uploadBrandFavicon(file), false),
    uploadBackground: (file) => runBrandingMutation(() => uploadBrandBackground(file), false),
    removeLogo: () => runBrandingMutation(() => removeBrandLogo(), false),
    removeFavicon: () => runBrandingMutation(() => removeBrandFavicon(), false),
    removeBackground: () => runBrandingMutation(() => removeBrandBackground(), false),
  };

  /**
   * Admin Management page (UX-IA).
   *
   * Reuses the same branded header cluster and footer as Home so the admin is
   * visibly inside the same product, and composes the four existing management
   * views — each shown one at a time by `AdminManagementView`. All state and
   * mutation ownership stays in this container; the views are props-driven, so
   * no business logic moved.
   */
  if (adminPageActive) {
    return (
      <div className="app app--admin">
        <header className="site-header">
          <div className="site-header__top">
            <BrandHeader branding={publicBranding} />
            <SessionBar
              session={session}
              isAuthenticated={isAuthenticated}
              isLoginVisible={false}
              onLogout={() => {
                void handleLogout();
              }}
              onShowLogin={() => {}}
              onHideLogin={() => {}}
            />
          </div>
        </header>

        <main className="content" id="main-content" tabIndex={-1}>
          <AdminManagementView
            // Guarded here rather than at the navigation call: this component owns
            // every exit from a module, navigation row and "返回导航" alike.
            confirmLeave={() => brandingUnsavedGuardRef.current?.() ?? Promise.resolve(true)}
            onBackToHome={() => navigate('home')}
            // At sidebar widths the shell hides the shared header, so it carries
            // the same identity and session controls itself.
            siteBranding={publicBranding}
            username={session.username ?? ''}
            onLogout={() => { void handleLogout(); }}
            publicNavigation={
              <AdminPublicNavigationView
                state={adminState}
                actions={adminActions}
                isMutating={isAdminMutating}
                errorMessage={adminMutationError}
              />
            }
            branding={
              <AdminBrandingView
                state={adminBrandingState}
                actions={adminBrandingActions}
                isMutating={isBrandingMutating}
                errorMessage={brandingMutationError}
                onUnsavedGuard={setBrandingUnsavedGuard}
              />
            }
            users={
              <AdminUsersView
                key={`${adminUsersSessionKey}:${usersPage}`}
                state={adminUsersState}
                actions={adminUsersActions}
                isMutating={isUsersMutating}
                errorMessage={usersMutationError}
                currentUserId={sessionUserId}
                pagination={{ page: usersPage, total: usersTotal, onPageChange: changeUsersPage }}
              />
            }
            data={
              <DataPortabilityView
                key={`${personalSessionKey}:${portabilitySessionKey}`}
                personal={{ actions: personalPortabilityActions }}
                site={{ actions: sitePortabilityActions }}
              />
            }
          />
        </main>

        {publicBranding.footerText !== null && publicBranding.footerText.length > 0 ? (
          <footer className="site-footer">
            <FooterContent text={publicBranding.footerText} />
          </footer>
        ) : null}
      </div>
    );
  }

  if (effectivePage === 'settings') {
    return (
      <div className="app app--settings">
        <header className="site-header">
          <div className="site-header__top">
            <BrandHeader branding={publicBranding} />
            <SessionBar
              session={session}
              isAuthenticated={isAuthenticated}
              isLoginVisible={false}
              onLogout={() => { void handleLogout(); }}
              onShowLogin={() => {}}
              onHideLogin={() => {}}
            />
          </div>
        </header>
        <main className="content" id="main-content" tabIndex={-1}>
          <PersonalSettingsView
            key={`${personalSessionKey}:${portabilitySessionKey}`}
            actions={personalPortabilityActions}
            onBackToHome={() => navigate('home')}
          />
        </main>
        {publicBranding.footerText !== null && publicBranding.footerText.length > 0 ? (
          <footer className="site-footer">
            <FooterContent text={publicBranding.footerText} />
          </footer>
        ) : null}
      </div>
    );
  }

  /**
   * Navigation Home (UX-IA).
   *
   * The daily surface: search, personal navigation (with Quick Add), and public
   * navigation. Management entries in the header select separate pages.
   */
  return (
    <PublicNavigationView
      state={state}
      session={session}
      isLoginVisible={isLoginVisible}
      login={{
        isSubmitting: isSubmitting || isSigningOut,
        errorMessage: loginError,
        onSubmit: handleLogin,
      }}
      onLogout={() => {
        void handleLogout();
      }}
      onShowLogin={() => {
        // A failure message describes the attempt that produced it, so it must not
        // greet the next visit: without this, closing a failed Login and opening it
        // again showed the previous "用户名或密码错误" (and its role="alert") before
        // the user had tried anything. Clearing here, at the fresh-open boundary, is
        // the smallest change and leaves the current attempt's error intact — that is
        // set by handleLogin on failure and stays visible until the form is closed.
        setLoginError(null);
        setIsLoginVisible(true);
      }}
      onHideLogin={() => setIsLoginVisible(false)}
      search={{
        query: searchQuery,
        onChange: setSearchQuery,
        showNoResults,
        resultCount: searchResultCount,
      }}
      onRetry={() => setReloadToken((current) => current + 1)}
      personal={
        isAuthenticated
          ? {
              view: (
                <PersonalNavigationView
                  state={personalState}
                  actions={personalActions}
                  isMutating={isPersonalMutating}
                  errorMessage={personalError}
                  searchQuery={searchQuery}
                  onRetry={() => setPersonalReloadToken((current) => current + 1)}
                />
              ),
            }
          : null
      }
      adminEntry={
        isAdmin
          ? {
              onOpenAdmin: () => navigate('admin'),
            }
          : null
      }
      branding={publicBranding}
      settingsEntry={
        isAuthenticated && !isAdmin
          ? {
              onOpenSettings: () => navigate('settings'),
            }
          : null
      }
    />
  );
}
