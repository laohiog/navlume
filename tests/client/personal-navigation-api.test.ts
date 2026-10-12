import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PERSONAL_CATEGORIES_ENDPOINT,
  PERSONAL_LINKS_ENDPOINT,
  PERSONAL_NAVIGATION_ENDPOINT,
  createPersonalCategory,
  createPersonalLink,
  deletePersonalCategory,
  deletePersonalLink,
  fetchPersonalNavigation,
  reorderPersonalCategories,
  reorderPersonalLinks,
  updatePersonalCategory,
  updatePersonalLink,
} from '../../src/client/api/personal-navigation.js';

const PAYLOAD = {
  categories: [
    {
      id: 1,
      name: '⭐ 我的常用',
      sortOrder: 0,
      isDefault: true,
      links: [
        {
          id: 10,
          title: 'Supplier',
          url: 'example.com:8080/path',
          normalizedUrl: 'https://example.com:8080/path',
          iconUrl: null,
          sortOrder: 0,
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Capture the fetch call and return a stub with the given response. */
function stubFetch(response: Response) {
  const fetchStub = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

describe('fetchPersonalNavigation', () => {
  it('requests the same-origin personal path and returns ok data', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(PAYLOAD), { status: 200 }));

    const result = await fetchPersonalNavigation();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(PERSONAL_NAVIGATION_ENDPOINT);
    expect(PERSONAL_NAVIGATION_ENDPOINT).toBe('/api/personal/navigation');
    expect(PERSONAL_NAVIGATION_ENDPOINT).not.toContain('localhost');

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.categories[0]?.links[0]?.normalizedUrl).toBe(
        'https://example.com:8080/path',
      );
    }
  });

  it('reports unauthenticated on 401 without reading the body', async () => {
    const body = { categories: [{ id: 99, name: 'Secret Category' }] };
    stubFetch(new Response(JSON.stringify(body), { status: 401 }));

    const result = await fetchPersonalNavigation();

    expect(result).toEqual({ status: 'unauthenticated' });
    expect(JSON.stringify(result)).not.toContain('Secret Category');
  });

  it('reports a generic error on 500', async () => {
    stubFetch(new Response('{"error":"Internal Server Error"}', { status: 500 }));

    await expect(fetchPersonalNavigation()).resolves.toEqual({ status: 'error' });
  });

  it('reports a generic error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(fetchPersonalNavigation()).resolves.toEqual({ status: 'error' });
  });

  it('reports a generic error on a non-JSON 200 body', async () => {
    stubFetch(new Response('<html>not json</html>', { status: 200 }));

    await expect(fetchPersonalNavigation()).resolves.toEqual({ status: 'error' });
  });
});

describe('personal mutations — request shape', () => {
  it('POST category sends JSON content type and no ownership field', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 201 }));

    const outcome = await createPersonalCategory('采购');

    expect(outcome).toEqual({ status: 'ok' });
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PERSONAL_CATEGORIES_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: '采购' }));

    // Ownership and URL authority are server-derived; the client must not send them.
    const body = String(init.body);
    for (const forbidden of ['userId', 'ownerId', 'username', 'role', 'normalizedUrl']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('PATCH category targets the id and sends JSON', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await updatePersonalCategory(7, '新名称');

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PERSONAL_CATEGORIES_ENDPOINT}/7`);
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('DELETE category sends JSON content type despite having no body', async () => {
    const fetchStub = stubFetch(new Response(null, { status: 204 }));

    const outcome = await deletePersonalCategory(7);

    expect(outcome).toEqual({ status: 'ok' });
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PERSONAL_CATEGORIES_ENDPOINT}/7`);
    expect(init.method).toBe('DELETE');
    // This is the P3.2 server contract: DELETE must also declare JSON.
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it('PUT category order sends the full id list as JSON', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await reorderPersonalCategories([3, 1, 2]);

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PERSONAL_CATEGORIES_ENDPOINT}/order`);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ ids: [3, 1, 2] }));
  });

  it('POST link sends categoryId/title/url and JSON', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 201 }));

    await createPersonalLink({ categoryId: 1, title: 'Supplier', url: 'example.com:8080/path' });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PERSONAL_LINKS_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({ categoryId: 1, title: 'Supplier', url: 'example.com:8080/path' }),
    );
    expect(String(init.body)).not.toContain('normalizedUrl');
  });

  it('PATCH link sends only the provided fields and JSON', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await updatePersonalLink(10, { categoryId: 2 });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PERSONAL_LINKS_ENDPOINT}/10`);
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ categoryId: 2 }));
  });

  it('DELETE link sends JSON content type', async () => {
    const fetchStub = stubFetch(new Response(null, { status: 204 }));

    const outcome = await deletePersonalLink(10);

    expect(outcome).toEqual({ status: 'ok' });
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PERSONAL_LINKS_ENDPOINT}/10`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('PUT link order sends categoryId and the full id list as JSON', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await reorderPersonalLinks(7, [20, 10]);

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PERSONAL_LINKS_ENDPOINT}/order`);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    // Regression: the server rejects a payload without the owning categoryId.
    expect(init.body).toBe(JSON.stringify({ categoryId: 7, ids: [20, 10] }));
  });

  it('PUT link order includes categoryId for a single-link category', async () => {
    const fetchStub = stubFetch(new Response('{}', { status: 200 }));

    await reorderPersonalLinks(42, [5]);

    const body = JSON.parse(String((fetchStub.mock.calls[0] as [string, RequestInit])[1].body)) as {
      categoryId?: unknown;
      ids?: unknown;
    };
    expect(body.categoryId).toBe(42);
    expect(body.ids).toEqual([5]);
  });
});

describe('personal mutations — outcome classification', () => {
  it.each([
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [404, 'notfound'],
    [409, 'conflict'],
    [415, 'error'],
    [500, 'error'],
  ] as const)('maps HTTP %i to %s', async (status, expected) => {
    stubFetch(new Response('{}', { status }));

    const outcome = await createPersonalCategory('x');

    expect(outcome.status).toBe(expected);
  });

  it('reports a generic error when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(createPersonalLink({ categoryId: 1, title: 't', url: 'u' })).resolves.toEqual({
      status: 'error',
    });
  });

  it('treats 2xx responses as ok', async () => {
    stubFetch(new Response('{}', { status: 200 }));
    await expect(updatePersonalCategory(1, 'n')).resolves.toEqual({ status: 'ok' });
  });
});
