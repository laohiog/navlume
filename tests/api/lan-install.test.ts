import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../../src/db/auth.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import { createFirstRunSetup } from '../../src/server/first-run-setup.js';
import { bootstrapAdmin } from '../../src/server/bootstrap-admin.js';
import { AUTH_SECRET_FILENAME, resolveAuthSecret } from '../../src/server/auth-secret.js';
import { INITIALIZATION_CLOSED_ID, isInitializationClosed } from '../../src/server/setup-state.js';
import { resolveRuntimeConfig } from '../../src/server/runtime-config.js';
import { createPhysicalBackup, restorePhysicalBackup } from '../../src/server/backup-restore.js';
import { createTempDatabase, TEST_AUTH_SECRET, type TempDatabase } from '../helpers/temp-database.js';

const ORIGIN = 'http://192.168.1.100:3000';
const INPUT = { username: 'nasadmin', email: 'admin@example.com', password: 'nas-password-123' };
let temp: TempDatabase;
beforeEach(() => { temp = createTempDatabase({ baseURL: ORIGIN, useSecureCookies: false }); });
afterEach(() => temp.dispose());
function config(overrides: NodeJS.ProcessEnv = {}) {
  return resolveRuntimeConfig({ NODE_ENV: 'production', INSTALL_MODE: 'lan-http', BETTER_AUTH_URL: ORIGIN,
    DATABASE_PATH: temp.handle.sqlite.name, UPLOADS_DIR: join(temp.directory, 'uploads'), ...overrides });
}
function start(database: DatabaseHandle = temp.handle, lanHttp = true) {
  const origin = lanHttp ? ORIGIN : 'https://nav.example.com';
  const auth = createAuth({ db: database.db, secret: TEST_AUTH_SECRET, baseURL: origin, useSecureCookies: !lanHttp });
  const logs: string[] = [];
  const setup = createFirstRunSetup(database, auth, origin, (line) => logs.push(line), Date.now, lanHttp);
  return { app: createApp({ db: database.db, auth, setup }), logs, origin };
}
function submit(app: ReturnType<typeof createApp>, body: unknown = INPUT, origin: string | null = ORIGIN, target = ORIGIN) {
  return app.request(`${target}/api/setup/admin`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(origin === null ? {} : { origin }),
  }, body: JSON.stringify(body) });
}
async function status(app: ReturnType<typeof createApp>, origin = ORIGIN) {
  return (await app.request(`${origin}/api/setup/status`)).json();
}

describe('explicit LAN configuration', () => {
  it('fails closed on unknown modes, non-private origins, aliases, or missing standard secret', () => {
    expect(config().authSecret).toBe('');
    expect(() => config({ INSTALL_MODE: 'LAN' })).toThrow(/INSTALL_MODE/);
    expect(() => config({ INSTALL_MODE: 'standard' })).toThrow(/SECRET/);
    for (const url of ['http://8.8.8.8', 'http://172.15.0.1', 'http://172.32.0.1', 'http://localhost',
      'http://127.0.0.1', 'http://nas.local', 'http://[fd00::1]', 'https://192.168.1.1', `${ORIGIN}/`,
      `${ORIGIN}?x=1`, `${ORIGIN}#x`, 'http://user@192.168.1.1', 'http://0xc0a80101', 'http://192.168.001.1']) {
      expect(() => config({ BETTER_AUTH_URL: url }), url).toThrow();
    }
    for (const url of ['http://10.0.0.1', 'http://172.16.0.1:8080', 'http://172.31.255.255', 'http://192.168.0.1']) {
      expect(config({ BETTER_AUTH_URL: url }).lanHttp).toBe(true);
    }
    expect(() => config({ BETTER_AUTH_TRUSTED_ORIGINS: 'http://evil.example' })).toThrow(/trusted origins/);
    expect(() => config({ BETTER_AUTH_SECRET: 'short' })).toThrow(/32/);
  });
});

describe('published initialization routes in LAN mode', () => {
  it('creates without a code using published fields, closes replay, and keeps signup disabled', async () => {
    const { app, logs } = start();
    expect(logs).toEqual([]);
    expect(await status(app)).toEqual({ needsSetup: true, requiresCode: false });
    expect((await submit(app)).status).toBe(201);
    expect((await submit(app)).status).toBe(409);
    expect(await status(app)).toEqual({ needsSetup: false, requiresCode: false });
    const signup = await app.request(`${ORIGIN}/api/auth/sign-up/email`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(INPUT) });
    expect(signup.status).toBeGreaterThanOrEqual(400);
    expect((await app.request(`${ORIGIN}/api/setup`)).status).toBe(404);
  });
  it('serializes eight concurrent requests into one administrator and credential', async () => {
    const { app } = start();
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => submit(app, {
      ...INPUT, username: `admin${i}`, email: `admin${i}@example.com`,
    })));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
    expect(temp.handle.sqlite.prepare('SELECT COUNT(*) n FROM user').get()).toEqual({ n: 1 });
    expect(temp.handle.sqlite.prepare('SELECT COUNT(*) n FROM account').get()).toEqual({ n: 1 });
  });
  it('rejects missing/forged Origin, Host aliases, forwarding and injected privileges', async () => {
    const { app } = start();
    for (const origin of [null, 'null', 'http://evil.example', 'http://192.168.1.101:3000', `${ORIGIN}/`]) {
      expect((await submit(app, INPUT, origin)).status).toBe(403);
    }
    const forwarded = await app.request('http://evil.example/api/setup/admin', { method: 'POST', headers: {
      origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-host': '192.168.1.100:3000', 'x-forwarded-proto': 'http',
    }, body: JSON.stringify(INPUT) });
    expect(forwarded.status).toBe(403);
    for (const body of [null, [], {}, { ...INPUT, role: 'admin' }, { ...INPUT, userId: 'other' },
      { ...INPUT, setupCode: 123 }, { ...INPUT, password: 'short' }, { ...INPUT, email: 'bad' }]) {
      expect((await submit(app, body)).status).toBe(400);
    }
    expect((await submit(app, { ...INPUT, extra: 'x'.repeat(4096) })).status).toBe(413);
    expect(isInitializationClosed(temp.handle)).toBe(false);
  });
  it('persists closure across deleting all users, reopening SQLite, and CLI retry', async () => {
    const { app } = start();
    expect((await submit(app)).status).toBe(201);
    temp.handle.sqlite.exec('DELETE FROM user');
    expect((await submit(app)).status).toBe(409);
    const restarted = createDatabase(temp.handle.sqlite.name);
    try {
      const next = start(restarted);
      expect(next.logs).toEqual([]);
      expect(await status(next.app)).toMatchObject({ needsSetup: false });
      expect((await submit(next.app)).status).toBe(409);
      expect((await bootstrapAdmin(restarted, { ...INPUT, name: INPUT.username }, TEST_AUTH_SECRET, ORIGIN)).status).toBe('refused');
    } finally { restarted.close(); }
  });
  it.each(['user', 'admin'] as const)('adopts existing %s users and stays closed after deletion', async (role) => {
    await temp.auth.api.createUser({ body: { ...INPUT, name: INPUT.username, role, data: { username: INPUT.username } } });
    const rows = temp.handle.sqlite.prepare('SELECT * FROM user').all();
    const { app } = start();
    expect(await status(app)).toMatchObject({ needsSetup: false });
    expect(temp.handle.sqlite.prepare('SELECT * FROM user').all()).toEqual(rows);
    temp.handle.sqlite.exec('DELETE FROM user');
    expect((await submit(start().app)).status).toBe(409);
  });
  it('rolls back credentials too if the completion marker cannot be saved', async () => {
    temp.handle.sqlite.exec(`CREATE TRIGGER fail_marker BEFORE INSERT ON verification
      WHEN NEW.id = '${INITIALIZATION_CLOSED_ID}' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const { app } = start();
    expect((await submit(app)).status).toBe(400);
    expect(temp.handle.sqlite.prepare('SELECT COUNT(*) n FROM user').get()).toEqual({ n: 0 });
    expect(temp.handle.sqlite.prepare('SELECT COUNT(*) n FROM account').get()).toEqual({ n: 0 });
    expect(isInitializationClosed(temp.handle)).toBe(false);
    temp.handle.sqlite.exec('DROP TRIGGER fail_marker');
    expect((await submit(app)).status).toBe(201);
  });
  it('produces non-Secure HttpOnly/Lax cookies for login, logout and relogin', async () => {
    const { app } = start(); await submit(app);
    const signin = () => app.request(`${ORIGIN}/api/auth/sign-in/username`, { method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(INPUT) });
    const login = await signin(); expect(login.status).toBe(200);
    const header = login.headers.getSetCookie().find((v) => v.startsWith('better-auth.session_token='))!;
    expect(header).not.toContain('Secure'); expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Lax');
    const cookie = header.split(';')[0]!;
    const session = () => app.request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } });
    expect(await (await session()).json()).toMatchObject({ user: { username: INPUT.username, role: 'admin' } });
    expect((await app.request(`${ORIGIN}/api/admin/branding`, { headers: { cookie } })).status).toBe(200);
    expect((await app.request(`${ORIGIN}/api/auth/sign-out`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect(await (await session()).json()).toBeNull(); expect((await signin()).status).toBe(200);
  });
  it('preserves standard status/body fields, code gating, and Secure cookies', async () => {
    const { app, logs, origin } = start(temp.handle, false);
    expect(await status(app, origin)).toEqual({ needsSetup: true });
    expect((await submit(app, INPUT, origin, origin)).status).toBe(400);
    const setupCode = logs[0]!.split(': ').at(-1)!;
    const created = await submit(app, { ...INPUT, setupCode }, origin, origin);
    expect(created.status).toBe(201); expect(await created.json()).toEqual({ status: 'created' });
    const login = await app.request(`${origin}/api/auth/sign-in/username`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(INPUT) });
    expect(login.status).toBe(200);
    const header = login.headers.getSetCookie().find((v) => v.startsWith('__Secure-better-auth.session_token='))!;
    expect(header).toContain('Secure'); expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Lax');
  });
});

describe('private secret and v1 recovery', () => {
  it('preserves a random key and closure through pre/post-init physical backup restore', async () => {
    const settings = config(); const secret = resolveAuthSecret(settings, false);
    expect(secret.length).toBeGreaterThanOrEqual(32); expect(resolveAuthSecret(settings, false)).toBe(secret);
    const backupRoot = join(temp.directory, 'backups');
    const preinit = await createPhysicalBackup({ databasePath: settings.databasePath, uploadsDir: settings.uploadsDir, backupRoot });
    expect((await bootstrapAdmin(temp.handle, { ...INPUT, name: INPUT.username }, secret, ORIGIN)).status).toBe('created');
    temp.handle.sqlite.exec('DELETE FROM user');
    const postinit = await createPhysicalBackup({ databasePath: settings.databasePath, uploadsDir: settings.uploadsDir, backupRoot });
    expect(preinit.status).toBe('ok'); expect(postinit.status).toBe('ok');
    if (preinit.status !== 'ok' || postinit.status !== 'ok') return;
    expect(postinit.manifest.format_version).toBe(1);
    const databasePath = join(temp.directory, 'recovered.sqlite'), uploadsDir = join(temp.directory, 'recovered-uploads');
    for (const [backup, closed] of [[postinit, true], [preinit, false]] as const) {
      expect((await restorePhysicalBackup({ backupDir: backup.backupDir, databasePath, uploadsDir })).status).toBe('ok');
      const recovered = createDatabase(databasePath);
      try {
        expect(isInitializationClosed(recovered)).toBe(closed);
        expect(resolveAuthSecret({ ...settings, databasePath, uploadsDir }, closed)).toBe(secret);
        expect((await bootstrapAdmin(recovered, { ...INPUT, name: INPUT.username }, secret, ORIGIN)).status).toBe(closed ? 'refused' : 'created');
      } finally { recovered.close(); }
    }
  });
  it('refuses corrupt, missing, mismatched or public-readable keys, even after all users disappear', async () => {
    const settings = config(), path = join(settings.uploadsDir, AUTH_SECRET_FILENAME);
    const secret = resolveAuthSecret(settings, false);
    expect(readFileSync(path, 'utf8').trim()).toBe(secret);
    expect(() => resolveAuthSecret(config({ BETTER_AUTH_SECRET: TEST_AUTH_SECRET }), true)).toThrow(/differs/);
    writeFileSync(path, 'corrupt'); expect(() => resolveAuthSecret(settings, false)).toThrow(/invalid/);
    rmSync(path); resolveAuthSecret(config({ BETTER_AUTH_SECRET: secret }), false);
    expect((await bootstrapAdmin(temp.handle, { ...INPUT, name: INPUT.username }, secret, ORIGIN)).status).toBe('created');
    temp.handle.sqlite.exec('DELETE FROM user'); rmSync(path);
    expect(() => resolveAuthSecret(settings, isInitializationClosed(temp.handle))).toThrow(/completed initialization/);
    expect(resolveAuthSecret(config({ BETTER_AUTH_SECRET: secret }), true)).toBe(secret);
    if (process.platform !== 'win32') { chmodSync(path, 0o644); expect(() => resolveAuthSecret(settings, true)).toThrow(/private/); }
  });
  it('retains an existing supplied key and never serves it as a public brand asset', async () => {
    await temp.auth.api.createUser({ body: { ...INPUT, name: INPUT.username, role: 'admin', data: { username: INPUT.username } } });
    const rows = temp.handle.sqlite.prepare('SELECT * FROM account').all();
    expect(resolveAuthSecret(config({ BETTER_AUTH_SECRET: TEST_AUTH_SECRET }), isInitializationClosed(temp.handle))).toBe(TEST_AUTH_SECRET);
    expect(temp.handle.sqlite.prepare('SELECT * FROM account').all()).toEqual(rows);
    expect((await start().app.request(`${ORIGIN}/api/public/brand-assets/.auth-secret`)).status).toBe(404);
  });
});
