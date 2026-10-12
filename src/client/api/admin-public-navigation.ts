/**
 * Client-side access to the Admin Public Navigation API.
 *
 * Mirrors `src/server/public-mutations.ts`. Declared locally on purpose: the
 * client must not import server modules.
 *
 * Authorization is entirely server-side. This module never sends a role, user id,
 * or any other identity field — only the session cookie, which the server
 * resolves itself. Client-side visibility of the admin UI is convenience; a
 * hidden button is not a permission.
 */

/** A public category as returned by the admin read endpoint (includes hidden rows). */
export interface AdminPublicCategory {
  id: number;
  name: string;
  icon: string | null;
  sortOrder: number;
  isVisible: boolean;
  links: AdminPublicLink[];
}

/** A public link as returned by the admin read endpoint (includes hidden rows). */
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
  categories: AdminPublicCategory[];
}

/** Same-origin path; the Vite dev proxy forwards `/api` to the Hono server. */
export const ADMIN_PUBLIC_NAVIGATION_ENDPOINT = '/api/admin/public-navigation';
export const ADMIN_PUBLIC_CATEGORIES_ENDPOINT = '/api/admin/public/categories';
export const ADMIN_PUBLIC_LINKS_ENDPOINT = '/api/admin/public/links';

/**
 * Outcome of reading admin navigation state.
 *
 * `forbidden` is distinct from `unauthenticated`: a 403 means the server
 * recognizes the caller but they are not an admin, so the UI must not offer
 * admin controls or retry as though a login would help.
 */
export type AdminNavigationResult =
  | { status: 'ok'; data: AdminPublicNavigation }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' };

/** Outcome of an admin mutation. Response payloads are not modelled; the UI refetches. */
export type AdminMutationOutcome =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'notfound' }
  | { status: 'error' };

function classifyMutation(response: Response): AdminMutationOutcome {
  if (response.ok) {
    return { status: 'ok' };
  }

  switch (response.status) {
    case 400:
      return { status: 'invalid' };
    case 401:
      return { status: 'unauthenticated' };
    case 403:
      return { status: 'forbidden' };
    case 404:
      return { status: 'notfound' };
    default:
      return { status: 'error' };
  }
}

/** Read all public navigation rows, including hidden ones. Admin only. */
export async function fetchAdminPublicNavigation(
  signal?: AbortSignal,
): Promise<AdminNavigationResult> {
  let response: Response;

  try {
    response = await fetch(ADMIN_PUBLIC_NAVIGATION_ENDPOINT, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { status: 'error' };
  }

  if (response.status === 401) {
    return { status: 'unauthenticated' };
  }

  if (response.status === 403) {
    return { status: 'forbidden' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  try {
    return { status: 'ok', data: (await response.json()) as AdminPublicNavigation };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Send an admin mutation.
 *
 * `Content-Type: application/json` is always sent, including for DELETE, matching
 * the server's media-type contract.
 */
async function sendAdminMutation(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<AdminMutationOutcome> {
  let response: Response;

  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { status: 'error' };
  }

  return classifyMutation(response);
}

/** Create a public category. Appended server-side; `sortOrder` is never sent. */
export function createAdminPublicCategory(input: {
  name: string;
  icon?: string | null;
  isVisible?: boolean;
}): Promise<AdminMutationOutcome> {
  return sendAdminMutation(ADMIN_PUBLIC_CATEGORIES_ENDPOINT, 'POST', input);
}

/** Update a public category's name, icon, and/or visibility. */
export function updateAdminPublicCategory(
  categoryId: number,
  input: { name?: string; icon?: string | null; isVisible?: boolean },
): Promise<AdminMutationOutcome> {
  return sendAdminMutation(`${ADMIN_PUBLIC_CATEGORIES_ENDPOINT}/${String(categoryId)}`, 'PATCH', input);
}

/** Delete a public category; its links cascade in the database. */
export function deleteAdminPublicCategory(categoryId: number): Promise<AdminMutationOutcome> {
  return sendAdminMutation(`${ADMIN_PUBLIC_CATEGORIES_ENDPOINT}/${String(categoryId)}`, 'DELETE');
}

/** Apply a full category order. The server requires exactly the current id set. */
export function reorderAdminPublicCategories(ids: number[]): Promise<AdminMutationOutcome> {
  return sendAdminMutation(`${ADMIN_PUBLIC_CATEGORIES_ENDPOINT}/order`, 'PUT', { ids });
}

/** Create a public link inside an existing category. */
export function createAdminPublicLink(input: {
  categoryId: number;
  title: string;
  url: string;
  description?: string | null;
  iconUrl?: string | null;
  isVisible?: boolean;
}): Promise<AdminMutationOutcome> {
  return sendAdminMutation(ADMIN_PUBLIC_LINKS_ENDPOINT, 'POST', input);
}

/** Update a public link, optionally moving it to another category. */
export function updateAdminPublicLink(
  linkId: number,
  input: {
    title?: string;
    url?: string;
    description?: string | null;
    iconUrl?: string | null;
    isVisible?: boolean;
    categoryId?: number;
  },
): Promise<AdminMutationOutcome> {
  return sendAdminMutation(`${ADMIN_PUBLIC_LINKS_ENDPOINT}/${String(linkId)}`, 'PATCH', input);
}

/** Delete a public link. */
export function deleteAdminPublicLink(linkId: number): Promise<AdminMutationOutcome> {
  return sendAdminMutation(`${ADMIN_PUBLIC_LINKS_ENDPOINT}/${String(linkId)}`, 'DELETE');
}

/** Apply a full order within one category. */
export function reorderAdminPublicLinks(
  categoryId: number,
  ids: number[],
): Promise<AdminMutationOutcome> {
  return sendAdminMutation(`${ADMIN_PUBLIC_LINKS_ENDPOINT}/order`, 'PUT', { categoryId, ids });
}
