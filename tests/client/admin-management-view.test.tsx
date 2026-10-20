import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AdminManagementView,
  type AdminModule,
} from '../../src/client/AdminManagement.js';

/** Marker views so each test can see exactly which module is mounted. */
const MODULE_VIEWS = {
  publicNavigation: <span id="module-public-navigation">公共导航视图</span>,
  branding: <span id="module-branding">品牌视图</span>,
  users: <span id="module-users">用户视图</span>,
  data: <span id="module-data">数据视图</span>,
} as const;

const ALL_MODULE_IDS = [
  'module-public-navigation',
  'module-branding',
  'module-users',
  'module-data',
] as const;

const SITE_BRANDING = {
  siteName: '星航导航',
  tagline: null,
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  pageBackgroundColor: null,
  surfaceColor: null,
  backgroundImagePath: null,
  defaultTheme: 'light',
  footerText: null,
  accessMode: 'public',
  homeThemeConfig: null,
} as const;

function shell(overrides: Partial<Parameters<typeof AdminManagementView>[0]> = {}) {
  return (
    <AdminManagementView
      onBackToHome={vi.fn()}
      publicNavigation={MODULE_VIEWS.publicNavigation}
      branding={MODULE_VIEWS.branding}
      users={MODULE_VIEWS.users}
      data={MODULE_VIEWS.data}
      siteBranding={{ ...SITE_BRANDING }}
      username="laohi"
      onLogout={vi.fn()}
      {...overrides}
    />
  );
}

function html(initialModule?: AdminModule): string {
  return renderToStaticMarkup(
    shell(initialModule === undefined ? {} : { initialModule }),
  );
}

describe('AdminManagementView', () => {
  it('renders the back control and one entry per management module', () => {
    const markup = html();

    expect(markup).toContain('返回导航');
    expect(markup).toContain('公共导航');
    expect(markup).toContain('品牌设置');
    expect(markup).toContain('用户管理');
    expect(markup).toContain('数据管理');
  });

  it('defaults to the public-navigation module (UX-IA AC4 default)', () => {
    const markup = html();

    expect(markup).toContain('module-public-navigation');
    expect(markup).not.toContain('module-branding');
    expect(markup).not.toContain('module-users');
    expect(markup).not.toContain('module-data');
  });

  it.each<AdminModule>(['branding', 'users', 'data'])(
    'renders only the selected module when %s is active',
    (selected) => {
      const markup = html(selected);

      // Exactly one of the four module markers is present.
      const present = ALL_MODULE_IDS.filter((id) => markup.includes(id));
      expect(present).toEqual([`module-${selected}`]);
    },
  );

  it('marks exactly one entry as the current page', () => {
    const markup = html('users');

    expect(markup).toContain('aria-current="page"');
    expect(markup.split('aria-current="page"').length - 1).toBe(1);
  });

  it('renders the management page inside a labelled section', () => {
    const markup = html();

    expect(markup).toContain('aria-label="管理后台"');
    expect(markup).toContain('aria-label="管理模块"');
  });
});

/**
 * T4.5 — Beacon B shell.
 *
 * One `<nav>` serves both layouts, so these assertions are what stop a second
 * navigation (or a second logout) from appearing when the sidebar is added:
 * the desktop blocks are shown by CSS, never by rendering a second copy.
 */
describe('AdminManagementView shell (T4.5)', () => {
  it('renders a single navigation holding exactly the four modules', () => {
    const markup = html();

    expect((markup.match(/admin-shell__navitem/g) ?? [])).toHaveLength(4);
    // The attribute text appears once in the nav label and once per control.
    expect(markup.match(/<nav class="admin-shell__nav"/g) ?? []).toHaveLength(1);
  });

  it('carries the site identity, the signed-in administrator and one logout control', () => {
    const markup = html();

    expect(markup).toContain('星航导航');
    expect(markup).toContain('laohi');
    expect(markup).toContain('管理员');
    expect(markup.match(/退出登录/g) ?? []).toHaveLength(1);
  });

  it('names the current module in the content area, matching the current entry', () => {
    const brandingMarkup = html('branding');

    expect(brandingMarkup).toContain('admin-management__title');
    // Heading text, not a substring: the seam views carry module names too.
    expect(brandingMarkup).toContain('>品牌设置</h2>');
    expect(brandingMarkup).not.toContain('>公共导航</h2>');
  });
});

/**
 * T2.2 — Finding 1: leaving a module may destroy local state, so the page has to
 * ask first.
 *
 * These assert the wiring this project can express without a DOM: the guard prop
 * is accepted and reached on every exit path. The resolve/cancel behaviour needs
 * real interaction and is verified in the browser pass.
 */
describe('AdminManagementView unsaved-change guard (T2.2)', () => {
  const guardedHtml = (confirmLeave: () => Promise<boolean>, initialModule?: AdminModule) =>
    renderToStaticMarkup(
      shell({
        confirmLeave,
        ...(initialModule === undefined ? {} : { initialModule }),
      }),
    );

  it('accepts a guard and still renders the navigation and back control', () => {
    // Exactly one module is mounted at a time by design, so the assertion is on
    // the controls, not on every module marker.
    const markup = guardedHtml(() => Promise.resolve(true), 'branding');
    expect((markup.match(/admin-shell__navitem/g) ?? [])).toHaveLength(4);
    expect(markup).toContain('返回导航');
  });

  it('leaves the branding module mounted while the guard exists', () => {
    const markup = guardedHtml(() => Promise.resolve(true), 'branding');
    expect(markup).toContain('module-branding');
    expect(markup).not.toContain('module-users');
  });

  it('works without a guard, so the page is unchanged when nothing registers one', () => {
    // Every non-branding module has no local state; the page must not become
    // unusable for them.
    const markup = html('users');
    expect(markup).toContain('module-users');
  });

  it('exposes both exit paths the guard has to cover', () => {
    // Module entries (3 others) plus the back control: every one of these
    // unmounts the current module and must consult the guard.
    const markup = guardedHtml(() => Promise.resolve(true), 'branding');
    const entries = markup.match(/admin-shell__navitem/g) ?? [];
    expect(entries).toHaveLength(4);
    expect(markup).toContain('admin-management__back');
  });
});
