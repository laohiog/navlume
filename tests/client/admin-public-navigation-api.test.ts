import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_PUBLIC_CATEGORIES_ENDPOINT,
  ADMIN_PUBLIC_LINKS_ENDPOINT,
  ADMIN_PUBLIC_NAVIGATION_ENDPOINT,
  createAdminPublicCategory,
  createAdminPublicLink,
  deleteAdminPublicCategory,
  deleteAdminPublicLink,
  fetchAdminPublicNavigation,
  reorderAdminPublicCategories,
  reorderAdminPublicLinks,
  updateAdminPublicCategory,
  updateAdminPublicLink,
} from '../../src/client/api/admin-public-navigation.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchStub = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const PAYLOAD = {
  categories: [
    {
      id: 1,
      name: 'Visible',
      icon: null,
      sortOrder: 0,
      isVisible: true,
      links: [
        { id: 10, categoryId: 1, title: 'A', url: 'https://a.example.com/', description: null, iconUrl: null, sortOrder: 0, isVisible: true },
      ],
    },
    {
      id: 2,
      name: 'Hidden',
      icon: null,
      sortOrder: 1,
      isVisible: false,
      links: [
        { id: 20, categoryId: 2, title: 'B', url: 'https://b.example.com/', description: null, iconUrl: null, sortOrder: 0, isVisible: false },
      ],
    },
  ],
};

describe('fetchAdminPublicNavigation', () => {
  it('requests the same-origin admin endpoint and returns ok data', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(PAYLOAD), { status: 200 }));

    const result = await fetchAdminPublicNavigation();

    expect(fetchStub.mock.calls[0]?.[0]).toBe(ADMIN_PUBLIC_NAVIGATION_ENDPOINT);
    expect(ADMIN_PUBLIC_NAVIGATION_ENDPOINT).toBe('/api/admin/public-navigation');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.categories).toHaveLength(2);
      expect(result.data.categories[1]?.isVisible).toBe(false);
    }
  });

  it('separates unauthenticated (401) from forbidden (403)', async () => {
    stubFetch(new Response('{}', { status: 401 }));
    await expect(fetchAdminPublicNavigation()).resolves.toEqual({ status: 'unauthenticated' });

    stubFetch(new Response('{}', { status: 403 }));
    await expect(fetchAdminPublicNavigation()).resolves.toEqual({ status: 'forbidden' });
  });

  it('reports a generic error on 500 and network failure', async () => {
    stubFetch(new Response('{}', { status: 500 }));
    await expect(fetchAdminPublicNavigation()).resolves.toEqual({ status: 'error' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchAdminPublicNavigation()).resolves.toEqual({ status: 'error' });
  });
});

describe('admin mutations — request shape', () => {
  it('creates a category with JSON content type and no identity fields', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 201 }));

    await createAdminPublicCategory({ name: '新分类', isVisible: true });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ADMIN_PUBLIC_CATEGORIES_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');

    const body = String(init.body);
    expect(body).toBe(JSON.stringify({ name: '新分类', isVisible: true }));
    // Authorization must never be asserted by the client.
    for (const forbidden of ['role', 'userId', 'isAdmin', 'admin']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('never sends a client-controlled sortOrder or id', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 201 }));

    await createAdminPublicCategory({ name: 'X' });

    const body = String((fetchStub.mock.calls[0] as [string, RequestInit])[1].body);
    expect(body).not.toContain('sortOrder');
    expect(body).not.toContain('"id"');
  });

  it('PATCHes a category by id', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await updateAdminPublicCategory(7, { name: 'Renamed', isVisible: false });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_PUBLIC_CATEGORIES_ENDPOINT}/7`);
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ name: 'Renamed', isVisible: false }));
  });

  it('DELETEs a category with a JSON content type despite having no body', async () => {
    const fetchStub = stubFetch(new Response(null, { status: 204 }));

    const outcome = await deleteAdminPublicCategory(3);

    expect(outcome).toEqual({ status: 'ok' });
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_PUBLIC_CATEGORIES_ENDPOINT}/3`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it('PUTs the full category id list for reorder', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await reorderAdminPublicCategories([3, 1, 2]);

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_PUBLIC_CATEGORIES_ENDPOINT}/order`);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ ids: [3, 1, 2] }));
  });

  it('creates a link with categoryId/title/url', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 201 }));

    await createAdminPublicLink({ categoryId: 1, title: 'T', url: 'example.com' });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ADMIN_PUBLIC_LINKS_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ categoryId: 1, title: 'T', url: 'example.com' }));
  });

  it('PATCHes a link, including a category move', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await updateAdminPublicLink(10, { categoryId: 2, isVisible: false });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_PUBLIC_LINKS_ENDPOINT}/10`);
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ categoryId: 2, isVisible: false }));
  });

  it('DELETEs a link with a JSON content type', async () => {
    const fetchStub = stubFetch(new Response(null, { status: 204 }));

    await deleteAdminPublicLink(10);

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_PUBLIC_LINKS_ENDPOINT}/10`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('PUTs the category id and full link id list for reorder', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await reorderAdminPublicLinks(5, [20, 10]);

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_PUBLIC_LINKS_ENDPOINT}/order`);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ categoryId: 5, ids: [20, 10] }));
  });
});

describe('admin mutations — outcome classification', () => {
  it.each([
    [200, 'ok'],
    [201, 'ok'],
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'notfound'],
    [409, 'error'],
    [500, 'error'],
  ] as const)('maps HTTP %i to %s', async (status, expected) => {
    stubFetch(new Response('{}', { status }));

    const outcome = await createAdminPublicCategory({ name: 'x' });

    expect(outcome.status).toBe(expected);
  });

  it('treats a body-less 204 as ok', async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(deleteAdminPublicCategory(1)).resolves.toEqual({ status: 'ok' });
  });

  it('reports a generic error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(deleteAdminPublicLink(1)).resolves.toEqual({ status: 'error' });
  });

  it('distinguishes forbidden from unauthenticated for a normal user', async () => {
    stubFetch(new Response('{}', { status: 403 }));

    // A 403 must not be treated as "log in again" by the caller.
    await expect(createAdminPublicCategory({ name: 'x' })).resolves.toEqual({ status: 'forbidden' });
  });
});
