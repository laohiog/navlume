import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_BAN_USER_ENDPOINT,
  ADMIN_CREATE_USER_ENDPOINT,
  ADMIN_LIST_USERS_ENDPOINT,
  ADMIN_REMOVE_USER_ENDPOINT,
  ADMIN_SET_PASSWORD_ENDPOINT,
  ADMIN_UNBAN_USER_ENDPOINT,
  createAdminUser,
  deleteAdminUser,
  disableAdminUser,
  enableAdminUser,
  fetchAdminUsers,
  resetAdminUserPassword,
} from '../../src/client/api/admin-users.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchStub = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const LIST = {
  users: [
    {
      id: 'u1',
      name: 'User One',
      email: 'u1@example.com',
      emailVerified: true,
      image: null,
      username: 'userone',
      role: 'user',
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 1,
};

describe('fetchAdminUsers', () => {
  it.each([0, 100, 200])('requests a 100-user page at offset %i with createdAt ordering', async (offset) => {
    const fetchStub = stubFetch(new Response(JSON.stringify({ ...LIST, total: 201 }), { status: 200 }));
    const controller = new AbortController();
    const result = await fetchAdminUsers(offset, controller.signal);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    const query = new URL(url, 'http://localhost').searchParams;
    expect(query.get('limit')).toBe('100');
    expect(query.get('offset')).toBe(String(offset));
    expect(query.get('sortBy')).toBe('createdAt');
    expect(query.get('sortDirection')).toBe('asc');
    expect(init.signal).toBe(controller.signal);
    expect(init.credentials).toBe('same-origin');
    expect(result).toEqual({ status: 'ok', data: { ...LIST, total: 201 } });
  });

  it('uses the official Better Auth admin endpoint, not a custom API', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(LIST), { status: 200 }));

    const result = await fetchAdminUsers();

    const url = String(fetchStub.mock.calls[0]?.[0]);
    expect(url.startsWith(ADMIN_LIST_USERS_ENDPOINT)).toBe(true);
    expect(ADMIN_LIST_USERS_ENDPOINT).toBe('/api/auth/admin/list-users');
    // No custom user-management API was introduced.
    expect(ADMIN_LIST_USERS_ENDPOINT).not.toContain('/api/admin/users');
    expect(result.status).toBe('ok');
  });

  it('separates unauthenticated (401) from forbidden (403)', async () => {
    stubFetch(new Response('{}', { status: 401 }));
    await expect(fetchAdminUsers()).resolves.toEqual({ status: 'unauthenticated' });

    stubFetch(new Response('{}', { status: 403 }));
    await expect(fetchAdminUsers()).resolves.toEqual({ status: 'forbidden' });
  });

  it('reports a generic error on 500 and on network failure', async () => {
    stubFetch(new Response('{}', { status: 500 }));
    await expect(fetchAdminUsers()).resolves.toEqual({ status: 'error' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchAdminUsers()).resolves.toEqual({ status: 'error' });
  });

  it('reports a generic error on a non-JSON body', async () => {
    stubFetch(new Response('<html>nope</html>', { status: 200 }));
    await expect(fetchAdminUsers()).resolves.toEqual({ status: 'error' });
  });
});

describe('account operations — request shape', () => {
  it('creates a user with role fixed to "user" and no client-chosen role', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await createAdminUser({
      username: 'newuser',
      name: 'New User',
      email: 'new@example.com',
      password: 'password-123',
    });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ADMIN_CREATE_USER_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['role']).toBe('user');
    expect((body['data'] as Record<string, unknown>)['username']).toBe('newuser');
    // The account must be immediately usable in an MVP with no email verification.
    expect((body['data'] as Record<string, unknown>)['emailVerified']).toBe(true);
  });

  it('never sends admin authority or identity claims', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await createAdminUser({ username: 'u', name: 'U', email: 'u@example.com', password: 'p' });
    await disableAdminUser('target-id');
    await deleteAdminUser('target-id');

    for (const call of fetchStub.mock.calls) {
      const body = String((call[1] as RequestInit).body);
      // `role` is only ever the literal "user"; no other identity field is present.
      expect(body).not.toContain('x-role');
      for (const forbidden of ['isAdmin', 'x-user-id', 'authenticated']) {
        expect(body).not.toContain(forbidden);
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if ('role' in parsed) {
        expect(parsed['role']).toBe('user');
      }
    }
  });

  it('disables an account through ban-user with a reason', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await disableAdminUser('uid-1');

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ADMIN_BAN_USER_ENDPOINT);
    expect(init.body).toBe(
      JSON.stringify({ userId: 'uid-1', banReason: 'Disabled by administrator' }),
    );
  });

  it('enables an account through unban-user', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await enableAdminUser('uid-2');

    expect(fetchStub.mock.calls[0]?.[0]).toBe(ADMIN_UNBAN_USER_ENDPOINT);
    expect((fetchStub.mock.calls[0] as [string, RequestInit])[1].body).toBe(
      JSON.stringify({ userId: 'uid-2' }),
    );
  });

  it('resets a password through set-user-password', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await resetAdminUserPassword('uid-3', 'brand-new-password');

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ADMIN_SET_PASSWORD_ENDPOINT);
    expect(init.body).toBe(JSON.stringify({ userId: 'uid-3', newPassword: 'brand-new-password' }));
  });

  it('deletes an account through remove-user', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await deleteAdminUser('uid-4');

    expect(fetchStub.mock.calls[0]?.[0]).toBe(ADMIN_REMOVE_USER_ENDPOINT);
    expect((fetchStub.mock.calls[0] as [string, RequestInit])[1].body).toBe(
      JSON.stringify({ userId: 'uid-4' }),
    );
  });
});

describe('account operations — outcome classification', () => {
  it.each([
    [200, 'ok'],
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'notfound'],
    [500, 'error'],
  ] as const)('maps HTTP %i to %s', async (status, expected) => {
    stubFetch(new Response('{}', { status }));

    await expect(disableAdminUser('x')).resolves.toEqual({ status: expected });
  });

  it('reports a generic error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(deleteAdminUser('x')).resolves.toEqual({ status: 'error' });
  });

  it('does not surface Better Auth error messages to callers', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'You cannot ban yourself', code: 'YOU_CANNOT_BAN_YOURSELF' }), {
        status: 400,
      }),
    );

    const outcome = await disableAdminUser('self');

    expect(outcome).toEqual({ status: 'invalid' });
    // The raw code/message must not be forwarded as part of the outcome.
    expect(JSON.stringify(outcome)).not.toContain('YOU_CANNOT_BAN_YOURSELF');
    expect(JSON.stringify(outcome)).not.toContain('ban yourself');
  });
});
