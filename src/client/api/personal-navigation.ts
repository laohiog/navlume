/**
 * Client-side access to the personal navigation API.
 *
 * The types mirror `src/server/personal-navigation.ts` and
 * `src/server/personal-mutations.ts`, but are declared separately on purpose:
 * the client must not import server modules, and P3 uses no code generation or
 * runtime validation framework.
 *
 * Ownership is never sent from here. Every request carries only the session
 * cookie; the server derives the user from its own session. `normalizedUrl` is
 * likewise never supplied by the client — the server is the only URL authority.
 */

/** A personal link as returned by `GET /api/personal/navigation`. */
export interface PersonalLink {
  id: number;
  title: string;
  url: string;
  normalizedUrl: string;
  iconUrl: string | null;
  sortOrder: number;
}

/** A personal category with its owning user's links. */
export interface PersonalCategory {
  id: number;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  links: PersonalLink[];
}

/** Response body of `GET /api/personal/navigation`. */
export interface PersonalNavigation {
  categories: PersonalCategory[];
}

/** Same-origin path; the Vite dev proxy forwards `/api` to the Hono server. */
export const PERSONAL_NAVIGATION_ENDPOINT = '/api/personal/navigation';

/** Endpoint builders, exported so tests can assert the exact request shape. */
export const PERSONAL_CATEGORIES_ENDPOINT = '/api/personal/categories';
export const PERSONAL_LINKS_ENDPOINT = '/api/personal/links';

/**
 * Outcome of reading personal navigation.
 *
 * `unauthenticated` is returned (not thrown) for HTTP 401 so the caller can drop
 * local state and re-check the session. The rejected body is never read, so no
 * protected payload can leak through a 401 response.
 */
export type PersonalNavigationResult =
  | { status: 'ok'; data: PersonalNavigation }
  | { status: 'unauthenticated' }
  | { status: 'error' };

/**
 * Outcome of a personal mutation.
 *
 * Response payloads are deliberately not modelled: after any success the UI
 * re-reads server state, which is the single source of truth. `invalid` covers
 * every HTTP 400 (field validation and URL validation alike) because the client
 * is not the validation authority and must not attempt to re-implement it.
 */
export type PersonalMutationOutcome =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'unauthenticated' }
  | { status: 'notfound' }
  | { status: 'conflict' }
  | { status: 'error' };

/** Map a mutation response onto an outcome. No response body is inspected. */
function classifyMutation(response: Response): PersonalMutationOutcome {
  if (response.ok) {
    return { status: 'ok' };
  }

  switch (response.status) {
    case 400:
      return { status: 'invalid' };
    case 401:
      return { status: 'unauthenticated' };
    case 404:
      return { status: 'notfound' };
    case 409:
      return { status: 'conflict' };
    default:
      return { status: 'error' };
  }
}

/**
 * Send a personal mutation.
 *
 * `Content-Type: application/json` is always sent — including for DELETE, which
 * has no body — because that is the server contract verified in P3.2. Sending it
 * is not optional and is not inferred from whether a body happens to exist.
 */
async function sendMutation(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<PersonalMutationOutcome> {
  let response: Response;

  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // Network failure, abort, or CORS rejection.
    return { status: 'error' };
  }

  return classifyMutation(response);
}

/** Read the authenticated user's personal navigation. */
export async function fetchPersonalNavigation(
  signal?: AbortSignal,
): Promise<PersonalNavigationResult> {
  let response: Response;

  try {
    response = await fetch(PERSONAL_NAVIGATION_ENDPOINT, {
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

  if (!response.ok) {
    return { status: 'error' };
  }

  try {
    return { status: 'ok', data: (await response.json()) as PersonalNavigation };
  } catch {
    return { status: 'error' };
  }
}

/** Create a personal category. Always appended at the end by the server. */
export function createPersonalCategory(name: string): Promise<PersonalMutationOutcome> {
  return sendMutation(PERSONAL_CATEGORIES_ENDPOINT, 'POST', { name });
}

/** Rename a personal category. */
export function updatePersonalCategory(
  categoryId: number,
  name: string,
): Promise<PersonalMutationOutcome> {
  return sendMutation(`${PERSONAL_CATEGORIES_ENDPOINT}/${String(categoryId)}`, 'PATCH', { name });
}

/** Delete a non-default personal category; its links cascade. */
export function deletePersonalCategory(categoryId: number): Promise<PersonalMutationOutcome> {
  return sendMutation(`${PERSONAL_CATEGORIES_ENDPOINT}/${String(categoryId)}`, 'DELETE');
}

/** Apply a full category order. The server rejects anything but the exact owned set. */
export function reorderPersonalCategories(ids: number[]): Promise<PersonalMutationOutcome> {
  return sendMutation(`${PERSONAL_CATEGORIES_ENDPOINT}/order`, 'PUT', { ids });
}

/** Create a link inside one of the caller's categories. */
export function createPersonalLink(input: {
  categoryId: number;
  title: string;
  url: string;
}): Promise<PersonalMutationOutcome> {
  return sendMutation(PERSONAL_LINKS_ENDPOINT, 'POST', input);
}

/** Edit a link's title/url and/or move it to another of the caller's categories. */
export function updatePersonalLink(
  linkId: number,
  input: { title?: string; url?: string; categoryId?: number },
): Promise<PersonalMutationOutcome> {
  return sendMutation(`${PERSONAL_LINKS_ENDPOINT}/${String(linkId)}`, 'PATCH', input);
}

/** Delete a personal link. */
export function deletePersonalLink(linkId: number): Promise<PersonalMutationOutcome> {
  return sendMutation(`${PERSONAL_LINKS_ENDPOINT}/${String(linkId)}`, 'DELETE');
}

/**
 * Apply a full order for the links of one category.
 *
 * The server contract (P3.2, frozen) requires the owning `categoryId` alongside
 * the id list: `reorderLinks` validates that `ids` is exactly the link set of
 * that category. Sending only `ids` is rejected with HTTP 400, so the category
 * is a required argument here rather than something the caller may forget.
 */
export function reorderPersonalLinks(
  categoryId: number,
  ids: number[],
): Promise<PersonalMutationOutcome> {
  return sendMutation(`${PERSONAL_LINKS_ENDPOINT}/order`, 'PUT', { categoryId, ids });
}
