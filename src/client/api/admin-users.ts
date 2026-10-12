/**
 * Client-side access to Better Auth's official Admin plugin endpoints.
 *
 * These are Better Auth's own `/api/auth/admin/*` routes — there is deliberately
 * **no** custom `/api/admin/users/*` API. Better Auth performs the session and
 * role authorization server-side on every call, so this module never sends a role,
 * user id, or any other identity claim: only the session cookie, which the server
 * resolves itself.
 *
 * No password hashing, policy, or session logic lives here. The admin password
 * reset is Better Auth's `set-user-password`, which owns hashing and validation.
 */

/** A user as returned by `GET /api/auth/admin/list-users`. */
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  username: string | null;
  role: string | null;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserList {
  users: AdminUser[];
  total: number;
}

export const ADMIN_LIST_USERS_ENDPOINT = '/api/auth/admin/list-users';
export const ADMIN_USERS_PAGE_SIZE = 100;
export const ADMIN_CREATE_USER_ENDPOINT = '/api/auth/admin/create-user';
export const ADMIN_BAN_USER_ENDPOINT = '/api/auth/admin/ban-user';
export const ADMIN_UNBAN_USER_ENDPOINT = '/api/auth/admin/unban-user';
export const ADMIN_SET_PASSWORD_ENDPOINT = '/api/auth/admin/set-user-password';
export const ADMIN_REMOVE_USER_ENDPOINT = '/api/auth/admin/remove-user';

/**
 * Outcome of reading the user list.
 *
 * `forbidden` is distinct from `unauthenticated` so the UI never treats "you are
 * not an admin" as "log in again".
 */
export type AdminUserListResult =
  | { status: 'ok'; data: AdminUserList }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' };

/** Outcome of an account operation. Response payloads are not modelled; the UI refetches. */
export type AdminUserMutationOutcome =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'notfound' }
  | { status: 'error' };

/** Read the user list. `limit` is bounded to keep the page small. */
export async function fetchAdminUsers(offset = 0, signal?: AbortSignal): Promise<AdminUserListResult> {
  let response: Response;

  try {
    response = await fetch(`${ADMIN_LIST_USERS_ENDPOINT}?limit=${String(ADMIN_USERS_PAGE_SIZE)}&offset=${String(offset)}&sortBy=createdAt&sortDirection=asc`, {
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
    const data = (await response.json()) as AdminUserList;
    return { status: 'ok', data };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Better Auth returns errors as `{ message, code }`. The raw message and code are
 * never surfaced to the user — only classified into a coarse outcome.
 */
function classify(response: Response): AdminUserMutationOutcome {
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

/** POST one of Better Auth's admin endpoints. */
async function postAdmin(path: string, body: unknown): Promise<AdminUserMutationOutcome> {
  let response: Response;

  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 'error' };
  }

  return classify(response);
}

/**
 * Create an ordinary user account.
 *
 * `role` is fixed to `'user'` in this module and is not a parameter: the browser
 * must never be able to request arbitrary roles. `emailVerified: true` matches the
 * repository's existing admin-provisioning convention — this MVP has no
 * email-verification flow, and an unverified account cannot sign in.
 */
export function createAdminUser(input: {
  username: string;
  name: string;
  email: string;
  password: string;
}): Promise<AdminUserMutationOutcome> {
  return postAdmin(ADMIN_CREATE_USER_ENDPOINT, {
    email: input.email,
    password: input.password,
    name: input.name,
    role: 'user',
    data: { username: input.username, emailVerified: true },
  });
}

/**
 * Disable an account indefinitely via Better Auth's ban capability.
 *
 * The account and all of its personal data are preserved; only the ability to
 * authenticate is removed. There is no separate `disabled` column and no migration.
 */
export function disableAdminUser(userId: string): Promise<AdminUserMutationOutcome> {
  return postAdmin(ADMIN_BAN_USER_ENDPOINT, { userId, banReason: 'Disabled by administrator' });
}

/** Re-enable a previously disabled account. */
export function enableAdminUser(userId: string): Promise<AdminUserMutationOutcome> {
  return postAdmin(ADMIN_UNBAN_USER_ENDPOINT, { userId });
}

/** Reset a user's password. Better Auth hashes it; the client never sees it again. */
export function resetAdminUserPassword(
  userId: string,
  newPassword: string,
): Promise<AdminUserMutationOutcome> {
  return postAdmin(ADMIN_SET_PASSWORD_ENDPOINT, { userId, newPassword });
}

/** Delete a user account irreversibly. Personal data cascades in the database. */
export function deleteAdminUser(userId: string): Promise<AdminUserMutationOutcome> {
  return postAdmin(ADMIN_REMOVE_USER_ENDPOINT, { userId });
}
