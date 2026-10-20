import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    moveLinkTo: vi.fn(),
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
    branding: { siteName: '导航', tagline: null, logoPath: null, faviconPath: null, primaryColor: null, pageBackgroundColor: null, surfaceColor: null, backgroundImagePath: null, defaultTheme: 'light', footerText: null, homeThemeConfig: null },
    search: { query: '', onChange: vi.fn(), showNoResults: false },
    onLogout: vi.fn(),
    onShowLogin: vi.fn(),
    onHideLogin: vi.fn(),
    ...overrides,
  };
}

/** The row's always-visible control strip; the overflow panel lives outside it. */
function rowControls(markup: string): string {
  const open = markup.indexOf('<div class="admin-link__controls">');
  return markup.slice(open, markup.indexOf('</div>', open) + 6);
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

/*
 * ── T4.1：管理界面的结构约定 ─────────────────────────────────────────────
 *
 * 这些断言守的都是**静默失效**：计数或抽屉底部条没了，页面照样渲染，
 * 只是管理员又回到了「这个网址属于哪个分类」要靠数行数的样子。
 * 徽章那条更特别 —— 它守的是一个**减法**：161 行各挂一个「显示」徽章，
 * 删掉之后不会有任何报错，只会更安静。
 */
describe('AdminPublicNavigationView — T4.1 structure', () => {
  it('tells the administrator how large each category is', () => {
    const markup = renderAdmin(ADMIN_NAV);

    // Without the count, the size of a category is only knowable by counting rows.
    expect(markup).toContain('1 个网址');
    expect(markup).toContain('admin-category__count');
  });

  it('labels the hidden state only where it contradicts the default', () => {
    const markup = renderAdmin(ADMIN_NAV);

    // The badge rides on the row, not on the category, so it can be counted per row.
    expect(markup).toMatch(/admin-link admin-link--hidden"[^]*?admin-link__badge/);
    // And a visible row carries none: the old markup put 「显示」 on every row,
    // which on this fixture means a badge per link saying nothing.
    const visibleRow = markup.slice(markup.indexOf('Visible Link') - 400, markup.indexOf('Visible Link') + 600);
    expect(visibleRow).not.toContain('admin-link__badge');
  });

  it('puts each category\'s own action in a strip below its entries', () => {
    const markup = renderAdmin(ADMIN_NAV);

    // 「新增网址」 used to sit inside the list with the same alignment as every
    // entry, so it read as one more item; the footer is what closes the drawer.
    expect(markup).toContain('admin-category__footer');
    expect(markup).toMatch(/admin-category__footer[^]*?＋ 新增网址/);
  });

  it('keeps the destructive action separated from the neutral run', () => {
    /*
     * T4.2 moved 删除 out of the permanent controls and into the overflow panel.
     * The intent is unchanged and stronger than before: the destructive action is
     * never adjacent to a neutral one, and now it is not one stray tap away
     * from every row either.
     *
     * "Set apart" is enforced by spacing, so that is what is asserted — asserting
     * on the order of class names inside the JSX would be a statement about
     * formatting, not about behaviour.
     */
    const css = readFileSync(fileURLToPath(new URL('../../src/client/styles/main.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.admin-row-menu \.admin__button--danger \{[^}]*margin-inline-start/);

    const markup = renderAdmin(ADMIN_NAV);
    // Nothing destructive is reachable without opening the panel first.
    expect(rowControls(markup)).not.toContain('admin__button--danger');
  });

  it('keeps category-level actions inside the category header', () => {
    const markup = renderAdmin(ADMIN_NAV);

    // The two levels look identical and must not be confusable in the DOM either:
    // a category's controls belong to the header, a row's belong to the row.
    expect(markup).toMatch(/admin-category__header[^]*?admin-category__controls/);
    const header = markup.slice(markup.indexOf('admin-category__header'), markup.indexOf('admin-category__header') + 700);
    expect(header).toContain('上移分类');
    expect(header).not.toContain('Visible Link');
  });
});

/*
 * ── T4.2：行内操作收敛 ───────────────────────────────────────────────────
 *
 * 守的是**密度**：常驻操作从 6 个降到 4 个。这类改动不会报错，只会让页面安静地
 * 变好或变坏，所以必须由断言钉住数字。
 */
describe('AdminPublicNavigationView — T4.2 inline action density', () => {
  it('leaves four permanent controls on a row', () => {
    const buttons = rowControls(renderAdmin(ADMIN_NAV)).match(/<button/g) ?? [];
    expect(buttons, 'reorder, reorder, edit, more').toHaveLength(4);
  });

  it('keeps reorder and edit permanent and moves the rest behind the panel', () => {
    const controls = rowControls(renderAdmin(ADMIN_NAV));

    // Reorder is what a launchpad is for and the operation repeated most often;
    // burying it behind a disclosure would trade the page's job for tidiness.
    expect(controls).toContain('上移 Visible Link');
    expect(controls).toContain('下移 Visible Link');
    expect(controls).toContain('编辑');
    expect(controls).toContain('更多');
    // And the destructive action is *not* one click away from every row any more.
    expect(controls).not.toContain('删除');
    expect(controls).not.toContain('admin__button--danger');
  });

  it('gives the overflow trigger a name and an open state', () => {
    const markup = renderAdmin(ADMIN_NAV);
    const controls = rowControls(markup);

    expect(controls).toMatch(/aria-label="更多操作：Visible Link"/);
    expect(controls).toContain('aria-expanded="false"');
    // `aria-controls` is only meaningful while open; pointing it at a panel that
    // is not rendered is a dangling reference.
    expect(controls).not.toContain('aria-controls');
  });

  it('renders nothing but the trigger while closed', () => {
    const markup = renderAdmin(ADMIN_NAV);

    expect(markup).not.toContain('admin-row-menu');
  });

  it('offers every collapsed action inside the panel, and nothing missing', () => {
    /*
     * `renderToStaticMarkup` runs no interaction, so the panel cannot be opened
     * here. What *can* be asserted without a browser is that the panel's markup
     * exists and is bound to the row — the browser evidence in
     * `verify-t3/interaction-t42.mjs` covers opening it.
     */
    const source = readFileSync(fileURLToPath(new URL('../../src/client/AdminPublicNavigation.tsx', import.meta.url)), 'utf8');

    for (const label of ['隐藏此网址', '显示此网址', '删除此网址', '<LinkMove']) {
      expect(source, `${label} must remain reachable`).toContain(label);
    }
    // The panel is rendered as a child of the row (not of the controls strip):
    // that is what lets CSS give it the full row width, which is why it cannot be
    // clipped by the viewport edge on a phone.
    expect(source).toContain('<div className="admin-row-menu" id={menuId}>');
    expect(source.indexOf('className="admin-row-menu"')).toBeGreaterThan(source.indexOf('</div>'));
  });
});

/*
 * ── T4.2.1：Escape 事件优先级 ───────────────────────────────────────────
 *
 * 守的是一个**只在真实 DOM 里发生的冲突**：删除确认是原生 `<dialog>`
 * （showModal），它靠 keydown 的**默认动作**走自己的 cancel 事件关闭。
 * 行内面板开着的期间，document 级监听若先 `preventDefault()`，对话框就
 * 再也收不到 Escape。`renderToStaticMarkup` 不挂监听、不弹对话框，
 * 测不出这个行为 —— 但**删掉那个优先级判断**不会有任何报错，只会静默
 * 回到 T4.2 的冲突。所以这里钉住源码里的判断顺序，真实浏览器证据在
 * `review/t4.2.1/interaction.json`（修复前 25/35、修复后全过）。
 */
describe('AdminPublicNavigationView — T4.2.1 Escape priority', () => {
  it('yields Escape to an open native modal dialog before preventing the default', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/client/AdminPublicNavigation.tsx', import.meta.url)), 'utf8');

    const handlerStart = source.indexOf('const onKeyDown = (event: KeyboardEvent)');
    expect(handlerStart, 'the row menu Escape listener must exist').toBeGreaterThan(-1);
    const handler = source.slice(handlerStart, source.indexOf("document.addEventListener('keydown'", handlerStart));

    // Same idiom `PersonalNavigation` and `useConfirmation` already use, and
    // every `<dialog>` in this app is opened with `showModal()`, so
    // `dialog[open]` is exactly "a native modal owns the keyboard".
    const guard = handler.indexOf("document.querySelector('dialog[open]')");
    expect(guard, 'the Escape handler must detect an open dialog').toBeGreaterThan(-1);

    // Priority is the whole fix: the dialog check must come **before** the
    // preventDefault that used to swallow the dialog's own close action.
    const prevent = handler.indexOf('event.preventDefault()');
    expect(prevent, 'the handler must still preventDefault for the panel').toBeGreaterThan(-1);
    expect(guard, 'the dialog check must come before preventDefault').toBeLessThan(prevent);

    // And it must yield — not fall through to the panel close.
    expect(handler.slice(guard, prevent), 'the handler must return, not fall through').toContain('return');
  });
});
