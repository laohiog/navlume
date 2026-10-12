import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createFirstRunSetup } from '../../src/server/first-run-setup.js';
import { bootstrapAdmin } from '../../src/server/bootstrap-admin.js';
import { createTempDatabase, TEST_AUTH_BASE_URL as BASE, TEST_AUTH_SECRET, type TempDatabase } from '../helpers/temp-database.js';

let temp: TempDatabase;
let clock: number;
let logs: string[];
const input = { username: 'firstadmin', email: 'first@example.com', password: 'strong-password-123' };
function start() {
  const setup = createFirstRunSetup(temp.handle, temp.auth, BASE, (message) => logs.push(message), () => clock);
  const app = createApp({ db: temp.handle.db, auth: temp.auth, setup });
  const code = logs.at(-1)?.split(': ').at(-1) ?? '';
  const post = (body: unknown = { ...input, setupCode: code }, headers: Record<string, string> = {}) =>
    app.request(`${BASE}/api/setup/admin`, { method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const status = () => app.request(`${BASE}/api/setup/status`);
  return { app, post, status, code };
}
const users = () => temp.handle.sqlite.prepare('SELECT COUNT(*) total FROM user').get();
beforeEach(() => { temp = createTempDatabase(); clock = 0; logs = []; });
afterEach(() => { vi.restoreAllMocks(); temp.dispose(); });

describe('first-run setup capability', () => {
  it('logs one random 128-bit code only on empty startup and exposes only the boolean', async () => {
    const first = start();
    expect(logs).toHaveLength(1);
    expect(first.code).toMatch(/^[a-f0-9]{32}$/);
    const response = await first.status();
    expect(await response.json()).toEqual({ needsSetup: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(logs).toHaveLength(1);
    const next = start();
    expect(next.code).not.toBe(first.code);
    expect((await next.post({ ...input, setupCode: first.code })).status).toBe(403);
    expect(users()).toEqual({ total: 0 });
  });

  it('creates an admin, logs in through HTTP, manages navigation, and closes replay/restart', async () => {
    const running = start();
    const response = await running.post();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: 'created' });
    expect(await (await running.status()).json()).toEqual({ needsSetup: false });
    expect((await running.post()).status).toBe(409);
    expect(users()).toEqual({ total: 1 });
    const login = await running.app.request(`${BASE}/api/auth/sign-in/username`, {
      method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    expect(login.status).toBe(200);
    expect((await login.json() as { user: { role: string } }).user.role).toBe('admin');
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const adminRead = await running.app.request(`${BASE}/api/admin/public-navigation`, { headers: { cookie } });
    expect(adminRead.status).toBe(200);
    const before = logs.length;
    const restarted = start();
    expect(logs).toHaveLength(before);
    expect(await (await restarted.status()).json()).toEqual({ needsSetup: false });
    expect((await restarted.post()).status).toBe(409);
  });

  it('rejects expired codes without creating users', async () => {
    const running = start(); clock = 60 * 60 * 1000;
    expect(await (await running.post()).json()).toEqual({ error: 'Setup Code Expired' });
    expect(users()).toEqual({ total: 0 });
  });

  it('limits wrong attempts per instance even when forwarded IPs change, then recovers', async () => {
    const running = start();
    for (let i = 0; i < 5; i++) {
      expect((await running.post({ ...input, setupCode: 'f'.repeat(32) }, { 'x-forwarded-for': `192.0.2.${i}` })).status).toBe(403);
    }
    const limited = await running.post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(users()).toEqual({ total: 0 });
    clock += 60_000;
    expect((await running.post()).status).toBe(201);
  });

  it('permits at most one concurrent request and one credential', async () => {
    const running = start();
    const responses = await Promise.all(Array.from({ length: 8 }, () => running.post()));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
    expect(users()).toEqual({ total: 1 });
    expect(temp.handle.sqlite.prepare('SELECT COUNT(*) total FROM account').get()).toEqual({ total: 1 });
  });

  it.each(['user', 'admin'] as const)('never opens on existing %s accounts', async (role) => {
    await temp.auth.api.createUser({ body: { ...input, name: input.username, role, data: { username: input.username } } });
    const running = start();
    expect(logs).toHaveLength(0);
    expect(await (await running.status()).json()).toEqual({ needsSetup: false });
    expect((await running.post()).status).toBe(409);
    expect(users()).toEqual({ total: 1 });
  });

  it('closes immediately after CLI provisioning and remains closed after deleting users', async () => {
    const running = start();
    expect((await bootstrapAdmin(temp.handle, { ...input, name: input.username }, TEST_AUTH_SECRET, BASE)).status).toBe('created');
    expect((await running.post()).status).toBe(409);
    temp.handle.sqlite.exec('DELETE FROM user');
    expect(await (await running.status()).json()).toEqual({ needsSetup: false });
  });

  it('serializes web and CLI creation on the same connection', async () => {
    const running = start();
    const results = await Promise.all([
      running.post(), bootstrapAdmin(temp.handle, { ...input, name: input.username }, TEST_AUTH_SECRET, BASE),
    ]);
    expect(Number(results[0].status === 201) + Number(results[1].status === 'created')).toBe(1);
    expect(users()).toEqual({ total: 1 });
  });

  it('rolls back user and credential on internal failure without leaking secrets, then allows retry', async () => {
    const running = start();
    const original = temp.auth.api.createUser;
    vi.spyOn(temp.auth.api, 'createUser').mockImplementationOnce(async (args) => {
      await original(args);
      throw new Error(`SQL secret ${running.code} ${input.password}`);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await running.post();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"Administrator Creation Failed"}');
    expect(users()).toEqual({ total: 0 });
    expect(temp.handle.sqlite.prepare('SELECT COUNT(*) total FROM account').get()).toEqual({ total: 0 });
    expect(errors).not.toHaveBeenCalled();
    expect(logs.join()).not.toContain(input.password);
    expect((await running.post()).status).toBe(201);
  });
});

describe('setup HTTP boundary', () => {
  it.each(['https://evil.example', 'null', '', `${BASE}.evil.example`])('rejects untrusted/missing Origin %s', async (origin) => {
    const running = start();
    expect((await running.post(undefined, { origin })).status).toBe(403);
    expect(users()).toEqual({ total: 0 });
  });
  it.each(['text/plain', 'application/x-www-form-urlencoded', ''])('rejects Content-Type %s', async (type) => {
    const running = start();
    expect((await running.post(undefined, { 'content-type': type })).status).toBe(415);
    expect(users()).toEqual({ total: 0 });
  });
  it.each([
    {}, null, [], { username: 'a' }, { ...input, username: '<script>' },
    { ...input, email: 'invalid' }, { ...input, password: 'short' },
    { ...input, password: 'x'.repeat(129) }, { ...input, userId: 'attacker' },
    { ...input, role: 'admin' }, { ...input, username: 10 },
  ])('rejects malformed or extra fields %#', async (body) => {
    const running = start();
    const supplied = body && !Array.isArray(body) ? { ...body, setupCode: running.code } : body;
    expect((await running.post(supplied)).status).toBe(400);
    expect(users()).toEqual({ total: 0 });
  });
  it('rejects malformed and oversized JSON', async () => {
    const { app } = start();
    for (const [body, status] of [['{', 400], ['x'.repeat(4097), 413]] as const) {
      expect((await app.request(`${BASE}/api/setup/admin`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body })).status).toBe(status);
    }
    expect(users()).toEqual({ total: 0 });
  });
});
