import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_BRANDING_ENDPOINT,
  FALLBACK_BRANDING,
  PUBLIC_BRANDING_ENDPOINT,
  fetchAdminBranding,
  fetchPublicBranding,
  removeBrandFavicon,
  removeBrandLogo,
  removeBrandBackground,
  updateAdminBranding,
  uploadBrandFavicon,
  uploadBrandLogo,
  uploadBrandBackground,
} from '../../src/client/api/admin-branding.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchStub = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const SETTINGS = {
  pageBackgroundColor: null,
  surfaceColor: null,
  backgroundImagePath: null,
  siteName: '导航',
  tagline: null,
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  defaultTheme: 'light',
  footerText: null,
  accessMode: 'public',
};

describe('fetchPublicBranding', () => {
  it('requests the public endpoint and returns ok data', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(SETTINGS), { status: 200 }));

    const result = await fetchPublicBranding();

    expect(fetchStub.mock.calls[0]?.[0]).toBe(PUBLIC_BRANDING_ENDPOINT);
    expect(PUBLIC_BRANDING_ENDPOINT).toBe('/api/public/branding');
    expect(result.status).toBe('ok');
  });

  it('returns a generic error on failure so callers can fall back', async () => {
    stubFetch(new Response('{}', { status: 500 }));
    await expect(fetchPublicBranding()).resolves.toEqual({ status: 'error' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchPublicBranding()).resolves.toEqual({ status: 'error' });
  });

  it('exposes a safe fallback that keeps navigation usable', () => {
    expect(FALLBACK_BRANDING.siteName).toBe('导航');
    expect(FALLBACK_BRANDING.defaultTheme).toBe('light');
    expect(FALLBACK_BRANDING.logoPath).toBeNull();
    expect(FALLBACK_BRANDING.pageBackgroundColor).toBeNull();
    expect(FALLBACK_BRANDING.surfaceColor).toBeNull();
    expect(FALLBACK_BRANDING.backgroundImagePath).toBeNull();
  });
});

describe('fetchAdminBranding', () => {
  it('separates unauthenticated (401) from forbidden (403)', async () => {
    stubFetch(new Response('{}', { status: 401 }));
    await expect(fetchAdminBranding()).resolves.toEqual({ status: 'unauthenticated' });

    stubFetch(new Response('{}', { status: 403 }));
    await expect(fetchAdminBranding()).resolves.toEqual({ status: 'forbidden' });
  });

  it('returns ok settings for an admin', async () => {
    stubFetch(new Response(JSON.stringify(SETTINGS), { status: 200 }));

    const result = await fetchAdminBranding();

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.accessMode).toBe('public');
    }
  });
});

describe('updateAdminBranding', () => {
  it('PUTs JSON settings without any asset path or identity field', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(SETTINGS), { status: 200 }));

    await updateAdminBranding({
      siteName: 'Brand',
      tagline: 'T',
      primaryColor: '#2F6FEB',
      defaultTheme: 'dark',
      footerText: 'F',
      accessMode: 'login_required',
    });

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ADMIN_BRANDING_ENDPOINT);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');

    const body = String(init.body);
    // Asset paths are server-owned and must never be sent from the client.
    expect(body).not.toContain('logoPath');
    expect(body).not.toContain('faviconPath');
    expect(body).not.toContain('backgroundImagePath');
    expect(JSON.parse(body)).not.toHaveProperty('pageBackgroundColor');
    expect(JSON.parse(body)).not.toHaveProperty('surfaceColor');
    for (const forbidden of ['role', 'userId', 'isAdmin']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('classifies failure statuses', async () => {
    for (const [status, expected] of [
      [400, 'invalid'],
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [500, 'error'],
    ] as const) {
      stubFetch(new Response('{}', { status }));
      await expect(
        updateAdminBranding({
          siteName: 'x',
          tagline: null,
          primaryColor: null,
          defaultTheme: 'light',
          footerText: null,
          accessMode: 'public',
        }),
      ).resolves.toEqual({ status: expected });
    }
  });

  it('sends optional colors including explicit null and returns all new fields', async () => {
    const settings = { ...SETTINGS, pageBackgroundColor: '#123456', surfaceColor: null, backgroundImagePath: '/api/public/brand-assets/example.webp' };
    const fetchStub = stubFetch(new Response(JSON.stringify(settings), { status: 200 }));
    const result = await updateAdminBranding({ siteName: 'Brand', tagline: null, primaryColor: null,
      pageBackgroundColor: '#123456', surfaceColor: null, footerText: null,
      defaultTheme: 'light', accessMode: 'public' });
    const init = fetchStub.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ pageBackgroundColor: '#123456', surfaceColor: null });
    expect(init.credentials).toBe('same-origin');
    expect(result).toEqual({ status: 'ok', data: settings });
  });
});

describe('brand asset upload and removal', () => {
  it('uploads a logo as multipart without forcing a content type', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(SETTINGS), { status: 201 }));
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });

    await uploadBrandLogo(file);

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_BRANDING_ENDPOINT}/logo`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    // The browser must set the multipart boundary itself.
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('uploads a favicon to its own endpoint', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(SETTINGS), { status: 201 }));

    await uploadBrandFavicon(new File([new Uint8Array([1])], 'f.ico', { type: 'image/x-icon' }));

    expect(fetchStub.mock.calls[0]?.[0]).toBe(`${ADMIN_BRANDING_ENDPOINT}/favicon`);
  });

  it('removes assets with a JSON content type', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(SETTINGS), { status: 200 }));

    await removeBrandLogo();

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_BRANDING_ENDPOINT}/logo`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('removes the favicon from its own endpoint', async () => {
    const fetchStub = stubFetch(new Response(JSON.stringify(SETTINGS), { status: 200 }));

    await removeBrandFavicon();

    expect(fetchStub.mock.calls[0]?.[0]).toBe(`${ADMIN_BRANDING_ENDPOINT}/favicon`);
  });

  it('reports a generic error when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(removeBrandLogo()).resolves.toEqual({ status: 'error' });
    await expect(uploadBrandLogo(new File([], 'x.png'))).resolves.toEqual({ status: 'error' });
  });

  it('uploads and removes the background through the existing asset contract', async () => {
    const settings = { ...SETTINGS, backgroundImagePath: '/api/public/brand-assets/example.webp' };
    const file = new File([new Uint8Array([1])], 'background.webp', { type: 'image/webp' });
    const fetchStub = stubFetch(new Response(JSON.stringify(settings), { status: 201 }));
    await expect(uploadBrandBackground(file)).resolves.toEqual({ status: 'ok', data: settings });
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADMIN_BRANDING_ENDPOINT}/background`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(Array.from((init.body as FormData).entries())).toEqual([['file', file]]);

    const removeFetch = stubFetch(new Response(JSON.stringify(SETTINGS), { status: 200 }));
    await expect(removeBrandBackground()).resolves.toEqual({ status: 'ok', data: SETTINGS });
    const [removeUrl, removeInit] = removeFetch.mock.calls[0] as [string, RequestInit];
    expect(removeUrl).toBe(url);
    expect(removeInit.method).toBe('DELETE');
    expect(removeInit.credentials).toBe('same-origin');
    expect((removeInit.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('classifies background authorization, validation and network failures', async () => {
    for (const [status, expected] of [[400, 'invalid'], [401, 'unauthenticated'], [403, 'forbidden'], [500, 'error']] as const) {
      stubFetch(new Response('{}', { status }));
      await expect(uploadBrandBackground(new File([], 'x.png'))).resolves.toEqual({ status: expected });
      stubFetch(new Response('{}', { status }));
      await expect(removeBrandBackground()).resolves.toEqual({ status: expected });
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(uploadBrandBackground(new File([], 'x.png'))).resolves.toEqual({ status: 'error' });
    await expect(removeBrandBackground()).resolves.toEqual({ status: 'error' });
  });
});
