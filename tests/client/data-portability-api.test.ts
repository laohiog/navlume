import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PERSONAL_EXPORT_ENDPOINT,
  PERSONAL_IMPORT_APPLY_ENDPOINT,
  PERSONAL_IMPORT_PREVIEW_ENDPOINT,
  SITE_EXPORT_ENDPOINT,
  SITE_IMPORT_APPLY_ENDPOINT,
  SITE_IMPORT_PREVIEW_ENDPOINT,
  applyPersonalImport,
  applySiteImport,
  downloadDocument,
  exportFilename,
  exportPersonalDocument,
  exportSiteDocument,
  parseDocumentText,
  previewPersonalImport,
  previewSiteImport,
  saveJsonFile,
} from '../../src/client/api/data-portability.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(response: Response) {
  const fetchStub = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const SITE_SUMMARY = {
  scope: 'site',
  incomingCategories: 2,
  incomingLinks: 3,
  currentCategories: 1,
  currentLinks: 1,
  brandingUpdated: true,
  assetsPreserved: true,
  replacementWarning: '导入将替换当前的公共导航与品牌文字设置。',
};

const PERSONAL_SUMMARY = {
  scope: 'personal',
  incomingCategories: 1,
  incomingLinks: 1,
  currentCategories: 1,
  currentLinks: 1,
  replacementWarning: '导入将替换当前个人导航。',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

describe('portability endpoints', () => {
  it('exposes the documented same-origin paths', () => {
    expect(SITE_EXPORT_ENDPOINT).toBe('/api/admin/data-export/site');
    expect(SITE_IMPORT_PREVIEW_ENDPOINT).toBe('/api/admin/data-import/site/preview');
    expect(SITE_IMPORT_APPLY_ENDPOINT).toBe('/api/admin/data-import/site/apply');
    expect(PERSONAL_EXPORT_ENDPOINT).toBe('/api/personal/data-export');
    expect(PERSONAL_IMPORT_PREVIEW_ENDPOINT).toBe('/api/personal/data-import/preview');
    expect(PERSONAL_IMPORT_APPLY_ENDPOINT).toBe('/api/personal/data-import/apply');
  });
});

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

describe('downloadDocument', () => {
  it('returns the parsed document and the original text', async () => {
    stubFetch(jsonResponse({ schema_version: 1, type: 'site' }));

    const result = await downloadDocument(SITE_EXPORT_ENDPOINT);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.document['type']).toBe('site');
    expect(JSON.parse(result.text)).toEqual({ schema_version: 1, type: 'site' });
  });

  it('uses same-origin credentials and accepts JSON', async () => {
    const fetchStub = stubFetch(jsonResponse({}));

    await downloadDocument(PERSONAL_EXPORT_ENDPOINT);

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(PERSONAL_EXPORT_ENDPOINT);
    expect(init.credentials).toBe('same-origin');
  });

  it('never sends an identity field', async () => {
    const fetchStub = stubFetch(jsonResponse({}));

    await downloadDocument(PERSONAL_EXPORT_ENDPOINT);

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toContain('user');
    expect(JSON.stringify(init.headers)).not.toContain('role');
  });

  it('distinguishes unauthenticated from forbidden', async () => {
    stubFetch(new Response(null, { status: 401 }));
    expect((await downloadDocument(SITE_EXPORT_ENDPOINT)).status).toBe('unauthenticated');

    stubFetch(new Response(null, { status: 403 }));
    expect((await downloadDocument(SITE_EXPORT_ENDPOINT)).status).toBe('forbidden');
  });

  it('reports a network failure and a non-JSON body as errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await downloadDocument(SITE_EXPORT_ENDPOINT)).status).toBe('error');

    stubFetch(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect((await downloadDocument(SITE_EXPORT_ENDPOINT)).status).toBe('error');
  });

  it('exposes typed wrappers for both scopes', async () => {
    const fetchStub = stubFetch(jsonResponse({ type: 'site' }));
    await exportSiteDocument();
    expect(fetchStub.mock.calls[0]![0]).toBe(SITE_EXPORT_ENDPOINT);

    fetchStub.mockClear();
    fetchStub.mockResolvedValue(jsonResponse({ type: 'personal' }));
    await exportPersonalDocument();
    expect(fetchStub.mock.calls[0]![0]).toBe(PERSONAL_EXPORT_ENDPOINT);
  });
});

/* -------------------------------------------------------------------------- */
/* Parsing pasted text                                                         */
/* -------------------------------------------------------------------------- */

describe('parseDocumentText', () => {
  it('accepts a JSON object', () => {
    const result = parseDocumentText('{"a":1}');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.document).toEqual({ a: 1 });
  });

  it('rejects empty or whitespace-only input', () => {
    for (const text of ['', '   ', '\n\t']) {
      expect(parseDocumentText(text).status).toBe('invalid');
    }
  });

  it('rejects malformed JSON', () => {
    expect(parseDocumentText('{ not json').status).toBe('invalid');
  });

  it('rejects non-object top-level JSON', () => {
    for (const text of ['null', '42', '"text"', '[1,2,3]']) {
      const result = parseDocumentText(text);

      expect(result.status).toBe('invalid');
      if (result.status !== 'invalid') throw new Error('unreachable');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('does not touch the network', () => {
    const fetchStub = stubFetch(jsonResponse({}));

    parseDocumentText('{ not json');

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

describe('preview helpers', () => {
  it('posts the bare document without a confirm flag', async () => {
    const fetchStub = stubFetch(jsonResponse(SITE_SUMMARY));

    const result = await previewSiteImport({ schema_version: 1, type: 'site' });

    expect(result.status).toBe('ok');
    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(SITE_IMPORT_PREVIEW_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({
      document: { schema_version: 1, type: 'site' },
    });
  });

  it('returns the parsed summary', async () => {
    stubFetch(jsonResponse(SITE_SUMMARY));

    const result = await previewSiteImport({});

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.summary).toMatchObject({ scope: 'site', incomingLinks: 3, currentLinks: 1 });
  });

  it('surfaces the server validation message on 400', async () => {
    stubFetch(jsonResponse({ error: 'unsupported schema_version (expected 1)' }, 400));

    const result = await previewSiteImport({});

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.message).toContain('schema_version');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    stubFetch(new Response('nope', { status: 400, headers: { 'content-type': 'text/plain' } }));

    const result = await previewPersonalImport({});

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('classifies 401 and 403 distinctly', async () => {
    stubFetch(new Response(null, { status: 401 }));
    expect((await previewSiteImport({})).status).toBe('unauthenticated');

    stubFetch(new Response(null, { status: 403 }));
    expect((await previewSiteImport({})).status).toBe('forbidden');
  });

  it('reports 500 and network failures as errors', async () => {
    stubFetch(new Response(null, { status: 500 }));
    expect((await previewSiteImport({})).status).toBe('error');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await previewSiteImport({})).status).toBe('error');
  });

  it('posts personal documents to the personal preview endpoint', async () => {
    const fetchStub = stubFetch(jsonResponse(PERSONAL_SUMMARY));

    await previewPersonalImport({ schema_version: 1, type: 'personal' });

    expect(fetchStub.mock.calls[0]![0]).toBe(PERSONAL_IMPORT_PREVIEW_ENDPOINT);
  });
});

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

describe('apply helpers', () => {
  it('always sends confirm: true', async () => {
    const fetchStub = stubFetch(jsonResponse(SITE_SUMMARY));

    await applySiteImport({ schema_version: 1, type: 'site' });

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(SITE_IMPORT_APPLY_ENDPOINT);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['confirm']).toBe(true);
    expect(body['document']).toEqual({ schema_version: 1, type: 'site' });
  });

  it('sends confirm for personal apply too', async () => {
    const fetchStub = stubFetch(jsonResponse(PERSONAL_SUMMARY));

    await applyPersonalImport({ schema_version: 1, type: 'personal' });

    const [path, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(PERSONAL_IMPORT_APPLY_ENDPOINT);
    expect((JSON.parse(init.body as string) as Record<string, unknown>)['confirm']).toBe(true);
  });

  it('returns the summary on success', async () => {
    stubFetch(jsonResponse(PERSONAL_SUMMARY));

    const result = await applyPersonalImport({});

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.summary.currentCategories).toBe(1);
  });

  it('reports a mid-import server failure as an error, not a validation failure', async () => {
    stubFetch(jsonResponse({ error: 'Import Failed' }, 500));

    expect((await applySiteImport({})).status).toBe('error');
  });
});

/* -------------------------------------------------------------------------- */
/* File save                                                                   */
/* -------------------------------------------------------------------------- */

/** Install a stub DOM and blob URL implementation for `saveJsonFile`. */
function stubBrowser() {
  const createObjectURL = vi.fn().mockReturnValue('blob:mock');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

  const click = vi.fn();
  const anchor = { href: '', download: '', rel: '', click, remove: vi.fn() };
  const append = vi.fn();
  const timeouts: (() => void)[] = [];
  const setTimeoutStub = vi.fn((callback: () => void) => {
    timeouts.push(callback);
    return 0;
  });

  vi.stubGlobal('window', {
    document: { createElement: vi.fn().mockReturnValue(anchor), body: { append } },
    setTimeout: setTimeoutStub,
  });
  const blobParts: unknown[] = [];
  vi.stubGlobal(
    'Blob',
    class {
      constructor(content: unknown) {
        blobParts.push(content);
      }
    },
  );

  return { createObjectURL, revokeObjectURL, anchor, click, append, timeouts, blobParts };
}

describe('saveJsonFile', () => {
  it('downloads through a blob URL and revokes it on a later task', () => {
    const browser = stubBrowser();

    saveJsonFile('data.json', '{"a":1}');

    expect(browser.createObjectURL).toHaveBeenCalledTimes(1);
    expect(browser.anchor.download).toBe('data.json');
    expect(browser.anchor.href).toBe('blob:mock');
    expect(browser.append).toHaveBeenCalledTimes(1);
    expect(browser.click).toHaveBeenCalledTimes(1);

    // The revoke must NOT happen synchronously: doing so can abort the download
    // the click just started.
    expect(browser.revokeObjectURL).not.toHaveBeenCalled();

    for (const release of browser.timeouts) {
      release();
    }
    expect(browser.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('never uses a data: URL', () => {
    const browser = stubBrowser();

    saveJsonFile('x.json', '{}');

    expect(browser.anchor.href).toBe('blob:mock');
    expect(browser.anchor.href.startsWith('data:')).toBe(false);
  });

  it('does nothing when blob URLs are unavailable', () => {
    const browser = stubBrowser();
    vi.stubGlobal('URL', {});

    expect(() => saveJsonFile('x.json', '{}')).not.toThrow();
    expect(browser.anchor.click).not.toHaveBeenCalled();
  });

  it('passes the JSON text through unchanged', () => {
    const browser = stubBrowser();

    saveJsonFile('x.json', '{"é":"中文"}');

    // The serialized text is handed to Blob verbatim, so Unicode survives saving.
    expect(JSON.stringify(browser.blobParts)).toContain('中文');
    expect(browser.createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe('exportFilename', () => {
  it('names site and personal exports distinctly and date-stamps them', () => {
    const now = new Date('2026-03-04T05:06:07Z');

    expect(exportFilename('site', now)).toBe('navigation-site-20260304.json');
    expect(exportFilename('personal', now)).toBe('navigation-personal-20260304.json');
  });
});
