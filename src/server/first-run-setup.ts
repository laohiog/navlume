import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth } from '../db/auth.js';
import { user } from '../db/auth-schema.js';
import type { DatabaseHandle } from '../db/index.js';
import { createFirstAdministrator } from './bootstrap-admin.js';

/** One capability per running instance; never persisted or exposed by HTTP. */
export function createFirstRunSetup(
  handle: DatabaseHandle,
  auth: Auth,
  baseURL: string,
  log: (message: string) => void = console.log,
  now: () => number = Date.now,
) {
  const isEmpty = () => handle.db.select({ id: user.id }).from(user).limit(1).get() === undefined;
  let code: string | null = isEmpty() ? randomBytes(16).toString('hex') : null;
  const expiresAt = now() + 60 * 60 * 1000;
  let busy = false;
  let failures = 0;
  let windowEnds = 0;
  if (code !== null) log(`[setup] First-run initialization code (valid for 60 minutes): ${code}`);

  function needed(): boolean {
    // Observing provisioning closes this process's capability permanently, even
    // if the last account is later deleted. CLI provisioning is seen on each request.
    if (!busy && !isEmpty()) code = null;
    return code !== null;
  }

  return {
    register(app: Hono): void {
      app.use('/api/setup/*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        await next();
      });
      app.get('/api/setup/status', (c) => {
        try { return c.json({ needsSetup: needed() }); }
        catch { return c.json({ error: 'Internal Server Error' }, 500); }
      });
      app.post('/api/setup/admin', bodyLimit({ maxSize: 4096,
        onError: (c) => c.json({ error: 'Invalid Input' }, 413),
      }), async (c) => {
        try {
          if (c.req.header('origin') !== new URL(baseURL).origin) {
            return c.json({ error: 'Invalid Origin' }, 403);
          }
          if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            return c.json({ error: 'JSON Content-Type Required' }, 415);
          }
          if (!needed() || busy) return c.json({ error: 'Setup Unavailable' }, 409);
          if (now() >= expiresAt) return c.json({ error: 'Setup Code Expired' }, 403);
          // Instance-wide, bounded state: forwarded client addresses cannot bypass
          // the limit, and arbitrary addresses cannot grow an in-memory map.
          if (now() >= windowEnds) { failures = 0; windowEnds = now() + 60_000; }
          if (failures >= 5) {
            c.header('Retry-After', String(Math.max(1, Math.ceil((windowEnds - now()) / 1000))));
            return c.json({ error: 'Too Many Attempts' }, 429);
          }
          // Bound JSON parsing and reject bodies larger than the maximum form.
          const raw = await c.req.text();
          if (raw.length > 4096) return c.json({ error: 'Invalid Input' }, 400);
          let body: unknown;
          try { body = JSON.parse(raw); } catch { return c.json({ error: 'Invalid Input' }, 400); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return c.json({ error: 'Invalid Input' }, 400);
          }
          const data = body as Record<string, unknown>;
          if (Object.keys(data).length !== 4 ||
              !['username', 'email', 'password', 'setupCode'].every((key) => typeof data[key] === 'string')) {
            return c.json({ error: 'Invalid Input' }, 400);
          }
          const { username, email, password, setupCode } = data as Record<string, string>;
          if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username!) ||
              email!.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email!) ||
              password!.length < 8 || password!.length > 128 || setupCode!.length > 128) {
            return c.json({ error: 'Invalid Input' }, 400);
          }
          if (!needed() || busy) return c.json({ error: 'Setup Unavailable' }, 409);
          if (now() >= expiresAt) return c.json({ error: 'Setup Code Expired' }, 403);
          if (failures >= 5) return c.json({ error: 'Too Many Attempts' }, 429);
          const submitted = Buffer.from(setupCode!);
          const expected = Buffer.from(code!);
          if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) {
            failures += 1;
            return c.json({ error: 'Invalid Setup Code' }, 403);
          }
          // Parsing yielded: recheck before acquiring the exclusive creation path.
          if (!needed() || busy) return c.json({ error: 'Setup Unavailable' }, 409);
          busy = true;
          try {
            const result = await createFirstAdministrator(handle, auth, {
              username: username!, email: email!, password: password!, name: username!,
            }, true);
            if (result.status === 'refused') {
              needed();
              return c.json({ error: 'Setup Unavailable' }, 409);
            }
            if (result.status === 'failed') return c.json({ error: 'Administrator Creation Failed' }, 400);
            code = null;
            return c.json({ status: 'created' }, 201);
          } finally { busy = false; }
        } catch {
          // Never log the request, credential values or an internal Auth/SQL error.
          return c.json({ error: 'Internal Server Error' }, 500);
        }
      });
    },
  };
}

export type FirstRunSetup = ReturnType<typeof createFirstRunSetup>;
