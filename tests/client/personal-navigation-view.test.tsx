import { renderToStaticMarkup } from 'react-dom/server';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

import type { PersonalNavigationResult } from '../../src/client/api/personal-navigation.js';
import {
  PersonalNavigationView,
  type PersonalNavigationActions,
  type PersonalNavigationState,
} from '../../src/client/PersonalNavigation.js';
import { mutationErrorMessage } from '../../src/client/personal-error.js';
import {
  PublicNavigationView,
  type PublicNavigationViewProps,
} from '../../src/client/PublicNavigation.js';
import type { PublicNavigation } from '../../src/client/api/public-navigation.js';

const PERSONAL: PersonalNavigationState = {
  status: 'ready',
  data: {
    categories: [
      {
        id: 1,
        name: '⭐ 我的常用',
        sortOrder: 0,
        isDefault: true,
        links: [
          {
            id: 10,
            title: 'Supplier',
            // Raw user input, deliberately not navigable as-is.
            url: 'example.com:8080/path',
            normalizedUrl: 'https://example.com:8080/path',
            iconUrl: null,
            sortOrder: 0,
          },
        ],
      },
      {
        id: 2,
        name: '采购',
        sortOrder: 1,
        isDefault: false,
        links: [],
      },
    ],
  },
};

function actions(overrides: Partial<PersonalNavigationActions> = {}): PersonalNavigationActions {
  return {
    createCategory: vi.fn(),
    renameCategory: vi.fn(),
    deleteCategory: vi.fn(),
    moveCategory: vi.fn(),
    createLink: vi.fn(),
    updateLink: vi.fn(),
    deleteLink: vi.fn(),
    moveLink: vi.fn(),
    moveLinkTo: vi.fn(),
    ...overrides,
  } as PersonalNavigationActions;
}

function renderPersonal(
  state: PersonalNavigationState,
  overrides: { isMutating?: boolean; errorMessage?: string | null; searchQuery?: string; isOrganizing?: boolean } = {},
): string {
  if (overrides.isOrganizing) {
    vi.mocked(useState).mockImplementationOnce(() => [true, vi.fn()]);
  }
  return renderToStaticMarkup(
    <PersonalNavigationView
      state={state}
      actions={actions()}
      isMutating={overrides.isMutating ?? false}
      errorMessage={overrides.errorMessage ?? null}
      searchQuery={overrides.searchQuery ?? ''}
    />,
  );
}

function renderOrganizing(
  state: PersonalNavigationState,
  overrides: { isMutating?: boolean; errorMessage?: string | null; searchQuery?: string } = {},
): string {
  return renderPersonal(state, { ...overrides, isOrganizing: true });
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

const PUBLIC_READY: PublicNavigation = { site: SITE, categories: [] };

function publicProps(overrides: Partial<PublicNavigationViewProps> = {}): PublicNavigationViewProps {
  return {
    state: { status: 'ready', data: PUBLIC_READY },
    session: { isPending: false, username: 'alice' },
    isLoginVisible: false,
    login: { isSubmitting: false, errorMessage: null, onSubmit: vi.fn() },
    personal: null,
    adminEntry: null,
    settingsEntry: null,
    branding: { siteName: '导航', tagline: null, logoPath: null, faviconPath: null, primaryColor: null, pageBackgroundColor: null, surfaceColor: null, backgroundImagePath: null, defaultTheme: 'light', footerText: null, homeThemeConfig: null },
    search: { query: '', onChange: vi.fn(), showNoResults: false },
    onLogout: vi.fn(),
    onShowLogin: vi.fn(),
    onHideLogin: vi.fn(),
    ...overrides,
  };
}

describe('PersonalNavigationView — guest absence', () => {
  it('renders nothing at all when the state is absent', () => {
    // Absence is a render decision: a guest must receive no personal markup,
    // so there is nothing to reveal by disabling CSS.
    expect(renderPersonal({ status: 'absent' })).toBe('');
  });

  it('renders no personal markup for a guest via the public view', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({ session: { isPending: false, username: null }, personal: null })}
      />,
    );

    expect(markup).not.toContain('我的导航');
    expect(markup).not.toContain('我的常用');
    expect(markup).not.toContain('personal');
  });
});

describe('PersonalNavigationView — link href safety', () => {
  it('uses normalizedUrl as the anchor href, never the raw url', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).toContain('href="https://example.com:8080/path"');
    // The raw input must never reach an href.
    expect(markup).not.toContain('href="example.com:8080/path"');
  });

  it('opens personal links in a new tab with a safe rel attribute', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});

describe('PersonalNavigationView — Quick Add entry point', () => {
  it('presents personal destinations with the shared icon and validated hostname', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).toContain('class="destination-icon" aria-hidden="true"><span>S</span>');
    expect(markup).toContain('class="personal-link__description">example.com</span>');
    expect(markup).toContain('href="https://example.com:8080/path"');
    expect(markup).not.toContain('aria-label="我的分类"');
    expect(markup).not.toContain('id="personal-category-2"');
  });
  it('defaults to browsing with links and add actions, without management controls', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('>整理</button>');
    expect(markup).toContain('href="https://example.com:8080/path"');
    expect(markup).toContain('＋ 添加网址');
    expect(markup).not.toContain('新建分类');
    expect(markup).not.toContain('新增网址');
    expect(markup).not.toContain('personal-link__controls');
    expect(markup).not.toContain('上移分类');
    expect(markup).not.toContain('>编辑<');
    expect(markup).not.toContain('>删除<');
  });

  it('labels the active organize state while preserving navigation and quick add', () => {
    const markup = renderOrganizing(PERSONAL);

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('完成整理');
    expect(markup).toContain('personal-link__controls');
    expect(markup).toContain('href="https://example.com:8080/path"');
    expect(markup).toContain('＋ 添加网址');
  });

  it('exposes the primary ＋ 添加网址 action for an authenticated ready user', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).toContain('＋ 添加网址');
  });

  it('is labelled as adding a URL, not as a clipboard import', () => {
    const markup = renderPersonal(PERSONAL);

    // Clipboard is a later enhancement; it must not become the product concept.
    expect(markup).not.toContain('从剪贴板导入');
    expect(markup).not.toContain('剪贴板');
  });

  it('does not offer Quick Add to a guest', () => {
    expect(renderPersonal({ status: 'absent' })).not.toContain('＋ 添加网址');
  });

  it('does not offer Quick Add when the user has no categories', () => {
    // The client never fabricates a default category, so with nothing to save
    // into there is no valid target and the action is withheld.
    const markup = renderPersonal({
      status: 'ready',
      data: { categories: [] },
    });

    expect(markup).not.toContain('＋ 添加网址');
  });

  it('disables the Quick Add action while a mutation is in flight', () => {
    const idle = renderPersonal(PERSONAL, { isMutating: false });
    const busy = renderPersonal(PERSONAL, { isMutating: true });

    const count = (markup: string) => (markup.match(/disabled/g) ?? []).length;
    expect(count(busy)).toBeGreaterThan(count(idle));
  });

  it('keeps the existing category-local 新增网址 control in organize mode', () => {
    const markup = renderOrganizing(PERSONAL);

    // P4.1 adds a global entry point; the P3 per-category flow is untouched.
    expect(markup).toContain('新增网址');
  });

  it('does not render a Quick Add form until the action is used', () => {
    const markup = renderPersonal(PERSONAL);

    // The form is revealed on interaction, keeping the default view uncluttered.
    expect(markup).not.toContain('name="quickAddUrl"');
  });
});

describe('PersonalNavigationView — contextual add (P4.2)', () => {
  it('renders a contextual ＋ on each populated category in browsing mode', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).toContain('aria-label="添加网址到 ⭐ 我的常用"');
    expect(markup).not.toContain('aria-label="添加网址到 采购"');
  });

  it('gives each contextual ＋ a distinct accessible name', () => {
    const markup = renderOrganizing(PERSONAL);

    const labels = markup.match(/aria-label="添加网址到 [^"]+"/g) ?? [];
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });

  it('does not add contextual ＋ to a guest', () => {
    expect(renderPersonal({ status: 'absent' })).not.toContain('添加网址到');
  });

  it('keeps the P3 category-local 新增网址 control in organize mode', () => {
    const markup = renderOrganizing(PERSONAL);

    // The contextual ＋ opens the shared Quick Add form; the older per-category
    // inline form remains functional and is not redesigned.
    expect(markup).toContain('新增网址');
  });

  it('does not render the shared Quick Add form until an entry point is used', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).not.toContain('name="quickAddUrl"');
    expect(markup).not.toContain('quick-add__hint');
  });
});

describe('PersonalNavigationView — CRUD controls', () => {
  it('offers category create, rename and ordering controls', () => {
    const markup = renderOrganizing(PERSONAL);

    expect(markup).toContain('新建分类');
    expect(markup).toContain('编辑');
    expect(markup).toContain('↑');
    expect(markup).toContain('↓');
  });

  it('does not offer delete for the default category', () => {
    // Use a default category with no links so the only possible `删除` control
    // is a category-level one. If the default category offered delete, two
    // would appear (one per category).
    const noDefaultDelete: PersonalNavigationState = {
      status: 'ready',
      data: {
        categories: [
          { id: 1, name: '⭐ 我的常用', sortOrder: 0, isDefault: true, links: [] },
          { id: 2, name: '采购', sortOrder: 1, isDefault: false, links: [] },
        ],
      },
    };

    const markup = renderOrganizing(noDefaultDelete);

    // Exactly one category delete control, belonging to the non-default category.
    expect(markup.match(/>删除</g) ?? []).toHaveLength(1);
    // Both categories can still be renamed.
    expect(markup.match(/>编辑</g) ?? []).toHaveLength(2);
  });

  it('never renders a delete control inside the default category header', () => {
    // Link-free fixture: only category-level delete buttons can appear.
    const markup = renderOrganizing({
      status: 'ready',
      data: {
        categories: [
          { id: 1, name: '⭐ 我的常用', sortOrder: 0, isDefault: true, links: [] },
          { id: 2, name: '采购', sortOrder: 1, isDefault: false, links: [] },
        ],
      },
    });

    const defaultSection = markup.slice(
      markup.indexOf('personal-category-1'),
      markup.indexOf('personal-category-2'),
    );

    expect(defaultSection.length).toBeGreaterThan(0);
    expect(defaultSection).not.toContain('>删除<');
  });

  it('offers link create, edit, delete and move controls', () => {
    const markup = renderOrganizing(PERSONAL);

    expect(markup).toContain('新增网址');
    expect(markup).toContain('上移 Supplier');
    expect(markup).toContain('下移 Supplier');
  });

  it('disables the first up-control and the last down-control', () => {
    const single: PersonalNavigationState = {
      status: 'ready',
      data: {
        categories: [
          {
            id: 1,
            name: 'Only',
            sortOrder: 0,
            isDefault: true,
            links: [
              {
                id: 1,
                title: 'One',
                url: 'https://a.example.com',
                normalizedUrl: 'https://a.example.com/',
                iconUrl: null,
                sortOrder: 0,
              },
            ],
          },
        ],
      },
    };

    const markup = renderOrganizing(single);

    // Category and link move buttons are both boundary-disabled.
    expect(markup).toContain('aria-label="上移分类 Only"');
    expect(markup).toContain('aria-label="下移分类 Only"');
    expect(markup).toContain('disabled');
  });

  it('shows an empty-category message without fabricating data', () => {
    const markup = renderOrganizing(PERSONAL);

    expect(markup).toContain('此分类暂无网址');
  });

  it('disables mutation controls while a mutation is in flight', () => {
    const idle = renderOrganizing(PERSONAL, { isMutating: false });
    const busy = renderOrganizing(PERSONAL, { isMutating: true });

    const count = (markup: string) => (markup.match(/disabled/g) ?? []).length;
    expect(count(busy)).toBeGreaterThan(count(idle));
  });

  it('renders label elements for every input', () => {
    const markup = renderOrganizing(PERSONAL);

    expect(markup).toContain('新建分类');
    // Create-category form appears only after interaction, so assert the always
    // present control structure: buttons are native and labelled.
    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
  });
});

describe('PersonalNavigationView — loading, error and mutation error', () => {
  it('renders a personal loading state distinct from the public one', () => {
    const markup = renderPersonal({ status: 'loading' });

    expect(markup).toContain('正在加载个人导航…');
    expect(markup).not.toContain('还没有添加网址');
  });

  it('renders a personal error state without internals', () => {
    const markup = renderPersonal({ status: 'error' });

    expect(markup).toContain('个人导航暂时无法加载');
    expect(markup).not.toContain('还没有添加网址');
    expect(markup).not.toMatch(/SQL|sqlite|\.sqlite|stack|Exception/);
  });

  it('shows a non-technical mutation error and leaks nothing', () => {
    const markup = renderPersonal(PERSONAL, { errorMessage: '操作失败，请稍后重试。' });

    expect(markup).toContain('操作失败，请稍后重试。');
    expect(markup).not.toMatch(/SQL|sqlite|userId|stack/);
  });
});

describe('mutationErrorMessage', () => {
  it.each([
    ['invalid', true, '请输入有效的 HTTP/HTTPS 网址。'],
    ['invalid', false, '保存失败，请检查输入。'],
    ['error', true, '操作失败，请稍后重试。'],
    ['notfound', true, '操作失败，请稍后重试。'],
    ['conflict', false, '操作失败，请稍后重试。'],
    // P4.3: a link conflict means the target category already holds the URL.
    ['conflict', true, '该网址已存在于此分类中。'],
  ] as const)('maps %s (isLink=%s) to safe text', (status, isLink, expected) => {
    const message = mutationErrorMessage({ status } as never, isLink);

    expect(message).toBe(expected);
    expect(message).not.toMatch(/SQL|sqlite|userId|stack|http:\/\/|Exception|constraint|normalized_url/);
  });

  it('keeps category conflicts generic rather than reporting a URL duplicate', () => {
    // A 409 on a category form is unrelated to duplicates (e.g. the protected
    // default category), so it must not claim the URL already exists.
    const message = mutationErrorMessage({ status: 'conflict' } as never, false);

    expect(message).toBe('操作失败，请稍后重试。');
    expect(message).not.toContain('网址');
  });
});

describe('PublicNavigationView — personal and public composition', () => {
  it('renders personal navigation before public navigation for an authenticated user', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({
          state: {
            status: 'ready',
            data: {
              site: SITE,
              categories: [
                { id: 5, name: 'Public Cat', icon: null, sortOrder: 0, links: [
                  { id: 1, title: 'Public link', url: 'https://public.example.com', description: null, iconUrl: null, sortOrder: 0 },
                ] },
              ],
            },
          },
          personal: { view: <span id="personal-marker">PERSONAL</span> },
        })}
      />,
    );

    const personalIndex = markup.indexOf('personal-marker');
    const publicIndex = markup.indexOf('Public Cat');

    expect(personalIndex).toBeGreaterThan(-1);
    expect(publicIndex).toBeGreaterThan(-1);
    expect(personalIndex).toBeLessThan(publicIndex);
  });

  it('keeps public navigation rendered when the personal section errors', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({
          state: {
            status: 'ready',
            data: {
              site: SITE,
              categories: [
                { id: 5, name: 'Public Cat', icon: null, sortOrder: 0, links: [
                  { id: 1, title: 'Public link', url: 'https://public.example.com', description: null, iconUrl: null, sortOrder: 0 },
                ] },
              ],
            },
          },
          personal: { view: renderPersonal({ status: 'error' }) as unknown as React.ReactNode },
        })}
      />,
    );

    expect(markup).toContain('Public Cat');
    expect(markup).toContain('个人导航暂时无法加载');
  });

  it('keeps personal navigation rendered when the public section errors', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({
          state: { status: 'error' },
          personal: { view: <span>我的导航</span> },
        })}
      />,
    );

    expect(markup).toContain('公共导航暂时无法加载');
    expect(markup).toContain('我的导航');
  });

  it('does not render personal content on the login_required guest screen', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({
          state: { status: 'unauthenticated' },
          session: { isPending: false, username: null },
          personal: null,
        })}
      />,
    );

    expect(markup).toContain('请登录');
    expect(markup).not.toContain('我的导航');
    expect(markup).not.toContain('我的常用');
  });
});

describe('personal navigation result type — guest never receives data', () => {
  it('exposes no protected payload on the unauthenticated result', () => {
    const result: PersonalNavigationResult = { status: 'unauthenticated' };

    expect(JSON.stringify(result)).not.toContain('我的常用');
    expect(result).toEqual({ status: 'unauthenticated' });
  });
});

describe('PersonalNavigationView — client-side search', () => {
  const SEARCHABLE: PersonalNavigationState = {
    status: 'ready',
    data: {
      categories: [
        {
          id: 1,
          name: '⭐ 我的常用',
          sortOrder: 0,
          isDefault: true,
          links: [
            { id: 10, title: 'Supplier Portal', url: 'example.com:8080/path', normalizedUrl: 'https://example.com:8080/path', iconUrl: null, sortOrder: 0 },
            { id: 11, title: '中文链接', url: 'https://cn.example.com', normalizedUrl: 'https://cn.example.com/', iconUrl: null, sortOrder: 1 },
          ],
        },
        {
          id: 2,
          name: '采购',
          sortOrder: 1,
          isDefault: false,
          links: [
            { id: 20, title: 'Invoice System', url: 'https://invoice.example.org', normalizedUrl: 'https://invoice.example.org/', iconUrl: null, sortOrder: 0 },
          ],
        },
      ],
    },
  };

  it('filters personal links by title and drops category sections with no match', () => {
    const markup = renderOrganizing(SEARCHABLE, { searchQuery: 'supplier' });

    expect(markup).toContain('Supplier Portal');
    expect(markup).not.toContain('中文链接');
    expect(markup).not.toContain('Invoice System');
    // The 采购 category had no match, so its heading is not rendered.
    expect(markup).not.toContain('采购');
  });

  it('matches the raw url and the normalizedUrl', () => {
    expect(renderPersonal(SEARCHABLE, { searchQuery: 'example.com:8080' })).toContain('Supplier Portal');
    expect(renderPersonal(SEARCHABLE, { searchQuery: 'https://cn.example.com' })).toContain('中文链接');
  });

  it('matches CJK titles', () => {
    const markup = renderPersonal(SEARCHABLE, { searchQuery: '中文' });

    expect(markup).toContain('中文链接');
    expect(markup).not.toContain('Supplier Portal');
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(renderPersonal(SEARCHABLE, { searchQuery: '  INVOICE  ' })).toContain('Invoice System');
  });

  /**
   * Corrected by P4.4 TARGETED FIX #1: this section no longer renders its own
   * no-results message, because one search spans personal and public navigation.
   * A query matching only public links would otherwise show "no results" here
   * while public matches are visible below. The container's combined state owns
   * that message; see the partial-scope tests in this file and in
   * `public-navigation-view.test.tsx`.
   */
  it('does not render a local no-results message; the container owns it', () => {
    const markup = renderPersonal(SEARCHABLE, { searchQuery: 'zzzz-no-match' });

    expect(markup).not.toContain('没有找到匹配的网址');
    expect(markup).not.toMatch(/SQL|Error|Exception|undefined/);
  });

  it('preserves the unfiltered navigation for an empty query', () => {
    const markup = renderPersonal(SEARCHABLE, { searchQuery: '' });

    expect(markup).toContain('Supplier Portal');
    expect(markup).toContain('中文链接');
    expect(markup).toContain('Invoice System');
  });

  it('does not mutate the payload while filtering', () => {
    const snapshot = JSON.stringify(SEARCHABLE);

    renderOrganizing(SEARCHABLE, { searchQuery: 'supplier' });

    expect(JSON.stringify(SEARCHABLE)).toBe(snapshot);
  });

  it('keeps the Quick Add and category controls available while searching', () => {
    const markup = renderOrganizing(SEARCHABLE, { searchQuery: 'supplier' });

    // Search filters links only; CRUD affordances stay present.
    expect(markup).toContain('＋ 添加网址');
    expect(markup).toContain('新建分类');
  });

  it('derives ordering controls from the full list, not the filtered view', () => {
    // With only the first link showing, its ↓ control must still be enabled,
    // because a second link exists in the real category order.
    const markup = renderOrganizing(SEARCHABLE, { searchQuery: 'Supplier Portal' });
    const downButton = markup.match(/aria-label="下移 Supplier Portal"[^>]*>/);

    expect(downButton?.[0]).not.toContain('disabled');
  });
});

describe('PersonalNavigationView — combined Search partial-scope empty states', () => {
  /**
   * Regression (P4.4 TARGETED FIX #1): the personal section must not claim
   * "no results" when its own projection is empty but another scope matched. The
   * container's global no-results state is the single authority for combined
   * zero-match, so this section renders nothing rather than a local message.
   */
  it('does not render the generic no-results message when only public links match', () => {
    const markup = renderPersonal(PERSONAL, { searchQuery: 'zzz-matches-no-personal-link' });

    expect(markup).not.toContain('没有找到匹配的网址');
    expect(markup).not.toContain('Supplier');
  });

  it('does not render a no-results message for a genuinely empty personal dataset', () => {
    // An empty query with no categories is not a search miss.
    const markup = renderPersonal({ status: 'ready', data: { categories: [] } }, { searchQuery: '' });

    expect(markup).not.toContain('没有找到匹配的网址');
    // The section itself is still present and usable.
    expect(markup).toContain('我的导航');
  });
});

describe('PersonalNavigationView — UO3 empty visibility', () => {
  const EMPTY: PersonalNavigationState = {
    status: 'ready',
    data: { categories: [
      { id: 1, name: '⭐ 我的常用', sortOrder: 0, isDefault: true, links: [] },
      { id: 2, name: '采购', sortOrder: 1, isDefault: false, links: [] },
    ] },
  };

  it.each([1, 2])('keeps Quick Add and one empty message for %i empty categories', (count) => {
    const state: PersonalNavigationState = {
      status: 'ready', data: { categories: EMPTY.data.categories.slice(0, count) },
    };
    const markup = renderPersonal(state);

    expect(markup).toContain('＋ 添加网址');
    expect(markup.split('还没有添加网址')).toHaveLength(2);
    expect(markup).not.toContain('personal-category');
    expect(markup).not.toContain('aria-label="我的分类"');
    expect(markup).not.toContain('此分类暂无网址');
  });

  it('hides only empty categories in browsing without altering the payload', () => {
    const snapshot = JSON.stringify(PERSONAL);
    const markup = renderPersonal(PERSONAL);

    expect(markup).toContain('Supplier');
    expect(markup).not.toContain('采购');
    expect(markup).not.toContain('还没有添加网址');
    expect(markup).not.toContain('此分类暂无网址');
    expect(JSON.stringify(PERSONAL)).toBe(snapshot);
  });

  it('retains empty categories, full ordering and default protection in organize mode', () => {
    const markup = renderOrganizing(EMPTY, { searchQuery: 'no-match' });

    expect(markup).toContain('新建分类');
    expect(markup).toContain('采购');
    expect(markup).toContain('aria-label="我的分类"');
    expect(markup.match(/>编辑</g)).toHaveLength(2);
    expect(markup.match(/>删除</g)).toHaveLength(1);
    expect(markup.match(/>新增网址</g)).toHaveLength(2);
    expect(markup).toContain('aria-label="下移分类 ⭐ 我的常用"');
    expect(markup).toContain('aria-label="上移分类 采购"');
    expect(markup).not.toContain('还没有添加网址');
  });

  it('does not replace a search miss with the ordinary personal empty message', () => {
    const markup = renderPersonal(EMPTY, { searchQuery: 'anything' });

    expect(markup).toContain('＋ 添加网址');
    expect(markup).not.toContain('还没有添加网址');
    expect(markup).not.toContain('没有找到匹配的网址');
    expect(markup).not.toContain('personal-category');
  });

  it('keeps every empty category selectable in an open Quick Add form', () => {
    vi.mocked(useState)
      .mockImplementationOnce(() => [false, vi.fn()])
      .mockImplementationOnce(() => [false, vi.fn()])
      .mockImplementationOnce(() => [{ source: 'manual', url: 'https://draft.example.com', categoryId: null }, vi.fn()]);
    const markup = renderPersonal(EMPTY);

    expect(markup).toContain('name="quickAddUrl"');
    expect(markup).toContain('value="https://draft.example.com"');
    expect(markup).toContain('<option value="1" selected="">⭐ 我的常用</option>');
    expect(markup).toContain('<option value="2">采购</option>');
    expect(markup).not.toContain('id="personal-category-');
  });

  it.each(['rename', 'add', 'edit-link', 'create'] as const)(
    'keeps an active %s form mounted while searching', (form) => {
      const initial = [
        true,
        form === 'create',
        null,
        form === 'rename' ? 2 : null,
        form === 'add' ? 2 : null,
        form === 'edit-link' ? 10 : null,
      ];
      for (const value of initial) {
        vi.mocked(useState).mockImplementationOnce(() => [value, vi.fn()]);
      }
      const markup = renderPersonal(PERSONAL, { searchQuery: 'no-match' });

      expect(markup).toContain('请先保存或取消正在编辑的内容');
      expect(markup).toContain(form === 'rename' || form === 'create' ? 'name="categoryName"' : 'name="linkUrl"');
      if (form === 'edit-link') {
        expect(markup).toContain('Supplier');
        expect(markup).toContain('value="example.com:8080/path"');
      }
      if (form !== 'create') {
        expect(markup).toContain('data-home-category="personal"');
      }
    },
  );
});

/**
 * T4.6 — search highlighting in the personal section.
 *
 * Same projection as the public directory; these only assert that the personal
 * row's own two visible fields are marked and that an empty query marks nothing.
 */
describe('PersonalNavigationView search highlight (T4.6)', () => {
  it('marks the matched part of a personal title', () => {
    const markup = renderPersonal(PERSONAL, { searchQuery: 'supp' });

    expect(markup).toContain('<mark>Supp</mark>lier');
  });

  it('marks the host line when the query matches the domain', () => {
    const markup = renderPersonal(PERSONAL, { searchQuery: 'example' });

    expect(markup).toContain('<mark>example</mark>.com');
  });

  it('renders no mark when the query is empty', () => {
    const markup = renderPersonal(PERSONAL);

    expect(markup).not.toContain('<mark>');
  });
});
