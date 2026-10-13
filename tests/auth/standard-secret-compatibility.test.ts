import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../../src/db/auth.js';
import { createApp } from '../../src/server/app.js';
import { resolveRuntimeConfig } from '../../src/server/runtime-config.js';
import { resolveAuthSecret, AUTH_SECRET_FILENAME } from '../../src/server/auth-secret.js';
import { createFirstRunSetup } from '../../src/server/first-run-setup.js';
import { createTempDatabase, type TempDatabase } from '../helpers/temp-database.js';

const ORIGIN = 'https://nav.example.com';
const LEGACY_SECRET = 's'.repeat(31);
const INPUT = { username: 'legacyadmin', name: 'Legacy Admin', email: 'legacy@example.com', password: 'legacy-password-123' };
let temp: TempDatabase;
beforeEach(() => { temp = createTempDatabase({ baseURL: ORIGIN, useSecureCookies: true }); });
afterEach(() => temp.dispose());

function settings(mode = 'standard') {
  return resolveRuntimeConfig({ NODE_ENV: 'production', INSTALL_MODE: mode,
    BETTER_AUTH_URL: mode === 'standard' ? ORIGIN : 'http://192.168.1.100:3000',
    BETTER_AUTH_SECRET: LEGACY_SECRET, DATABASE_PATH: temp.handle.sqlite.name, UPLOADS_DIR: join(temp.directory, 'uploads') });
}

describe('standard legacy authentication secret', () => {
  it('keeps an existing 31-character key and signed session across candidate auth recreation', async () => {
    const legacyAuth = createAuth({ db: temp.handle.db, secret: LEGACY_SECRET, baseURL: ORIGIN, useSecureCookies: true });
    await legacyAuth.api.createUser({ body: { ...INPUT, role: 'admin', data: { username: INPUT.username } } });
    const originalUsers = temp.handle.sqlite.prepare('SELECT * FROM user').all();
    const originalAccounts = temp.handle.sqlite.prepare('SELECT * FROM account').all();
    const login = await createApp({ db: temp.handle.db, auth: legacyAuth }).request(`${ORIGIN}/api/auth/sign-in/username`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(INPUT),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('__Secure-better-auth.session_token='))!.split(';')[0]!;
    const config = settings();
    const secret = resolveAuthSecret(config, true);
    expect(secret).toBe(LEGACY_SECRET);
    expect(existsSync(join(config.uploadsDir, AUTH_SECRET_FILENAME))).toBe(false);
    const nextAuth = createAuth({ db: temp.handle.db, secret, baseURL: ORIGIN, useSecureCookies: true });
    const app = createApp({ db: temp.handle.db, auth: nextAuth,
      setup: createFirstRunSetup(temp.handle, nextAuth, ORIGIN, () => {}) });
    expect(await (await app.request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } })).json()).toMatchObject({ user: { username: INPUT.username, role: 'admin' } });
    expect((await app.request(`${ORIGIN}/api/admin/branding`, { headers: { cookie } })).status).toBe(200);
    expect(temp.handle.sqlite.prepare('SELECT * FROM user').all()).toEqual(originalUsers);
    expect(temp.handle.sqlite.prepare('SELECT * FROM account').all()).toEqual(originalAccounts);
  });
  it('refuses legacy short-key LAN migration with an actionable error and no key or account changes', async () => {
    await temp.auth.api.createUser({ body: { ...INPUT, role: 'admin', data: { username: INPUT.username } } });
    const originalUsers = temp.handle.sqlite.prepare('SELECT * FROM user').all();
    const originalAccounts = temp.handle.sqlite.prepare('SELECT * FROM account').all();
    expect(() => settings('lan-http')).toThrow(/keep standard HTTPS mode with the original key/);
    expect(existsSync(join(temp.directory, 'uploads', AUTH_SECRET_FILENAME))).toBe(false);
    expect(temp.handle.sqlite.prepare('SELECT * FROM user').all()).toEqual(originalUsers);
    expect(temp.handle.sqlite.prepare('SELECT * FROM account').all()).toEqual(originalAccounts);
    expect(settings().authSecret).toBe(LEGACY_SECRET);
  });
});
