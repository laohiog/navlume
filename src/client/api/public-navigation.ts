/**
 * Client-side access to the public navigation API.
 *
 * The types mirror the server contract in `src/server/public-navigation.ts`.
 * They are declared separately on purpose: the client must not import server
 * modules, and no code-generation or validation framework is used in P1.
 */

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
  /**
   * Informational only in P1.3. Authentication does not exist until P2, so
   * `login_required` is NOT enforced by the client.
   */
  accessMode: 'public' | 'login_required';
}

/** A visible public link. */
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

/** Same-origin API path; the Vite dev proxy forwards `/api` to the Hono server. */
export const PUBLIC_NAVIGATION_ENDPOINT = '/api/public/navigation';

/**
 * Outcome of fetching public navigation.
 *
 * `unauthenticated` is returned (rather than thrown) when the server enforces
 * `access_mode = login_required` and no valid session exists. The client uses it
 * to switch to the login screen; it is never an authorization decision.
 */
export type PublicNavigationResult =
  | { status: 'ok'; data: PublicNavigation }
  | { status: 'unauthenticated' }
  | { status: 'error' };

/**
 * Fetch the public navigation payload.
 *
 * Returns a discriminated result instead of throwing so callers can distinguish
 * "sign in required" (401) from a generic failure. The 401 body is not read, so
 * no protected data from a rejected response can reach the UI.
 */
export async function fetchPublicNavigation(signal?: AbortSignal): Promise<PublicNavigationResult> {
  let response: Response;

  try {
    response = await fetch(PUBLIC_NAVIGATION_ENDPOINT, {
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    // Network failure or abort.
    return { status: 'error' };
  }

  if (response.status === 401) {
    return { status: 'unauthenticated' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  try {
    return { status: 'ok', data: (await response.json()) as PublicNavigation };
  } catch {
    return { status: 'error' };
  }
}
