import { useState, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DataPortabilityViewProps } from '../../src/client/DataPortability.js';
import type { Page } from '../../src/client/page-state.js';
import type { SessionBar } from '../../src/client/PublicNavigation.js';
import type { PublicNavigationState } from '../../src/client/PublicNavigation.js';
import type { PersonalNavigationResult } from '../../src/client/api/personal-navigation.js';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

const fixture = vi.hoisted(() => ({
  page: 'home' as Page,
  user: null as { id: string; username: string; role: 'user' | 'admin' } | null,
  pending: false,
  sessionId: null as string | null,
  adminModule: 'data' as 'data' | 'users',
  panels: null as DataPortabilityViewProps | null,
  logout: null as (() => void) | null,
  navigate: vi.fn(),
  refetch: vi.fn().mockResolvedValue(undefined),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/client/api/auth-client.js', () => ({
  authClient: {
    useSession: () => ({
      data: fixture.user === null ? null : { user: fixture.user, session: { id: fixture.sessionId } },
      isPending: fixture.pending,
      refetch: fixture.refetch,
    }),
    signOut: fixture.signOut,
  },
}));

vi.mock('../../src/client/use-hash-page.js', () => ({
  useHashPage: () => ({ requestedPage: fixture.page, navigate: fixture.navigate }),
}));

// Select the existing data module without replacing its composition or panels.
vi.mock('../../src/client/AdminManagement.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/client/AdminManagement.js')>();
  return {
    ...original,
    AdminManagementView: (props: ComponentProps<typeof original.AdminManagementView>) => (
      <original.AdminManagementView {...props} initialModule={fixture.adminModule} />
    ),
  };
});

vi.mock('../../src/client/DataPortability.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/client/DataPortability.js')>();
  return {
    ...original,
    DataPortabilityView: (props: DataPortabilityViewProps) => {
      fixture.panels = props;
      return <original.DataPortabilityView {...props} />;
    },
  };
});

vi.mock('../../src/client/PublicNavigation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/client/PublicNavigation.js')>();
  return {
    ...original,
    SessionBar: (props: ComponentProps<typeof SessionBar>) => {
      fixture.logout = props.onLogout;
      return <original.SessionBar {...props} />;
    },
  };
});

vi.mock('../../src/client/api/data-portability.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/client/api/data-portability.js')>(),
  downloadDocument: vi.fn(),
  exportSiteDocument: vi.fn(),
  saveJsonFile: vi.fn(),
  previewPersonalImport: vi.fn(),
  previewSiteImport: vi.fn(),
  applyPersonalImport: vi.fn(),
  applySiteImport: vi.fn(),
}));

import { App } from '../../src/client/App.js';
import * as api from '../../src/client/api/data-portability.js';

const USER = { id: 'user-a', username: 'normaluser', role: 'user' as const };
const ADMIN = { id: 'admin-a', username: 'adminuser', role: 'admin' as const };
const SUMMARY = {
  incomingCategories: 1, incomingLinks: 1, currentCategories: 1, currentLinks: 0,
  replacementWarning: '只替换当前用户的个人导航。',
};

function render(page: Page, user: typeof USER | typeof ADMIN | null, pending = false, sessionId = user === null ? null : `session-${user.id}`) {
  fixture.page = page;
  fixture.user = user;
  fixture.pending = pending;
  fixture.sessionId = sessionId;
  fixture.panels = null;
  fixture.logout = null;
  vi.stubGlobal('window', { location: { hash: `#${page}` } });
  return renderToStaticMarkup(<App />);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.pending = false;
  fixture.adminModule = 'data';
});
afterEach(() => vi.unstubAllGlobals());

describe('App — UO2 page composition and permissions', () => {
  it.each([null, USER, ADMIN])('never mounts portability on Home (%j)', (user) => {
    const markup = render('home', user);
    expect(fixture.panels).toBeNull();
    expect(markup).not.toContain('我的数据');
    expect(markup).not.toContain('portability-personal');
    expect(markup).toContain('name="search"');
  });

  it('offers settings to User and management to Admin', () => {
    const userMarkup = render('home', USER);
    expect(userMarkup).toContain('个人设置');
    expect(userMarkup).not.toContain('管理后台');
    const adminMarkup = render('home', ADMIN);
    expect(adminMarkup).toContain('管理后台');
    expect(adminMarkup).not.toContain('个人设置');
  });

  it('Settings gives User only their own panel and actions', () => {
    const markup = render('settings', USER);
    expect(markup).toContain('app--settings');
    expect(markup).toContain('个人设置');
    expect(markup).toContain('我的数据');
    expect(markup).toContain('返回导航');
    expect(markup).not.toContain('站点数据');
    expect(markup).not.toContain('管理模块');
    expect(fixture.panels?.personal).not.toBeNull();
    expect(fixture.panels?.site).toBeNull();
  });

  it('Admin Data Management mounts two distinct data scopes', () => {
    const markup = render('admin', ADMIN);
    expect(markup).toContain('我的数据');
    expect(markup).toContain('站点数据');
    expect(markup).toContain('其他用户的数据不受影响');
    expect(markup).toContain('用户账号不会被改动');
    expect(fixture.panels?.personal?.actions).not.toBe(fixture.panels?.site?.actions);
  });

  it.each<Page>(['settings', 'admin'])('Guest cannot mount %s', (page) => {
    const markup = render(page, null);
    expect(markup).toContain('app--home');
    expect(markup).not.toContain('portability');
    expect(fixture.panels).toBeNull();
  });

  it('User cannot mount Admin even with a forged hash', () => {
    const markup = render('admin', USER);
    expect(markup).toContain('app--home');
    expect(markup).not.toContain('管理后台');
    expect(fixture.panels).toBeNull();
  });

  it.each<Page>(['settings', 'admin'])('pending cached Admin session cannot mount %s', (page) => {
    const markup = render(page, ADMIN, true);
    expect(markup).toContain('session-bar__pending');
    expect(fixture.panels).toBeNull();
  });
});

describe('App — portability action ownership and logout', () => {
  it('routes exports, previews and applies to the correct scope', async () => {
    render('admin', ADMIN);
    const personal = fixture.panels!.personal!.actions;
    const site = fixture.panels!.site!.actions;
    const personalDocument = { type: 'personal', schema_version: 1 };
    const siteDocument = { type: 'site', schema_version: 1 };
    vi.mocked(api.downloadDocument).mockResolvedValue({ status: 'ok', document: personalDocument, text: 'PERSONAL' });
    vi.mocked(api.exportSiteDocument).mockResolvedValue({ status: 'ok', document: siteDocument, text: 'SITE' });
    vi.mocked(api.previewPersonalImport).mockResolvedValue({ status: 'ok', summary: { ...SUMMARY, scope: 'personal' } });
    vi.mocked(api.previewSiteImport).mockResolvedValue({ status: 'ok', summary: { ...SUMMARY, scope: 'site', brandingUpdated: true, assetsPreserved: true } });
    vi.mocked(api.applyPersonalImport).mockResolvedValue({ status: 'ok', summary: { ...SUMMARY, scope: 'personal' } });
    vi.mocked(api.applySiteImport).mockResolvedValue({ status: 'ok', summary: { ...SUMMARY, scope: 'site', brandingUpdated: true, assetsPreserved: true } });

    await personal.export();
    await site.export();
    await personal.preview(personalDocument);
    await site.preview(siteDocument);
    await personal.apply(personalDocument);
    await site.apply(siteDocument);

    expect(api.downloadDocument).toHaveBeenCalledWith(api.PERSONAL_EXPORT_ENDPOINT);
    expect(api.exportSiteDocument).toHaveBeenCalledOnce();
    expect(api.saveJsonFile).toHaveBeenCalledWith(expect.stringMatching(/^navigation-personal-\d+\.json$/), 'PERSONAL');
    expect(api.saveJsonFile).toHaveBeenCalledWith(expect.stringMatching(/^navigation-site-\d+\.json$/), 'SITE');
    expect(api.previewPersonalImport).toHaveBeenCalledWith(personalDocument);
    expect(api.previewSiteImport).toHaveBeenCalledWith(siteDocument);
    expect(api.applyPersonalImport).toHaveBeenCalledWith(personalDocument);
    expect(api.applySiteImport).toHaveBeenCalledWith(siteDocument);
  });

  it.each(['export', 'preview', 'apply'] as const)('discards a late %s after settings logout', async (operation) => {
    render('settings', USER);
    const actions = fixture.panels!.personal!.actions;
    const document = { type: 'personal', schema_version: 1 };
    type Completion = Awaited<ReturnType<typeof api.downloadDocument>> & Awaited<ReturnType<typeof api.previewPersonalImport>>;
    let complete!: (value: Completion) => void;
    const late = new Promise<Completion>((resolve) => { complete = resolve; });
    if (operation === 'export') vi.mocked(api.downloadDocument).mockReturnValue(late);
    if (operation === 'preview') vi.mocked(api.previewPersonalImport).mockReturnValue(late);
    if (operation === 'apply') vi.mocked(api.applyPersonalImport).mockReturnValue(late);

    const result = operation === 'export' ? actions.export() : actions[operation](document);
    fixture.logout!();
    // Navigation is requested before sign-out or the old operation finishes.
    expect(fixture.navigate).toHaveBeenCalledWith('home');
    complete({ status: 'ok', summary: { ...SUMMARY, scope: 'personal' }, document, text: 'OLD_USER_JSON' });

    expect(await result).toEqual({ status: 'stale' });
    expect(api.saveJsonFile).not.toHaveBeenCalled();
  });
});

describe('App — user list page and session ownership', () => {
  async function renderUserPage(sessionId: string, requestedPage: number, pending = false) {
    const actual = await vi.importActual<typeof import('react')>('react');
    fixture.adminModule = 'users';
    const cached = {
      sessionKey: 'session-admin-a', page: 1, total: 101,
      state: { status: 'ready', users: [{
        id: 'private-user', username: 'PRIVATE-USER', name: 'Private User', email: 'private@example.com',
        role: 'user', banned: false, emailVerified: true, image: null, banReason: null, banExpires: null,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] },
    };
    let index = 0;
    vi.mocked(useState).mockImplementation((initial?: unknown) => {
      const current = index++;
      if (current === 20) return [cached, vi.fn()];
      if (current === 22) return [{ sessionKey: 'session-admin-a', page: requestedPage }, vi.fn()];
      return actual.useState(initial);
    });
    try {
      return render('admin', ADMIN, pending, sessionId);
    } finally {
      vi.mocked(useState).mockImplementation(actual.useState);
    }
  }

  it('renders the current session and page only', async () => {
    const markup = await renderUserPage('session-admin-a', 1);
    expect(markup).toContain('PRIVATE-USER');
    expect(markup).toContain('第 2 / 2 页');
  });

  it('never renders a previous page beside the new page number', async () => {
    const markup = await renderUserPage('session-admin-a', 0);
    expect(markup).not.toContain('PRIVATE-USER');
    expect(markup).toContain('正在加载用户列表');
    expect(markup).toContain('第 1 / 2 页');
  });

  it('starts a different session at page one without the previous list', async () => {
    const markup = await renderUserPage('session-admin-b', 1);
    expect(markup).not.toContain('PRIVATE-USER');
    expect(markup).not.toContain('共 101 个用户');
    expect(markup).toContain('第 1 / … 页');
  });

  it('does not render the list during session verification', async () => {
    expect(await renderUserPage('session-admin-a', 1, true)).not.toContain('PRIVATE-USER');
  });
});

describe('App — protected public navigation cache', () => {
  const marker = 'Protected cached destination';
  const url = 'https://private.example.com/cached';
  const description = 'Protected cached description';

  async function renderCached(
    accessMode: 'public' | 'login_required',
    user: typeof USER | null,
    options: { pending?: boolean; signingOut?: boolean; sessionId?: string } = {},
  ) {
    const actual = await vi.importActual<typeof import('react')>('react');
    const cached = {
      sessionKey: 'session-user-a',
      accessMode,
      state: {
        status: 'ready',
        data: {
          site: { accessMode },
          categories: [{ id: 1, name: 'Protected category', icon: null, sortOrder: 0, links: [
            { id: 1, title: marker, url, description, iconUrl: null, sortOrder: 0 },
          ] }],
        },
      },
    };
    let stateIndex = 0;
    vi.mocked(useState).mockImplementation((initial?: unknown) => {
      const index = stateIndex++;
      if (index === 0) return [cached, vi.fn()];
      if (index === 8) return [options.signingOut ?? false, vi.fn()];
      return actual.useState(initial);
    });
    try {
      return render('home', user, options.pending ?? false, options.sessionId ?? (user === null ? null : `session-${user.id}`));
    } finally {
      vi.mocked(useState).mockImplementation(actual.useState);
    }
  }

  function expectHidden(markup: string) {
    for (const text of [marker, url, description, 'Protected category']) {
      expect(markup).not.toContain(text);
    }
  }

  it('shows the existing login screen after the session is confirmed absent', async () => {
    const markup = await renderCached('login_required', null);
    expectHidden(markup);
    expect(markup).toContain('app--login-required');
    expect(markup).toContain('name="username"');
  });

  it('keeps the login form mounted while rechecking an absent session', async () => {
    const markup = await renderCached('login_required', null, { pending: true });
    expectHidden(markup);
    expect(markup).toContain('app--login-required');
    expect(markup).toContain('name="username"');
  });

  it('hides protected content while sign-out is pending despite the cached session', async () => {
    const markup = await renderCached('login_required', USER, { signingOut: true });
    expectHidden(markup);
    expect(markup).toContain('app--login-required');
    expect(markup).toContain('disabled');
  });

  it.each([
    [{ ...USER, id: 'user-b' }, {}],
    [USER, { sessionId: 'new-session-user-a' }],
    [USER, { pending: true }],
  ] as const)('does not render another or unresolved session cache (%j)', async (user, options) => {
    expectHidden(await renderCached('login_required', user, options));
  });

  it('renders protected content again for its valid original session', async () => {
    expect(await renderCached('login_required', USER)).toContain(marker);
  });

  it.each([null, USER])('keeps public-mode data visible for Guest or during logout (%j)', async (user) => {
    const markup = await renderCached('public', user, { signingOut: user !== null });
    expect(markup).toContain(marker);
    expect(markup).toContain(url);
    expect(markup).not.toContain('app--login-required');
  });
});

describe('App — UO3 combined navigation search', () => {
  const emptyPublic: PublicNavigationState = {
    status: 'ready', data: { site: null, categories: [{ id: 1, name: 'Empty public', icon: null, sortOrder: 0, links: [] }] },
  };
  const fullPublic: PublicNavigationState = {
    status: 'ready', data: { site: null, categories: [{ id: 1, name: 'Public', icon: null, sortOrder: 0, links: [
      { id: 1, title: 'Public destination', url: 'https://public.example.com', description: null, iconUrl: null, sortOrder: 0 },
    ] }] },
  };
  const emptyPersonal: PersonalNavigationResult = {
    status: 'ok', data: { categories: [{ id: 1, name: 'Default', isDefault: true, sortOrder: 0, links: [] }] },
  };
  const fullPersonal: PersonalNavigationResult = {
    status: 'ok', data: { categories: [{ id: 1, name: 'Default', isDefault: true, sortOrder: 0, links: [
      { id: 1, title: 'Personal destination', url: 'https://personal.example.com', normalizedUrl: 'https://personal.example.com/', iconUrl: null, sortOrder: 0 },
    ] }] },
  };

  async function renderSearch(
    publicState: PublicNavigationState,
    personalResult: PersonalNavigationResult | null,
    query: string,
    user: typeof USER | typeof ADMIN | null = USER,
  ) {
    const actual = await vi.importActual<typeof import('react')>('react');
    // Inject loaded reads and a query into the real App composition; other state
    // and all view projections still use React and the production components.
    vi.mocked(useState).mockImplementation((initial?: unknown) => actual.useState(initial === '' ? query : initial));
    vi.mocked(useState)
      .mockImplementationOnce(() => [{
        sessionKey: user === null ? null : `session-${user.id}`,
        accessMode: publicState.status === 'ready' ? publicState.data.site?.accessMode ?? 'public' : null,
        state: publicState,
      }, vi.fn()])
      .mockImplementationOnce(() => [0, vi.fn()])
      .mockImplementationOnce(() => [personalResult === null ? null : { sessionKey: user?.id, result: personalResult }, vi.fn()]);
    try {
      return render('home', user);
    } finally {
      vi.mocked(useState).mockImplementation(actual.useState);
    }
  }

  it.each([null, USER, ADMIN])('preserves role entries and hides empty sections (%j)', async (user) => {
    const markup = await renderSearch(emptyPublic, emptyPersonal, '', user);

    expect(markup).not.toContain('public-navigation');
    expect(markup).not.toContain('Empty public');
    expect(markup).toContain('name="search"');
    expect(markup).not.toContain('portability');
    if (user === null) {
      expect(markup).toContain('>登录</button>');
      expect(markup).not.toContain('＋ 添加网址');
    } else {
      expect(markup).toContain('＋ 添加网址');
      expect(markup).toContain(user.role === 'admin' ? '管理后台' : '个人设置');
      expect(markup.split('还没有添加网址')).toHaveLength(2);
    }
  });

  it.each([
    [fullPublic, fullPersonal, 'personal', false],
    [fullPublic, fullPersonal, 'public', false],
    [fullPublic, fullPersonal, 'destination', false],
    [fullPublic, fullPersonal, 'missing', true],
    [emptyPublic, fullPersonal, 'missing', true],
    [emptyPublic, emptyPersonal, 'missing', true],
    [fullPublic, emptyPersonal, '', false],
  ] as const)('derives one combined search result for query %s', async (publicState, personalResult, query, noResults) => {
    const markup = await renderSearch(publicState, personalResult, query);

    expect(markup.split('没有找到匹配的网址').length - 1).toBe(noResults ? 1 : 0);
    expect(markup).not.toContain('暂无公共导航内容');
    if (query === 'personal') {
      expect(markup).toContain('Personal destination');
      expect(markup).not.toContain('Public destination');
    }
    if (query === 'public') {
      expect(markup).toContain('Public destination');
      expect(markup).not.toContain('Personal destination');
    }
    if (query === 'destination') {
      expect(markup).toContain('Public destination');
      expect(markup).toContain('Personal destination');
    }
    if (query === '') expect(markup).toContain('Public destination');
  });

  it.each([
    [{ status: 'loading' }, emptyPersonal, '正在加载公共导航'],
    [{ status: 'error' }, emptyPersonal, '公共导航暂时无法加载'],
    [emptyPublic, null, '正在加载个人导航'],
    [emptyPublic, { status: 'error' }, '个人导航暂时无法加载'],
    [emptyPublic, { status: 'unauthenticated' }, null],
  ] as const)('does not treat unresolved or failed data as no results', async (publicState, personalResult, message) => {
    const markup = await renderSearch(publicState, personalResult, 'missing');

    expect(markup).not.toContain('没有找到匹配的网址');
    expect(markup).not.toContain('还没有添加网址');
    if (message !== null) expect(markup).toContain(message);
  });
});
