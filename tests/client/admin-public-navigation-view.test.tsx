import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AdminPublicNavigationView,
  type AdminPublicNavigationActions,
  type AdminPublicNavigationState,
} from '../../src/client/AdminPublicNavigation.js';
import {
  PublicNavigationView,
  type PublicNavigationViewProps,
} from '../../src/client/PublicNavigation.js';
import type { PublicNavigation } from '../../src/client/api/public-navigation.js';

const ADMIN_NAV: AdminPublicNavigationState = {
  status: 'ready',
  data: {
    categories: [
      {
        id: 1,
        name: 'Visible Cat',
        icon: null,
        sortOrder: 0,
        isVisible: true,
        links: [
          {
            id: 10,
            categoryId: 1,
            title: 'Visible Link',
            url: 'https://visible.example.com/',
            description: null,
            iconUrl: null,
            sortOrder: 0,
            isVisible: true,
          },
        ],
      },
      {
        id: 2,
        name: 'Hidden Cat',
        icon: null,
        sortOrder: 1,
        isVisible: false,
        links: [
          {
            id: 20,
            categoryId: 2,
            title: 'Hidden Link',
            url: 'https://hidden.example.com/',
            description: null,
            iconUrl: null,
            sortOrder: 0,
            isVisible: false,
          },
        ],
      },
    ],
  },
};

function actions(overrides: Partial<AdminPublicNavigationActions> = {}): AdminPublicNavigationActions {
  return {
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    deleteCategory: vi.fn(),
    moveCategory: vi.fn(),
    createLink: vi.fn(),
    updateLink: vi.fn(),
    deleteLink: vi.fn(),
    moveLink: vi.fn(),
    toggleLinkVisibility: vi.fn(),
    toggleCategoryVisibility: vi.fn(),
    ...overrides,
  } as AdminPublicNavigationActions;
}

function renderAdmin(
  state: AdminPublicNavigationState,
  overrides: { isMutating?: boolean; errorMessage?: string | null } = {},
): string {
  return renderToStaticMarkup(
    <AdminPublicNavigationView
      state={state}
      actions={actions()}
      isMutating={overrides.isMutating ?? false}
      errorMessage={overrides.errorMessage ?? null}
    />,
  );
}

const SITE: NonNullable<PublicNavigation['site']> = {
  id: 1,
  siteName: 'Example Navigation',
  tagline: null,
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  defaultTheme: 'light',
  footerText: null,
  accessMode: 'public',
};

function publicProps(overrides: Partial<PublicNavigationViewProps> = {}): PublicNavigationViewProps {
  return {
    state: { status: 'ready', data: { site: SITE, categories: [] } },
    session: { isPending: false, username: 'admina' },
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

describe('AdminPublicNavigationView — visibility boundary', () => {
  it('renders nothing at all when the state is absent', () => {
    // A guest or normal user must receive no admin markup whatsoever.
    expect(renderAdmin({ status: 'absent' })).toBe('');
  });

  it('renders no admin management markup on Home (UX-IA)', () => {
    // Public-navigation management moved to Admin Management; Home renders only
    // the entry point at most. Composition is covered by the
    // AdminManagementView tests.
    const markup = renderToStaticMarkup(
      <PublicNavigationView {...publicProps({ adminEntry: { onOpenAdmin: () => {} } })} />,
    );

    expect(markup).not.toContain('管理公共导航');
  });
});

describe('AdminPublicNavigationView — hidden row presentation', () => {
  it('renders both visible and hidden categories and links', () => {
    const markup = renderAdmin(ADMIN_NAV);

    expect(markup).toContain('Visible Cat');
    expect(markup).toContain('Hidden Cat');
    expect(markup).toContain('Visible Link');
    expect(markup).toContain('Hidden Link');
  });

  it('labels visibility in plain language rather than database terms', () => {
    const markup = renderAdmin(ADMIN_NAV);

    expect(markup).toContain('显示');
    expect(markup).toContain('隐藏');
    for (const technical of ['is_visible', 'isVisible', 'sort_order', 'sortOrder']) {
      expect(markup, technical).not.toContain(technical);
    }
  });

  it('marks hidden rows with a distinct class', () => {
    const markup = renderAdmin(ADMIN_NAV);

    expect(markup).toContain('admin-category--hidden');
    expect(markup).toContain('admin-link--hidden');
  });
});

describe('AdminPublicNavigationView — controls', () => {
  it('offers create, edit, delete, visibility and reorder controls', () => {
    const markup = renderAdmin(ADMIN_NAV);

    expect(markup).toContain('新建分类');
    expect(markup).toContain('新增网址');
    expect(markup).toContain('编辑');
    expect(markup).toContain('删除');
    expect(markup).toContain('上移分类 Visible Cat');
    expect(markup).toContain('下移分类 Visible Cat');
    expect(markup).toContain('上移 Visible Link');
    expect(markup).toContain('下移 Visible Link');
  });

  it('disables boundary move controls', () => {
    const markup = renderAdmin(ADMIN_NAV);
    const firstUp = markup.match(/aria-label="上移分类 Visible Cat"[^>]*>/);

    expect(firstUp?.[0]).toContain('disabled');
  });

  it('disables mutation controls while a mutation is in flight', () => {
    const count = (markup: string) => (markup.match(/disabled/g) ?? []).length;

    expect(count(renderAdmin(ADMIN_NAV, { isMutating: true }))).toBeGreaterThan(
      count(renderAdmin(ADMIN_NAV, { isMutating: false })),
    );
  });

  it('renders no form until a control is used', () => {
    const markup = renderAdmin(ADMIN_NAV);

    expect(markup).not.toContain('name="adminCategoryName"');
    expect(markup).not.toContain('name="adminLinkTitle"');
  });
});

describe('AdminPublicNavigationView — loading, error, empty', () => {
  it('renders a loading state', () => {
    expect(renderAdmin({ status: 'loading' })).toContain('正在加载公共导航管理');
  });

  it('renders a generic error state without internals', () => {
    const markup = renderAdmin({ status: 'error' });

    expect(markup).toContain('公共导航管理暂时无法加载');
    expect(markup).not.toMatch(/SQL|sqlite|Error:|Exception|stack/);
  });

  it('shows a plain mutation error and leaks nothing', () => {
    const markup = renderAdmin(ADMIN_NAV, { errorMessage: '保存失败，请检查输入。' });

    expect(markup).toContain('保存失败，请检查输入。');
    expect(markup).not.toMatch(/SQL|sqlite|constraint|stack/i);
  });

  it('renders an empty state when there are no public categories', () => {
    const markup = renderAdmin({ status: 'ready', data: { categories: [] } });

    expect(markup).toContain('暂无公共导航内容');
  });
});
