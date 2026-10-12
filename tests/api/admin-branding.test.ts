import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { siteSettings } from '../../src/db/schema.js';
import { createApp } from '../../src/server/app.js';
import { ASSET_LIMITS, BRAND_ASSET_URL_PREFIX, brandingDir, validateAssetUpload } from '../../src/server/branding.js';
import { createTempDatabase, TEST_AUTH_BASE_URL, type TempDatabase } from '../helpers/temp-database.js';

const BASE = TEST_AUTH_BASE_URL;
const ADMIN_PASSWORD = 'admin-password-123';
const USER_PASSWORD = 'user-password-123';

let temp: TempDatabase;
let uploadsDir: string;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

function app(): ReturnType<typeof createApp> {
  return createApp({ db: temp.handle.db, auth: temp.auth });
}

/** Real magic-byte payloads, not just extensions. */
const PNG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(7)]);
const JPEG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array(64).fill(7)]);
const WEBP_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, ...Array(32).fill(7),
]);
const ICO_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, ...Array(64).fill(7)]);
const SVG_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('<html><body>not an image</body></html>');

function send(
  method: string,
  path: string,
  options: {
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: string;
    omitContentType?: boolean;
    form?: FormData;
  } = {},
): Promise<Response> {
  const headers = new Headers({ 'x-forwarded-for': nextIp(), ...options.headers });

  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }

  if (options.form !== undefined) {
    // Let the runtime set the multipart boundary.
    headers.delete('content-type');
    return Promise.resolve(
      app().request(`${BASE}${path}`, { method, headers, body: options.form }),
    );
  }

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }

  if (
    !['GET', 'HEAD'].includes(method) &&
    options.omitContentType !== true &&
    !headers.has('content-type')
  ) {
    headers.set('content-type', 'application/json');
  }

  return Promise.resolve(
    app().request(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body }) }),
  );
}

function uploadForm(bytes: Uint8Array<ArrayBuffer>, name: string, type: string): FormData {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }));
  return form;
}

async function provision(username: string, role: 'admin' | 'user'): Promise<void> {
  await temp.auth.api.createUser({
    body: {
      email: `${username}@example.com`,
      password: role === 'admin' ? ADMIN_PASSWORD : USER_PASSWORD,
      name: username,
      role,
      data: { username, emailVerified: true },
    },
  });
}

async function login(username: string, password: string): Promise<string> {
  const response = await app().request(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ username, password }),
  });

  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('better-auth.session_token='));

  if (session === undefined) {
    throw new Error('no session cookie');
  }

  return session.split(';')[0] ?? '';
}

interface Branding {
  siteName: string;
  tagline: string | null;
  logoPath: string | null;
  faviconPath: string | null;
  primaryColor: string | null;
  pageBackgroundColor: string | null;
  surfaceColor: string | null;
  backgroundImagePath: string | null;
  defaultTheme: string;
  footerText: string | null;
  accessMode?: string;
}

async function adminBranding(cookie: string): Promise<Branding> {
  const response = await send('GET', '/api/admin/branding', { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as Branding;
}

async function publicBranding(): Promise<Branding> {
  const response = await send('GET', '/api/public/branding');
  expect(response.status).toBe(200);
  return (await response.json()) as Branding;
}

function settingsRows() {
  return temp.handle.db.select().from(siteSettings).all();
}

function brandingFiles(): string[] {
  const dir = brandingDir(uploadsDir);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Valid full settings payload, overridable per test. */
function settingsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteName: '导航',
    tagline: null,
    primaryColor: null,
    defaultTheme: 'light',
    footerText: null,
    accessMode: 'public',
    ...overrides,
  };
}

beforeEach(async () => {
  temp = createTempDatabase();
  uploadsDir = mkdtempSync(join(tmpdir(), 'bnp-branding-'));
  process.env.UPLOADS_DIR = uploadsDir;

  await provision('admina', 'admin');
  await provision('normalb', 'user');

  // Most tests want a clean slate with no settings row.
  temp.handle.db.delete(siteSettings).run();
});

afterEach(() => {
  temp.dispose();
  rmSync(uploadsDir, { recursive: true, force: true });
  delete process.env.UPLOADS_DIR;
});

describe('branding authorization boundary', () => {
  it('returns 401 to a guest and 403 to a non-admin', async () => {
    expect((await send('GET', '/api/admin/branding')).status).toBe(401);

    const userCookie = await login('normalb', USER_PASSWORD);
    expect((await send('GET', '/api/admin/branding', { cookie: userCookie })).status).toBe(403);
  });

  it('rejects spoofed identity on read and write', async () => {
    const spoofs: Record<string, string>[] = [
      { 'x-role': 'admin' },
      { 'x-user-id': '1' },
      { 'x-authenticated': 'true' },
      { 'x-forwarded-user': 'admina' },
      { 'x-forwarded-role': 'admin' },
    ];

    for (const headers of spoofs) {
      expect((await send('GET', '/api/admin/branding', { headers })).status, JSON.stringify(headers)).toBe(401);
      expect(
        (await send('PUT', '/api/admin/branding', { headers, body: settingsPayload() })).status,
        JSON.stringify(headers),
      ).toBe(401);
    }

    expect((await send('GET', '/api/admin/branding?role=admin')).status).toBe(401);
    expect((await send('GET', '/api/admin/branding', { cookie: 'better-auth.session_token=forged' })).status).toBe(401);
  });

  it('does not let a body role field grant access to a non-admin', async () => {
    const userCookie = await login('normalb', USER_PASSWORD);

    const response = await send('PUT', '/api/admin/branding', {
      cookie: userCookie,
      body: settingsPayload({ role: 'admin' }),
    });

    expect(response.status).toBe(403);
    expect(settingsRows()).toHaveLength(0);
  });

  it('enforces the JSON media type on the settings write', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('PUT', '/api/admin/branding', {
      cookie,
      rawBody: 'siteName=X',
      headers: { 'content-type': 'text/plain' },
    });

    expect(response.status).toBe(415);
    expect(settingsRows()).toHaveLength(0);
  });
});

describe('branding defaults and single-row behavior', () => {
  it('returns safe defaults to both admin and public before any row exists', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const admin = await adminBranding(cookie);
    expect(admin.siteName).toBe('导航');
    expect(admin.defaultTheme).toBe('light');
    expect(admin.accessMode).toBe('public');
    expect(admin.logoPath).toBeNull();

    const publicView = await publicBranding();
    expect(publicView.siteName).toBe('导航');
    expect(settingsRows()).toHaveLength(0);
  });

  it('creates exactly one row on first save and updates it thereafter', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const first = await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ siteName: 'First' }),
    });
    expect(first.status).toBe(200);
    expect(settingsRows()).toHaveLength(1);

    const second = await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ siteName: 'Second' }),
    });
    expect(second.status).toBe(200);
    expect(settingsRows()).toHaveLength(1);
    expect((await adminBranding(cookie)).siteName).toBe('Second');
  });

  it('reads the first row by ascending id when several somehow exist', async () => {
    temp.handle.db.insert(siteSettings).values({ siteName: 'Oldest', sortOrder: 0 } as never).run();
    temp.handle.db.insert(siteSettings).values({ siteName: 'Newer' }).run();

    expect((await publicBranding()).siteName).toBe('Oldest');
  });
});

describe('branding validation', () => {
  it.each([
    ['empty siteName', { siteName: '   ' }],
    ['oversized siteName', { siteName: 'x'.repeat(101) }],
    ['invalid primaryColor', { primaryColor: 'red' }],
    ['CSS injection attempt', { primaryColor: 'red; background: url(x)' }],
    ['short hex', { primaryColor: '#fff' }],
    ['invalid defaultTheme', { defaultTheme: 'blue' }],
    ['invalid accessMode', { accessMode: 'everyone' }],
    ['oversized tagline', { tagline: 'x'.repeat(501) }],
    ['oversized footer', { footerText: 'x'.repeat(501) }],
  ])('rejects %s', async (_label, override) => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload(override),
    });

    expect(response.status).toBe(400);
  });

  it('accepts a valid #RRGGBB color and canonicalizes it', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ primaryColor: '#2f6feb' }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Branding).primaryColor).toBe('#2F6FEB');
  });

  it('treats blank optional text as null', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ tagline: '   ', footerText: '' }),
    });

    const body = (await response.json()) as Branding;
    expect(body.tagline).toBeNull();
    expect(body.footerText).toBeNull();
  });

  it('ignores client-supplied logoPath and faviconPath', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ logoPath: '/etc/passwd', faviconPath: '../../x.png' }),
    });

    const body = (await response.json()) as Branding;
    expect(body.logoPath).toBeNull();
    expect(body.faviconPath).toBeNull();
  });
});

describe('public branding read', () => {
  it('works with no session and exposes no accessMode', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('PUT', '/api/admin/branding', { cookie, body: settingsPayload({ siteName: 'Public Brand' }) });

    const body = await send('GET', '/api/public/branding');
    expect(body.status).toBe(200);
    const parsed = (await body.json()) as Branding;

    expect(parsed.siteName).toBe('Public Brand');
    expect('accessMode' in parsed).toBe(false);
  });

  it('exposes no navigation, user, or admin data', async () => {
    const payload = JSON.stringify(await (await send('GET', '/api/public/branding')).json());

    for (const forbidden of ['categories', 'links', 'user', 'role', 'id', 'createdAt', 'updatedAt']) {
      expect(payload, forbidden).not.toContain(forbidden);
    }
  });

  it('stays readable under login_required while navigation is protected', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ accessMode: 'login_required', siteName: 'Protected Brand' }),
    });

    expect((await send('GET', '/api/public/navigation')).status).toBe(401);

    const branding = await send('GET', '/api/public/branding');
    expect(branding.status).toBe(200);
    expect(((await branding.json()) as Branding).siteName).toBe('Protected Brand');
  });
});

describe('accessMode is wired to the security boundary', () => {
  it('enforces and then restores guest access', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    // Public by default.
    expect((await send('GET', '/api/public/navigation')).status).toBe(200);

    await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ accessMode: 'login_required' }),
    });
    expect((await send('GET', '/api/public/navigation')).status).toBe(401);

    // An authenticated user still receives navigation.
    const userCookie = await login('normalb', USER_PASSWORD);
    expect((await send('GET', '/api/public/navigation', { cookie: userCookie })).status).toBe(200);

    await send('PUT', '/api/admin/branding', { cookie, body: settingsPayload({ accessMode: 'public' }) });
    expect((await send('GET', '/api/public/navigation')).status).toBe(200);
  });
});

describe('upload authorization precedence', () => {
  it.each(['logo', 'favicon'])('returns 401 to a guest on %s with no media type', async (kind) => {
    const response = await send('POST', `/api/admin/branding/${kind}`, { omitContentType: true });
    expect(response.status).toBe(401);
  });

  it.each(['logo', 'favicon'])('returns 403 to a non-admin on %s with no media type', async (kind) => {
    const cookie = await login('normalb', USER_PASSWORD);
    const response = await send('POST', `/api/admin/branding/${kind}`, { cookie, omitContentType: true });
    expect(response.status).toBe(403);
  });

  it.each(['logo', 'favicon'])('returns 415 to an admin on %s with the wrong media type', async (kind) => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const response = await send('POST', `/api/admin/branding/${kind}`, {
      cookie,
      rawBody: 'x',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(415);
  });

  it('rejects spoofed identity on upload', async () => {
    const response = await send('POST', '/api/admin/branding/logo', {
      headers: { 'x-role': 'admin' },
      form: uploadForm(PNG_BYTES, 'x.png', 'image/png'),
    });

    expect(response.status).toBe(401);
    expect(brandingFiles()).toHaveLength(0);
  });

  it('requires a file field for an authorized admin', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const form = new FormData();
    form.append('notfile', 'x');

    const response = await send('POST', '/api/admin/branding/logo', { cookie, form });

    expect(response.status).toBe(400);
  });
});

describe('upload validation', () => {
  async function upload(kind: string, cookie: string, bytes: Uint8Array<ArrayBuffer>, name: string, type: string) {
    return send('POST', `/api/admin/branding/${kind}`, {
      cookie,
      form: uploadForm(bytes, name, type),
    });
  }

  it.each([
    ['PNG', PNG_BYTES, 'image/png'],
    ['JPEG', JPEG_BYTES, 'image/jpeg'],
    ['WebP', WEBP_BYTES, 'image/webp'],
  ])('accepts a valid %s logo', async (_label, bytes, type) => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await upload('logo', cookie, bytes, 'logo.png', type);

    expect(response.status).toBe(201);
    const body = (await response.json()) as Branding;
    expect(body.logoPath?.startsWith(BRAND_ASSET_URL_PREFIX)).toBe(true);
  });

  it.each([
    ['PNG', PNG_BYTES, 'image/png'],
    ['ICO', ICO_BYTES, 'image/x-icon'],
  ])('accepts a valid %s favicon', async (_label, bytes, type) => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await upload('favicon', cookie, bytes, 'favicon.ico', type);

    expect(response.status).toBe(201);
  });

  it('rejects SVG for both logo and favicon', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    expect((await upload('logo', cookie, SVG_BYTES, 'x.svg', 'image/svg+xml')).status).toBe(400);
    expect((await upload('favicon', cookie, SVG_BYTES, 'x.svg', 'image/svg+xml')).status).toBe(400);
    expect(brandingFiles()).toHaveLength(0);
  });

  it('rejects HTML content declared as an image', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    // Extension and declared MIME both say PNG; the bytes are HTML.
    expect((await upload('logo', cookie, HTML_BYTES, 'evil.png', 'image/png')).status).toBe(400);
    expect(brandingFiles()).toHaveLength(0);
  });

  it('rejects real image bytes declared with the wrong MIME', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    expect((await upload('logo', cookie, PNG_BYTES, 'x.png', 'text/html')).status).toBe(400);
    expect((await upload('logo', cookie, JPEG_BYTES, 'x.jpg', 'image/png')).status).toBe(400);
  });

  it('rejects a JPEG favicon (not in the allowed set)', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    expect((await upload('favicon', cookie, JPEG_BYTES, 'x.jpg', 'image/jpeg')).status).toBe(400);
  });

  it('rejects an empty file', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    expect((await upload('logo', cookie, new Uint8Array([]), 'x.png', 'image/png')).status).toBe(400);
  });

  it('rejects an oversized logo', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG_BYTES.subarray(0, 8));

    expect((await upload('logo', cookie, big, 'big.png', 'image/png')).status).toBe(400);
    expect(brandingFiles()).toHaveLength(0);
  });

  it('rejects an oversized favicon', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const big = new Uint8Array(512 * 1024 + 1);
    big.set(PNG_BYTES.subarray(0, 8));

    expect((await upload('favicon', cookie, big, 'big.png', 'image/png')).status).toBe(400);
  });
});

describe('filename and path safety', () => {
  it('ignores the original filename entirely, including traversal', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    const response = await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(PNG_BYTES, '../../outside.png', 'image/png'),
    });

    expect(response.status).toBe(201);

    const files = brandingFiles();
    expect(files).toHaveLength(1);
    // Server-generated UUID name; the client's name is discarded.
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(files[0]).not.toContain('outside');

    // Nothing escaped the branding directory.
    expect(existsSync(join(uploadsDir, 'outside.png'))).toBe(false);
    expect(existsSync(join(uploadsDir, '..', 'outside.png'))).toBe(false);

    const body = (await response.json()) as Branding;
    expect(body.logoPath).toBe(`${BRAND_ASSET_URL_PREFIX}${files[0] ?? ''}`);
  });

  it('stores an application URL rather than a filesystem path', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(PNG_BYTES, 'x.png', 'image/png'),
    });

    const stored = settingsRows()[0]?.logoPath ?? '';
    expect(stored.startsWith(BRAND_ASSET_URL_PREFIX)).toBe(true);
    expect(stored).not.toContain(uploadsDir);
    expect(stored).not.toContain(':');
    expect(stored).not.toContain('\\');
  });
});

describe('asset serving', () => {
  it('serves a stored asset with a controlled content type and nosniff', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(PNG_BYTES, 'x.png', 'image/png'),
    });

    const filename = brandingFiles()[0] ?? '';
    const response = await send('GET', `/api/public/brand-assets/${filename}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('immutable');

    const served = new Uint8Array(await response.arrayBuffer());
    expect(served).toEqual(PNG_BYTES);
  });

  it('serves assets even when access mode is login_required', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(PNG_BYTES, 'x.png', 'image/png'),
    });
    await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ accessMode: 'login_required' }),
    });

    const filename = brandingFiles()[0] ?? '';
    expect((await send('GET', `/api/public/brand-assets/${filename}`)).status).toBe(200);
  });

  it.each([
    ['missing file', '00000000-0000-0000-0000-000000000000.png'],
    ['not generated shape', 'evil.png'],
    ['traversal', '..%2F..%2Fdata%2Fnav.sqlite'],
    ['plain traversal', '....//etc/passwd'],
    ['absolute-ish', 'C:%5CWindows%5Cwin.ini'],
    ['wrong extension', 'file.svg'],
    ['no extension', 'file'],
  ])('returns 404 for %s', async (_label, filename) => {
    const response = await send('GET', `/api/public/brand-assets/${filename}`);

    expect(response.status).toBe(404);
  });

  it('does not serve a file placed outside the branding directory', async () => {
    // Simulate an attacker-planted file with a valid-looking generated name.
    const decoy = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
    writeFileSync(join(uploadsDir, decoy), PNG_BYTES);
    mkdirSync(brandingDir(uploadsDir), { recursive: true });

    const response = await send('GET', `/api/public/brand-assets/${decoy}`);
    expect(response.status).toBe(404);
  });
});

describe('replacement and removal', () => {
  it('replaces a logo with a new generated asset and removes the old file', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);

    await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(PNG_BYTES, 'a.png', 'image/png'),
    });
    const firstPath = (await adminBranding(cookie)).logoPath ?? '';
    const firstFile = firstPath.slice(BRAND_ASSET_URL_PREFIX.length);

    await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(JPEG_BYTES, 'b.jpg', 'image/jpeg'),
    });

    const secondPath = (await adminBranding(cookie)).logoPath ?? '';
    const secondFile = secondPath.slice(BRAND_ASSET_URL_PREFIX.length);

    expect(secondFile).not.toBe(firstFile);
    expect(secondFile.endsWith('.jpg')).toBe(true);
    // Only the new asset remains on disk.
    expect(brandingFiles()).toEqual([secondFile]);
    expect(existsSync(join(brandingDir(uploadsDir), firstFile))).toBe(false);
  });

  it('clears the path and removes the file on explicit removal', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('POST', '/api/admin/branding/favicon', {
      cookie,
      form: uploadForm(ICO_BYTES, 'f.ico', 'image/x-icon'),
    });
    expect(brandingFiles()).toHaveLength(1);

    const response = await send('DELETE', '/api/admin/branding/favicon', { cookie });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Branding).faviconPath).toBeNull();
    expect(brandingFiles()).toHaveLength(0);
  });

  it('requires authorization before removal media validation', async () => {
    expect((await send('DELETE', '/api/admin/branding/logo', { omitContentType: true })).status).toBe(401);

    const userCookie = await login('normalb', USER_PASSWORD);
    expect(
      (await send('DELETE', '/api/admin/branding/logo', { cookie: userCookie, omitContentType: true })).status,
    ).toBe(403);

    const cookie = await login('admina', ADMIN_PASSWORD);
    expect(
      (await send('DELETE', '/api/admin/branding/logo', { cookie, omitContentType: true })).status,
    ).toBe(415);
  });

  it('never deletes an arbitrary path stored in the database', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    // Write a hostile path directly, bypassing the API's field filtering.
    temp.handle.db.insert(siteSettings).values({ siteName: 'X', logoPath: '/etc/passwd' }).run();
    const victim = join(uploadsDir, 'victim.txt');
    writeFileSync(victim, 'important');

    const response = await send('DELETE', '/api/admin/branding/logo', { cookie });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Branding).logoPath).toBeNull();
    // The unrelated file is untouched.
    expect(existsSync(victim)).toBe(true);
  });

  it('leaves the old database value intact when storage fails', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(PNG_BYTES, 'a.png', 'image/png'),
    });
    const original = (await adminBranding(cookie)).logoPath;

    // Force the database update to fail after the new file is written by making
    // the branding directory itself a file, so writeFileSync throws first —
    // proving no partial state is committed either way.
    const dir = brandingDir(uploadsDir);
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');

    const response = await send('POST', '/api/admin/branding/logo', {
      cookie,
      form: uploadForm(JPEG_BYTES, 'b.jpg', 'image/jpeg'),
    });

    expect(response.status).toBe(500);
    // Database still points at the previously stored value.
    expect((await adminBranding(cookie)).logoPath).toBe(original);
  });
});

describe('branding does not touch other data', () => {
  it('does not create navigation rows', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('PUT', '/api/admin/branding', { cookie, body: settingsPayload({ siteName: 'Branded' }) });

    const { publicCategories, publicLinks } = await import('../../src/db/schema.js');
    expect(temp.handle.db.select().from(publicCategories).all()).toHaveLength(0);
    expect(temp.handle.db.select().from(publicLinks).all()).toHaveLength(0);
  });
});

describe('BRP1.1 colors and background assets', () => {
  const endpoint = '/api/admin/branding/background';

  it('returns null defaults and preserves omitted colors from the existing settings form', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    for (const defaults of [await adminBranding(cookie), await publicBranding()]) {
      expect(defaults).toMatchObject({ pageBackgroundColor: null, surfaceColor: null, backgroundImagePath: null });
    }
    expect(await publicBranding()).not.toHaveProperty('accessMode');

    const saved = await send('PUT', '/api/admin/branding', {
      cookie,
      body: settingsPayload({ primaryColor: ' #abcdef ', pageBackgroundColor: ' #123abc ', surfaceColor: '#aabbcc' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ primaryColor: '#ABCDEF', pageBackgroundColor: '#123ABC', surfaceColor: '#AABBCC' });
    expect(await publicBranding()).toMatchObject({ pageBackgroundColor: '#123ABC', surfaceColor: '#AABBCC' });

    expect((await send('PUT', '/api/admin/branding', { cookie, body: settingsPayload() })).status).toBe(200);
    expect(await adminBranding(cookie)).toMatchObject({ pageBackgroundColor: '#123ABC', surfaceColor: '#AABBCC' });
    expect((await send('PUT', '/api/admin/branding', {
      cookie, body: settingsPayload({ pageBackgroundColor: null, surfaceColor: '  ' }),
    })).status).toBe(200);
    expect(await adminBranding(cookie)).toMatchObject({ pageBackgroundColor: null, surfaceColor: null });
  });

  it('rejects unsafe values for all editable colors without changing settings', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('PUT', '/api/admin/branding', { cookie, body: settingsPayload() });
    const before = settingsRows();
    const invalid = ['#abc', '#12345678', 'red', 'rgb(1,2,3)', 'hsl(0,0%,0%)', 'var(--x)',
      'url(https://evil.example/x)', '#123456!important', '#123456; color:red', 123, {}, []];
    for (const field of ['primaryColor', 'pageBackgroundColor', 'surfaceColor']) {
      for (const value of invalid) {
        expect((await send('PUT', '/api/admin/branding', {
          cookie, body: settingsPayload({ [field]: value }),
        })).status, `${field}: ${JSON.stringify(value)}`).toBe(400);
      }
    }
    expect(settingsRows()).toEqual(before);
    expect(brandingFiles()).toEqual([]);
  });

  it('checks admin authorization before multipart or removal media validation', async () => {
    const userCookie = await login('normalb', USER_PASSWORD);
    const cookie = await login('admina', ADMIN_PASSWORD);
    for (const method of ['POST', 'DELETE']) {
      expect((await send(method, endpoint, { omitContentType: true })).status).toBe(401);
      expect((await send(method, endpoint, { headers: { 'x-role': 'admin' }, omitContentType: true })).status).toBe(401);
      expect((await send(method, endpoint, { cookie: userCookie, omitContentType: true })).status).toBe(403);
      expect((await send(method, endpoint, { cookie, omitContentType: true })).status).toBe(415);
    }
    expect(settingsRows()).toEqual([]);
    expect(brandingFiles()).toEqual([]);
  });

  it('uploads, safely serves and replaces all allowed formats, then removes only the background', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('POST', '/api/admin/branding/logo', { cookie, form: uploadForm(PNG_BYTES, 'logo.png', 'image/png') });
    await send('POST', '/api/admin/branding/favicon', { cookie, form: uploadForm(ICO_BYTES, 'f.ico', 'image/x-icon') });
    const otherAssets = await adminBranding(cookie);
    let previousPath: string | null = null;
    for (const [bytes, mime, extension] of [
      [PNG_BYTES, 'image/png', 'png'], [JPEG_BYTES, 'image/jpeg', 'jpg'], [WEBP_BYTES, 'image/webp', 'webp'],
    ] as const) {
      const response = await send('POST', endpoint, { cookie, form: uploadForm(bytes, '../../outside.svg', mime) });
      expect(response.status).toBe(201);
      const result = (await response.json()) as Branding;
      const path = result.backgroundImagePath!;
      expect(path).toMatch(new RegExp(`^${BRAND_ASSET_URL_PREFIX}[0-9a-f-]{36}\\.${extension}$`));
      expect(path).not.toBe(previousPath);
      expect(result.logoPath).toBe(otherAssets.logoPath);
      expect(result.faviconPath).toBe(otherAssets.faviconPath);
      expect(brandingFiles()).toHaveLength(3);
      if (previousPath !== null) {
        expect(existsSync(join(brandingDir(uploadsDir), previousPath.slice(BRAND_ASSET_URL_PREFIX.length)))).toBe(false);
        expect((await send('GET', previousPath)).status).toBe(404);
      }
      const served = await send('GET', path);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe(mime);
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
      expect(await publicBranding()).toMatchObject({ backgroundImagePath: path });
      previousPath = path;
    }

    for (const injected of ['https://evil.example/background.png', '/etc/passwd', null]) {
      expect((await send('PUT', '/api/admin/branding', {
        cookie, body: settingsPayload({ backgroundImagePath: injected }),
      })).status).toBe(200);
      expect((await adminBranding(cookie)).backgroundImagePath).toBe(previousPath);
    }
    const removed = await send('DELETE', endpoint, { cookie });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ backgroundImagePath: null, logoPath: otherAssets.logoPath, faviconPath: otherAssets.faviconPath });
    expect((await publicBranding()).backgroundImagePath).toBeNull();
    expect(brandingFiles()).toHaveLength(2);
    expect((await send('GET', previousPath!)).status).toBe(404);
  });

  it('rejects missing, multiple, remote, unsafe or oversized files without writes', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const invalidForms = [new FormData()];
    const remote = new FormData();
    remote.append('file', 'https://evil.example/background.png');
    invalidForms.push(remote);
    const repeated = uploadForm(PNG_BYTES, 'a.png', 'image/png');
    repeated.append('file', new File([JPEG_BYTES], 'b.jpg', { type: 'image/jpeg' }));
    invalidForms.push(repeated);
    const extra = uploadForm(PNG_BYTES, 'a.png', 'image/png');
    extra.append('other', new File([PNG_BYTES], 'b.png', { type: 'image/png' }));
    invalidForms.push(extra);
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    oversized.set(PNG_BYTES);
    for (const [bytes, mime] of [
      [PNG_BYTES, 'text/html'], [PNG_BYTES, 'image/jpeg'], [HTML_BYTES, 'image/png'],
      [ICO_BYTES, 'image/x-icon'], [SVG_BYTES, 'image/svg+xml'],
      [new TextEncoder().encode('GIF89a'), 'image/gif'], [new Uint8Array([1, 2, 3]), 'image/png'],
      [new Uint8Array(), 'image/png'], [oversized, 'image/png'],
    ] as const) {
      invalidForms.push(uploadForm(bytes, 'background.png', mime));
    }
    for (const form of invalidForms) {
      expect((await send('POST', endpoint, { cookie, form })).status).toBe(400);
      expect(settingsRows()).toEqual([]);
      expect(brandingFiles()).toEqual([]);
    }
    // The shared validator also measures actual bytes, independently of declared size.
    await expect(validateAssetUpload('background', {
      type: 'image/png', size: 1, arrayBuffer: () => Promise.resolve(oversized.buffer),
    })).rejects.toThrow('file is too large');
  });

  it('accepts exactly 5 MiB without relaxing the existing logo limit', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    expect(ASSET_LIMITS.background.maxBytes).toBe(5 * 1024 * 1024);
    expect(ASSET_LIMITS.logo.maxBytes).toBe(2 * 1024 * 1024);
    const bytes = new Uint8Array(ASSET_LIMITS.background.maxBytes);
    bytes.set(PNG_BYTES);
    const uploaded = await send('POST', endpoint, { cookie, form: uploadForm(bytes, 'limit.png', 'image/png') });
    expect(uploaded.status).toBe(201);
    const path = ((await uploaded.json()) as Branding).backgroundImagePath!;
    expect((await (await send('GET', path)).arrayBuffer()).byteLength).toBe(bytes.byteLength);
    expect((await send('POST', '/api/admin/branding/logo', {
      cookie, form: uploadForm(bytes, 'too-big-logo.png', 'image/png'),
    })).status).toBe(400);
    expect(brandingFiles()).toHaveLength(1);
  });

  it('cleans a newly written file on real DB failure and retains the old reference/file on failed removal', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    await send('POST', endpoint, { cookie, form: uploadForm(PNG_BYTES, 'a.png', 'image/png') });
    const before = settingsRows();
    const filesBefore = brandingFiles();
    const oldPath = before[0]!.backgroundImagePath!;
    temp.handle.sqlite.exec("CREATE TRIGGER fail_background BEFORE UPDATE OF background_image_path ON site_settings BEGIN SELECT RAISE(ABORT, 'forced-background-db-failure'); END");
    try {
      const replacement = await send('POST', endpoint, { cookie, form: uploadForm(JPEG_BYTES, 'b.jpg', 'image/jpeg') });
      expect(replacement.status).toBe(500);
      expect(await replacement.text()).not.toContain('forced-background-db-failure');
      expect(settingsRows()).toEqual(before);
      expect(brandingFiles()).toEqual(filesBefore);
      expect((await send('DELETE', endpoint, { cookie })).status).toBe(500);
      expect(settingsRows()).toEqual(before);
      expect(brandingFiles()).toEqual(filesBefore);
      expect((await send('GET', oldPath)).status).toBe(200);
    } finally {
      temp.handle.sqlite.exec('DROP TRIGGER fail_background');
    }
  });

  it('never deletes an unmanaged background path', async () => {
    const cookie = await login('admina', ADMIN_PASSWORD);
    const victim = join(uploadsDir, 'victim.txt');
    writeFileSync(victim, 'important');
    temp.handle.db.insert(siteSettings).values({ siteName: 'X', backgroundImagePath: victim }).run();
    const removed = await send('DELETE', endpoint, { cookie });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ backgroundImagePath: null });
    expect(existsSync(victim)).toBe(true);
  });
});
