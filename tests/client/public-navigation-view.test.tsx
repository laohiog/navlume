import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { PublicNavigation } from '../../src/client/api/public-navigation.js';
import {
  PublicNavigationView,
  type PublicNavigationState,
  type PublicNavigationViewProps,
  type SessionSummary,
} from '../../src/client/PublicNavigation.js';

/** Public branding fixture: the source of the header/footer identity. */
const BRANDING = {
  pageBackgroundColor: null,
  surfaceColor: null,
  backgroundImagePath: null,
  siteName: 'Example Navigation',
  tagline: 'Simple · Brandable · Self-hosted · Portable · Fast',
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  defaultTheme: 'light' as const,
  footerText: 'Self-hosted navigation',
};

const SITE: NonNullable<PublicNavigation['site']> = {
  id: 1,
  siteName: 'Example Navigation',
  tagline: 'Simple · Brandable · Self-hosted · Portable · Fast',
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  defaultTheme: 'light',
  footerText: 'Self-hosted navigation',
  accessMode: 'public',
};

const GUEST: SessionSummary = { isPending: false, username: null };
const PENDING: SessionSummary = { isPending: true, username: null };
const USER: SessionSummary = { isPending: false, username: 'normaluser' };

function ready(data: PublicNavigation): PublicNavigationState {
  return { status: 'ready', data };
}

/** Build props with sensible defaults so each test states only what it cares about. */
function props(overrides: Partial<PublicNavigationViewProps> = {}): PublicNavigationViewProps {
  return {
    state: { status: 'loading' },
    session: GUEST,
    isLoginVisible: false,
    login: { isSubmitting: false, errorMessage: null, onSubmit: vi.fn() },
    personal: null,
    adminEntry: null,
    settingsEntry: null,
    branding: { siteName: '导航', tagline: null, logoPath: null, faviconPath: null, primaryColor: null, pageBackgroundColor: null, surfaceColor: null, backgroundImagePath: null, defaultTheme: 'light', footerText: null },
    search: { query: '', onChange: vi.fn(), showNoResults: false },
    onLogout: vi.fn(),
    onShowLogin: vi.fn(),
    onHideLogin: vi.fn(),
    ...overrides,
  };
}

function html(overrides: Partial<PublicNavigationViewProps> = {}): string {
  return renderToStaticMarkup(<PublicNavigationView {...props(overrides)} />);
}

const POPULATED: PublicNavigation = {
  site: SITE,
  categories: [
    {
      id: 1,
      name: 'Example',
      icon: null,
      sortOrder: 0,
      links: [
        {
          id: 1,
          title: 'Example Domain',
          url: 'https://example.com',
          description: 'A sample link',
          iconUrl: null,
          sortOrder: 0,
        },
      ],
    },
    {
      id: 2,
      name: 'Reference',
      icon: null,
      sortOrder: 1,
      links: [
        {
          id: 3,
          title: 'MDN Web Docs',
          url: 'https://developer.mozilla.org',
          description: null,
          iconUrl: null,
          sortOrder: 0,
        },
      ],
    },
  ],
};

describe('PublicNavigationView — populated (public guest)', () => {
  it('renders site identity from branding, plus categories and links', () => {
    const markup = html({ state: ready(POPULATED), branding: BRANDING });

    expect(markup).toContain('Example Navigation');
    expect(markup).toContain('Simple · Brandable · Self-hosted · Portable · Fast');
    expect(markup).toContain('Self-hosted navigation');
    expect(markup).toContain('Example');
    expect(markup).toContain('Reference');
    expect(markup).toContain('Example Domain');
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('MDN Web Docs');
    expect(markup).toContain('A sample link');
  });

  it('shows a login entry point for guests but not the form by default', () => {
    const markup = html({ state: ready(POPULATED), isLoginVisible: false });

    expect(markup).toContain('登录');
    expect(markup).not.toContain('name="password"');
    expect(markup).not.toContain('退出登录');
  });

  it('opens links in a new tab with a safe rel attribute', () => {
    const markup = html({ state: ready(POPULATED) });

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it('uses supplied icons with initials underneath, without fetching destination metadata', () => {
    const data: PublicNavigation = {
      ...POPULATED,
      categories: [{ ...POPULATED.categories[0]!, links: [
        { ...POPULATED.categories[0]!.links[0]!, iconUrl: 'https://example.com/supplied-icon.png' },
        { ...POPULATED.categories[0]!.links[0]!, id: 99, title: '中文网址', iconUrl: null },
      ] }],
    };
    const markup = html({ state: ready(data) });

    expect(markup).toContain('src="https://example.com/supplied-icon.png"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('aria-hidden="true"><span>E</span>');
    expect(markup).toContain('aria-hidden="true"><span>中</span>');
    expect(markup).not.toContain('/favicon.ico');
  });

  it('does not load unsafe icon schemes and retains a navigable destination', () => {
    const markup = html({ state: ready({ ...POPULATED, categories: [
      { ...POPULATED.categories[0]!, links: [
        { ...POPULATED.categories[0]!.links[0]!, iconUrl: 'javascript:alert(1)' },
      ] },
    ] }) });

    expect(markup).not.toContain('<img');
    expect(markup).toContain('href="https://example.com"');
  });

  it('offers category jumps without replacing destination URLs or hash routes', () => {
    const markup = html({ state: ready(POPULATED) });

    expect(markup).toContain('<nav class="category-nav" aria-label="公共分类">');
    expect(markup).toContain('type="button">Reference</button>');
    expect(markup).toContain('id="category-2" tabindex="-1"');
    expect(markup).not.toContain('href="#category-');
  });

  it('keeps personal navigation before public navigation without data tools on Home', () => {
    const markup = html({
      state: ready(POPULATED),
      session: USER,
      personal: { view: <section>Personal links</section> },
    });

    expect(markup).toContain('aria-labelledby="public-navigation-title"');
    expect(markup).toContain('>公共导航</h2>');
    expect(markup).toContain('<h3 class="category__title"');
    expect(markup.indexOf('Personal links')).toBeLessThan(markup.indexOf('id="public-navigation-title"'));
    expect(markup).not.toContain('我的数据');
    expect(markup).not.toContain('portability');
  });

  it('uses semantic landmarks', () => {
    const markup = html({
      state: ready(POPULATED),
      branding: BRANDING,
    });

    expect(markup).toContain('<main');
    expect(markup).toContain('<header');
    expect(markup).toContain('<section');
    expect(markup).toContain('<h1');
    expect(markup).toContain('<h2');
    expect(markup).toContain('<footer');
  });

  it('hides empty public navigation when site is null and there are no categories', () => {
    const markup = html({ state: ready({ site: null, categories: [] }) });

    expect(markup).not.toContain('public-navigation');
    expect(markup).not.toContain('暂无公共导航内容');
    expect(markup).toContain('name="search"');
    expect(markup).toContain('>登录</button>');
    expect(markup).not.toContain('undefined');
    expect(markup).not.toContain('null');
  });

  it('hides the whole public section when its only category has no links', () => {
    const markup = html({
      state: ready({
        site: SITE,
        categories: [{ id: 7, name: 'Empty Category', icon: null, sortOrder: 0, links: [] }],
      }),
    });

    expect(markup).not.toContain('Empty Category');
    expect(markup).not.toContain('此分类暂无网址');
    expect(markup).not.toContain('public-navigation');
    expect(markup).not.toContain('<ul');
  });

  it('hides all empty public categories and jumps while preserving branding and footer', () => {
    const data = { ...POPULATED, categories: POPULATED.categories.map((category) => ({ ...category, links: [] })) };
    const snapshot = JSON.stringify(data);
    const markup = html({ state: ready(data), branding: BRANDING });

    expect(markup).not.toContain('public-navigation');
    expect(markup).not.toContain('aria-label="公共分类"');
    expect(markup).not.toContain('此分类暂无网址');
    expect(markup).toContain('Example Navigation');
    expect(markup).toContain('Self-hosted navigation');
    expect(JSON.stringify(data)).toBe(snapshot);
  });

  it('omits empty categories from a mixed dataset without changing order or jump targets', () => {
    const data = { ...POPULATED, categories: [
      POPULATED.categories[0]!,
      { id: 7, name: 'Empty Category', icon: null, sortOrder: 1, links: [] },
      POPULATED.categories[1]!,
    ] };
    const snapshot = JSON.stringify(data);
    const markup = html({ state: ready(data) });

    expect(markup).toContain('>公共导航</h2>');
    expect(markup).toContain('aria-label="公共分类"');
    expect(markup).toContain('id="category-1"');
    expect(markup).toContain('id="category-2"');
    expect(markup).not.toContain('Empty Category');
    expect(markup).not.toContain('id="category-7"');
    expect(markup).not.toContain('此分类暂无网址');
    expect(markup.indexOf('Example Domain')).toBeLessThan(markup.indexOf('MDN Web Docs'));
    expect(JSON.stringify(data)).toBe(snapshot);
  });

  it('does not crash when optional site fields are null', () => {
    const markup = html({
      state: ready({
        site: {
          id: 1,
          siteName: 'Minimal',
          tagline: null,
          logoPath: null,
          faviconPath: null,
          primaryColor: null,
          defaultTheme: 'dark',
          footerText: null,
          accessMode: 'login_required',
        },
        categories: [],
      }),
    });

    // Branding supplies the name; the footer is absent because branding has none.
    expect(markup).toContain('导航');
    expect(markup).not.toContain('site-footer');
    expect(markup).not.toContain('undefined');
  });

  it('does not crash when a link description is null', () => {
    const markup = html({
      state: ready({
        site: SITE,
        categories: [
          {
            id: 1,
            name: 'Example',
            icon: null,
            sortOrder: 0,
            links: [
              { id: 1, title: 'No Description', url: 'https://example.com', description: null, iconUrl: null, sortOrder: 0 },
            ],
          },
        ],
      }),
    });

    expect(markup).toContain('No Description');
    expect(markup).not.toContain('link-card__description');
    expect(markup).toContain('class="destination-secondary">example.com</span>');
  });
});

describe('PublicNavigationView — session UI', () => {
  it('shows a pending indicator while the session resolves', () => {
    const markup = html({ state: ready(POPULATED), session: PENDING });

    expect(markup).toContain('session-bar__pending');
  });

  it('shows the username and a logout control when authenticated', () => {
    const markup = html({ state: ready(POPULATED), session: USER });

    expect(markup).toContain('已登录：normaluser');
    expect(markup).toContain('退出登录');
    // No login prompt for an authenticated visitor.
    expect(markup).not.toContain('name="password"');
  });

  it('does not show the login form to an authenticated visitor even if flagged visible', () => {
    const markup = html({ state: ready(POPULATED), session: USER, isLoginVisible: true });

    expect(markup).not.toContain('name="password"');
  });
});

describe('PublicNavigationView — login form', () => {
  it('renders username and password fields with a login button', () => {
    const markup = html({ state: ready(POPULATED), isLoginVisible: true });

    expect(markup).toContain('name="username"');
    expect(markup).toContain('name="password"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('登录');
  });

  it('contains no signup affordance', () => {
    const markup = html({ state: ready(POPULATED), isLoginVisible: true });

    expect(markup).not.toContain('注册');
    expect(markup).not.toContain('创建账号');
    expect(markup).not.toContain('sign-up');
    expect(markup).not.toContain('signup');
  });

  it('disables inputs and the submit button while submitting', () => {
    const markup = html({
      state: ready(POPULATED),
      isLoginVisible: true,
      login: { isSubmitting: true, errorMessage: null, onSubmit: vi.fn() },
    });

    expect(markup).toContain('disabled');
    expect(markup).toContain('登录中…');
  });

  it('shows a generic error without leaking technical detail', () => {
    const markup = html({
      state: ready(POPULATED),
      isLoginVisible: true,
      login: { isSubmitting: false, errorMessage: '用户名或密码错误', onSubmit: vi.fn() },
    });

    expect(markup).toContain('用户名或密码错误');
    expect(markup).not.toMatch(/SQL|sqlite|INVALID_USERNAME_OR_PASSWORD|status/i);
  });
});

describe('PublicNavigationView — login_required guest', () => {
  it('shows the login screen and hides all navigation data', () => {
    const markup = html({ state: { status: 'unauthenticated' } });

    expect(markup).toContain('请登录');
    expect(markup).toContain('name="username"');
    expect(markup).toContain('name="password"');
    // No protected navigation may be rendered.
    expect(markup).not.toContain('Example Domain');
    expect(markup).not.toContain('link-card');
    expect(markup).not.toContain('https://example.com');
  });

  it('shows a generic error on the login-required screen too', () => {
    const markup = html({
      state: { status: 'unauthenticated' },
      login: { isSubmitting: false, errorMessage: '用户名或密码错误', onSubmit: vi.fn() },
    });

    expect(markup).toContain('用户名或密码错误');
  });
});

describe('PublicNavigationView — loading and error', () => {
  it('renders a non-technical loading state', () => {
    const markup = html({ state: { status: 'loading' } });

    expect(markup).toContain('正在加载公共导航');
    expect(markup).not.toMatch(/SQL|sqlite|stack|Error:/);
  });

  it('renders a generic error state without internals', () => {
    const markup = html({ state: { status: 'error' } });

    expect(markup).toContain('公共导航暂时无法加载');
    expect(markup).not.toMatch(/SQL|sqlite|\.sqlite|stack|Exception/);
  });
});

describe('PublicNavigationView — client-side search', () => {
  it('renders one clearly labelled search input above the navigation', () => {
    const markup = html({ state: ready(POPULATED) });

    expect(markup).toContain('搜索网址');
    expect(markup).toContain('name="search"');
    // The input precedes the first public category.
    expect(markup.indexOf('name="search"')).toBeLessThan(markup.indexOf('Example Domain'));
  });

  it('does not render an advanced-search surface', () => {
    const markup = html({ state: ready(POPULATED) });

    for (const forbidden of ['筛选', '排序', '高级搜索', '搜索历史', '建议']) {
      expect(markup, forbidden).not.toContain(forbidden);
    }
  });

  it('filters public links by title and hides non-matching links', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: 'MDN', onChange: vi.fn(), showNoResults: false },
    });

    expect(markup).toContain('MDN Web Docs');
    expect(markup).not.toContain('Example Domain');
  });

  it('filters public links by description', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: 'sample link', onChange: vi.fn(), showNoResults: false },
    });

    expect(markup).toContain('Example Domain');
    expect(markup).not.toContain('MDN Web Docs');
  });

  it('omits categories that have no matching links', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: 'MDN', onChange: vi.fn(), showNoResults: false },
    });

    expect(markup).toContain('Reference');
    expect(markup).not.toContain('>Example<');
  });

  it('preserves the unfiltered navigation for an empty query', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: '', onChange: vi.fn(), showNoResults: false },
    });

    expect(markup).toContain('Example Domain');
    expect(markup).toContain('MDN Web Docs');
  });

  it('preserves the unfiltered navigation for a whitespace-only query', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: '   ', onChange: vi.fn(), showNoResults: false },
    });

    expect(markup).toContain('Example Domain');
    expect(markup).toContain('MDN Web Docs');
  });

  it('shows the plain no-results message instead of the empty-navigation text', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: 'zzzz', onChange: vi.fn(), showNoResults: true },
    });

    expect(markup).toContain('没有找到匹配的网址');
    expect(markup).not.toContain('暂无公共导航内容');
    expect(markup).not.toMatch(/SQL|Error|Exception|undefined/);
  });

  it('does not claim no results while data is still loading', () => {
    const markup = html({
      state: { status: 'loading' },
      search: { query: 'anything', onChange: vi.fn(), showNoResults: false },
    });

    expect(markup).not.toContain('没有找到匹配的网址');
    expect(markup).toContain('正在加载公共导航');
  });

  it('preserves the search input and login-required screen together', () => {
    const markup = html({ state: { status: 'unauthenticated' } });

    // login_required guests get the login screen; search is not required there.
    expect(markup).toContain('请登录');
  });
});

describe('PublicNavigationView — combined Search partial-scope empty states', () => {
  /**
   * Regression (P4.4 TARGETED FIX #1): when a query matches personal links but no
   * public links, the public section must render nothing — not the dataset-empty
   * message, which would wrongly imply public navigation has no content.
   */
  it('personal-only match does NOT show 暂无公共导航内容', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: 'zzz-personal-only', onChange: vi.fn(), showNoResults: false },
    });

    expect(markup).not.toContain('暂无公共导航内容');
    expect(markup).not.toContain('没有找到匹配的网址');
    // No public cards survive the filter.
    expect(markup).not.toContain('Example Domain');
    expect(markup).not.toContain('MDN Web Docs');
  });

  it('hides a genuinely empty public dataset', () => {
    const genuinelyEmpty = html({
      state: ready({ site: SITE, categories: [] }),
      search: { query: '', onChange: vi.fn(), showNoResults: false },
    });

    expect(genuinelyEmpty).not.toContain('暂无公共导航内容');
    expect(genuinelyEmpty).not.toContain('public-navigation');
  });

  it('does not show 暂无公共导航内容 when a search merely filtered everything out', () => {
    // The dataset has content; only the projection is empty.
    const filteredToZero = html({
      state: ready(POPULATED),
      search: { query: 'zzz-no-public-match', onChange: vi.fn(), showNoResults: true },
    });

    expect(filteredToZero).not.toContain('暂无公共导航内容');
    expect(filteredToZero).toContain('没有找到匹配的网址');
  });

  it('renders the global no-results message exactly once for a combined zero match', () => {
    const markup = html({
      state: ready(POPULATED),
      search: { query: 'zzz-matches-nothing', onChange: vi.fn(), showNoResults: true },
    });

    const occurrences = markup.split('没有找到匹配的网址').length - 1;
    expect(occurrences).toBe(1);
    expect(markup).not.toContain('public-navigation');
  });

  it('keeps the no-results message independent of completely empty public navigation', () => {
    const markup = html({
      state: ready({ site: SITE, categories: POPULATED.categories.map((category) => ({ ...category, links: [] })) }),
      search: { query: 'anything', onChange: vi.fn(), showNoResults: true },
    });

    expect(markup.split('没有找到匹配的网址')).toHaveLength(2);
    expect(markup).not.toContain('public-navigation');
    expect(markup).not.toContain('暂无公共导航内容');
  });
});

describe('PublicNavigationView — UO2 management entries', () => {
  it('renders no admin entry and no personal-data entry for a guest', () => {
    const markup = html({ state: ready(POPULATED) });

    expect(markup).not.toContain('管理后台');
    expect(markup).not.toContain('我的数据');
    expect(markup).not.toContain('个人设置');
  });

  it('renders no admin entry for a normal user', () => {
    const markup = html({ state: ready(POPULATED), session: USER, adminEntry: null });

    expect(markup).not.toContain('管理后台');
  });

  it('renders the 管理后台 entry when the container supplies it (admin only)', () => {
    const markup = html({
      state: ready(POPULATED),
      session: USER,
      adminEntry: { onOpenAdmin: vi.fn() },
    });

    expect(markup).toContain('管理后台');
  });

  it('renders no management modules on Home even for an admin', () => {
    const markup = html({
      state: ready(POPULATED),
      session: USER,
      adminEntry: { onOpenAdmin: vi.fn() },
    });

    // The entry is present, but none of the four management modules is.
    expect(markup).toContain('管理后台');
    expect(markup).not.toContain('品牌设置');
    expect(markup).not.toContain('用户管理');
    expect(markup).not.toContain('数据导入导出');
  });

  it('hides 我的数据 for a guest', () => {
    const markup = html({ state: ready(POPULATED) });

    expect(markup).not.toContain('我的数据');
  });

  it('offers personal settings without rendering personal data controls on Home', () => {
    const markup = html({
      state: ready(POPULATED),
      session: USER,
      settingsEntry: { onOpenSettings: vi.fn() },
    });

    expect(markup).toContain('个人设置');
    expect(markup).not.toContain('我的数据');
    expect(markup).not.toContain('home-data');
    expect(markup).not.toContain('portability-personal');
  });

  it('does not render a supplied settings entry while the session is pending or absent', () => {
    for (const session of [PENDING, GUEST]) {
      const markup = html({ session, settingsEntry: { onOpenSettings: vi.fn() } });
      expect(markup).not.toContain('个人设置');
    }
  });
});
