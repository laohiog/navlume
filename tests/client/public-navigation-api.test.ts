import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_NAVIGATION_ENDPOINT,
  fetchPublicNavigation,
} from '../../src/client/api/public-navigation.js';

const PAYLOAD = {
  site: {
    id: 1,
    siteName: 'Example Navigation',
    tagline: null,
    logoPath: null,
    faviconPath: null,
    primaryColor: null,
    defaultTheme: 'light',
    footerText: null,
    accessMode: 'public',
  },
  categories: [
    {
      id: 1,
      name: 'Example',
      icon: null,
      sortOrder: 0,
      links: [
        {
          id: 1,
          title: 'Example Domain',
          url: 'https://example.com',
          description: null,
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

describe('fetchPublicNavigation', () => {
  it('requests the same-origin public API path and returns ok data', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchPublicNavigation();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(PUBLIC_NAVIGATION_ENDPOINT);
    expect(PUBLIC_NAVIGATION_ENDPOINT).toBe('/api/public/navigation');
    expect(PUBLIC_NAVIGATION_ENDPOINT).not.toContain('localhost');

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.categories[0]?.links[0]?.title).toBe('Example Domain');
    }
  });

  it('returns the safe empty payload as ok data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ site: null, categories: [] }), { status: 200 }),
      ),
    );

    await expect(fetchPublicNavigation()).resolves.toEqual({
      status: 'ok',
      data: { site: null, categories: [] },
    });
  });

  it('reports unauthenticated (not an error) on HTTP 401 without reading the body', async () => {
    const body = { error: 'Authentication Required', categories: [{ id: 1, name: 'Secret' }] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status: 401 }),
      ),
    );

    const result = await fetchPublicNavigation();

    // The rejected response body must not be surfaced as navigation data.
    expect(result).toEqual({ status: 'unauthenticated' });
    expect(JSON.stringify(result)).not.toContain('Secret');
  });

  it('reports a generic error on a non-2xx, non-401 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 }),
      ),
    );

    await expect(fetchPublicNavigation()).resolves.toEqual({ status: 'error' });
  });

  it('reports a generic error on network failure without inventing data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(fetchPublicNavigation()).resolves.toEqual({ status: 'error' });
  });
});
