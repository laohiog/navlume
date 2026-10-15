import { useState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalNavigationActions } from '../../src/client/PersonalNavigation.js';
import type { AdminPublicNavigationActions } from '../../src/client/AdminPublicNavigation.js';
import type { PersonalNavigation } from '../../src/client/api/personal-navigation.js';
import type { AdminPublicNavigation } from '../../src/client/api/admin-public-navigation.js';

const f = vi.hoisted(() => ({ scope: 'personal' as 'personal' | 'admin', personal: null as PersonalNavigationActions | null,
  admin: null as AdminPublicNavigationActions | null, logout: null as (() => void) | null }));
vi.mock('react', async (original) => { const actual = await original<typeof import('react')>(); return { ...actual, useState: vi.fn(actual.useState) }; });
vi.mock('../../src/client/api/auth-client.js', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'owner', username: 'owner', role: 'admin' }, session: { id: 's1' } }, isPending: false, refetch: vi.fn() }), signOut: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../../src/client/use-hash-page.js', () => ({ useHashPage: () => ({ requestedPage: f.scope === 'admin' ? 'admin' : 'home', navigate: vi.fn() }) }));
vi.mock('../../src/client/PersonalNavigation.js', () => ({ PersonalNavigationView: (p: { actions: PersonalNavigationActions }) => { f.personal = p.actions; return null; } }));
vi.mock('../../src/client/AdminPublicNavigation.js', () => ({ AdminPublicNavigationView: (p: { actions: AdminPublicNavigationActions }) => { f.admin = p.actions; return null; } }));
vi.mock('../../src/client/AdminManagement.js', () => ({ AdminManagementView: (p: { publicNavigation: ReactNode }) => p.publicNavigation }));
vi.mock('../../src/client/PublicNavigation.js', async (original) => ({ ...await original<typeof import('../../src/client/PublicNavigation.js')>(), PublicNavigationView: (p: { personal: { view: ReactNode } | null; onLogout: () => void }) => { f.logout = p.onLogout; return p.personal?.view ?? null; } }));
import { App } from '../../src/client/App.js';

function navigation(size = 100): PersonalNavigation & AdminPublicNavigation {
  return { categories: [{ id: 7, name: '完整分类', sortOrder: 0, isDefault: true, icon: null, isVisible: true,
    links: Array.from({ length: size }, (_, i) => ({ id: i + 1, categoryId: 7, title: `网址${i + 1}`, url: `https://example.test/${i}`, normalizedUrl: `https://example.test/${i}`, iconUrl: null, description: null, sortOrder: i, isVisible: i !== 4 })) }] };
}
function render(scope: 'personal' | 'admin', data = navigation()) {
  f.scope = scope;
  // Seed App's existing state owners, in their declared order. Other hooks stay real.
  for (const value of [
    { sessionKey: null, accessMode: null, state: { status: 'loading' } }, 0,
    { sessionKey: 'owner', result: { status: 'ok', data } }, 0, false, null,
    false, false, false, null, { status: 'ok', data },
  ]) vi.mocked(useState).mockImplementationOnce(() => [value, vi.fn()]);
  renderToStaticMarkup(<App />);
  return scope === 'personal' ? f.personal! : f.admin!;
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  vi.mocked(useState).mockImplementation(actual.useState);
  vi.stubGlobal('window', { location: { hash: '#home' } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe.each(['personal', 'admin'] as const)('%s App long-distance mutation wiring', (scope) => {
  it('sends full IDs with categoryId, awaits readback and preserves hidden data', async () => {
    const data = navigation();
    const after = navigation(); after.categories[0]!.links.push(after.categories[0]!.links.shift()!);
    const fetch = vi.fn().mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response(after));
    vi.stubGlobal('fetch', fetch);
    const actions = render(scope, data);
    expect(await actions.moveLinkTo(1, 100)).toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe(scope === 'personal' ? '/api/personal/links/order' : '/api/admin/public/links/order');
    expect(JSON.parse(init.body)).toEqual({ categoryId: 7, ids: [...Array.from({ length: 99 }, (_, i) => i + 2), 1] });
    expect(JSON.parse(init.body).ids).toContain(5);
    expect(init.credentials).toBe('same-origin');
  });
  it('does not request for current position or invalid input', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const a = render(scope);
    expect((await a.moveLinkTo(1, 1)).status).toBe('unchanged');
    expect((await a.moveLinkTo(1, 0)).status).toBe('error');
    expect((await a.moveLinkTo(999, 2)).status).toBe('error');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks fresh membership before writing after another session removed the item', async () => {
    const fetch = vi.fn().mockResolvedValue(response(navigation(0))); vi.stubGlobal('fetch', fetch);
    const result = await render(scope).moveLinkTo(1, 50);
    expect(result.status).toBe('error'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reads an already-saved uncertain result without a second write', async () => {
    const data = navigation();
    data.categories[0]!.links.push(data.categories[0]!.links.shift()!);
    const fetch = vi.fn().mockResolvedValue(response(data)); vi.stubGlobal('fetch', fetch);
    expect(await render(scope).moveLinkTo(1, 100)).toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]?.method).not.toBe('PUT');
  });
  if (scope === 'personal') it('discards a pending read after logout without writing', async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const pending = render(scope).moveLinkTo(1, 100);
    f.logout?.();
    release(response(navigation()));
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain errors distinct from confirmed save with failed refresh', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(navigation())).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}, 500));
    vi.stubGlobal('fetch', fetch);
    const result = await render(scope).moveLinkTo(1, 50);
    expect(result.status).toBe('error'); if (result.status === 'error') expect(result.message).toContain('已保存，但列表刷新失败');
  });
  it.each([400, 401, 403, 404, 500])('reports HTTP %i without success or readback', async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(response(navigation())).mockResolvedValueOnce(response({}, status)); vi.stubGlobal('fetch', fetch);
    expect((await render(scope).moveLinkTo(1, 50)).status).toBe('error'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('blocks rapid duplicates and handles network failure', async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; })).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetch); const a = render(scope);
    const pending = a.moveLinkTo(1, 50);
    expect((await a.moveLinkTo(2, 50)).status).toBe('error');
    release(response(navigation()));
    expect((await pending).status).toBe('error'); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
