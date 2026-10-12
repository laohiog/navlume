import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createTempDatabase, type TempDatabase } from '../helpers/temp-database.js';

let temp: TempDatabase;
/** Isolated static root used to exercise production serving. */
let staticRoot: string;

beforeEach(() => {
  temp = createTempDatabase();
  staticRoot = join(temp.directory, 'client');
});

afterEach(() => {
  temp.dispose();
});

/** A minimal built client: an index shell plus one hashed asset. */
function writeStaticClient(): void {
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(
    join(staticRoot, 'index.html'),
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(staticRoot, 'assets', 'app.js'), 'console.log("app");');
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

describe('health endpoint', () => {
  it('returns 200 with a minimal status body for a working database', async () => {
    const app = createApp({ db: temp.handle.db, auth: temp.auth });

    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('requires no authentication', async () => {
    const app = createApp({ db: temp.handle.db, auth: temp.auth });

    // No cookie, no headers: a deployment probe must not need credentials.
    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
  });

  it('leaks no internal details', async () => {
    const app = createApp({ db: temp.handle.db, auth: temp.auth });

    const text = await (await app.request('/api/health')).text();

    expect(text).toBe('{"status":"ok"}');
    // No path, secret, environment, count, or version information.
    expect(text).not.toContain('nav.sqlite');
    expect(text).not.toContain(temp.directory);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('SELECT');
  });

  it('returns 503 unhealthy when the database becomes unusable', async () => {
    const app = createApp({ db: temp.handle.db, auth: temp.auth });

    // Closing the underlying connection makes the health query fail, which is the
    // same observable condition as a database that has become unavailable.
    temp.handle.close();

    const response = await app.request('/api/health');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: 'unhealthy' });
  });

  it('does not expose the database error when unhealthy', async () => {
    const app = createApp({ db: temp.handle.db, auth: temp.auth });
    temp.handle.close();

    const text = await (await app.request('/api/health')).text();

    expect(text).toBe('{"status":"unhealthy"}');
    expect(text).not.toContain(temp.directory);
  });
});

/* -------------------------------------------------------------------------- */
/* Production static serving                                                   */
/* -------------------------------------------------------------------------- */

describe('production static serving', () => {
  it('serves the built index for GET /', async () => {
    writeStaticClient();
    const app = createApp({ db: temp.handle.db, auth: temp.auth, staticRoot });

    const response = await app.request('/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('<div id="root">');
  });

  it('serves built assets', async () => {
    writeStaticClient();
    const app = createApp({ db: temp.handle.db, auth: temp.auth, staticRoot });

    const response = await app.request('/assets/app.js');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('console.log');
  });

  it('falls back to the SPA shell for a client-side route', async () => {
    writeStaticClient();
    const app = createApp({ db: temp.handle.db, auth: temp.auth, staticRoot });

    const response = await app.request('/some/client/route');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('<div id="root">');
  });

  it('keeps unknown API paths as JSON 404, never the SPA shell', async () => {
    writeStaticClient();
    const app = createApp({ db: temp.handle.db, auth: temp.auth, staticRoot });

    const response = await app.request('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    // The critical assertion: an API client must never receive HTML.
    const body = await response.text();
    expect(body).not.toContain('<div id="root">');
    expect(JSON.parse(body)).toEqual({ error: 'Not Found' });
  });

  it('keeps every registered API route reachable ahead of static serving', async () => {
    writeStaticClient();
    const app = createApp({ db: temp.handle.db, auth: temp.auth, staticRoot });

    const health = await app.request('/api/health');
    const navigation = await app.request('/api/public/navigation');

    expect(health.status).toBe(200);
    expect(navigation.status).toBe(200);
    // A route that returns JSON must not be shadowed by the SPA fallback.
    await expect(navigation.json()).resolves.toHaveProperty('categories');
  });
});

/* -------------------------------------------------------------------------- */
/* Backwards compatibility                                                     */
/* -------------------------------------------------------------------------- */

describe('without a static root', () => {
  it('preserves the existing JSON 404 for unmatched routes', async () => {
    const app = createApp({ db: temp.handle.db, auth: temp.auth });

    const rootResponse = await app.request('/');

    expect(rootResponse.status).toBe(404);
    await expect(rootResponse.json()).resolves.toEqual({ error: 'Not Found' });

    const routeResponse = await app.request('/some/client/route');

    expect(routeResponse.status).toBe(404);
    await expect(routeResponse.json()).resolves.toEqual({ error: 'Not Found' });
  });
});
