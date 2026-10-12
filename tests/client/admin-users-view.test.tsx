import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AdminUsersView,
  type AdminUsersActions,
  type AdminUsersState,
  type AdminUsersViewProps,
} from '../../src/client/AdminUsers.js';
import {
  PublicNavigationView,
  type PublicNavigationViewProps,
} from '../../src/client/PublicNavigation.js';
import type { AdminUser } from '../../src/client/api/admin-users.js';
import type { PublicNavigation } from '../../src/client/api/public-navigation.js';

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'u1',
    name: 'User One',
    email: 'u1@example.com',
    emailVerified: true,
    image: null,
    username: 'userone',
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const USERS: AdminUsersState = {
  status: 'ready',
  users: [
    user({ id: 'admin-1', username: 'admin', name: 'Admin', email: 'admin@example.com', role: 'admin' }),
    user({ id: 'u1', username: 'userone', name: 'User One', email: 'u1@example.com' }),
    user({ id: 'u2', username: 'usertwo', name: 'User Two', email: 'u2@example.com', banned: true, banReason: 'Disabled by administrator' }),
  ],
};

function actions(overrides: Partial<AdminUsersActions> = {}): AdminUsersActions {
  return {
    createUser: vi.fn(),
    disableUser: vi.fn(),
    enableUser: vi.fn(),
    resetPassword: vi.fn(),
    deleteUser: vi.fn(),
    ...overrides,
  } as AdminUsersActions;
}

function renderUsers(
  state: AdminUsersState,
  overrides: {
    isMutating?: boolean;
    errorMessage?: string | null;
    currentUserId?: string | null;
    actions?: AdminUsersActions;
    pagination?: AdminUsersViewProps['pagination'];
  } = {},
): string {
  return renderToStaticMarkup(
    <AdminUsersView
      state={state}
      actions={overrides.actions ?? actions()}
      isMutating={overrides.isMutating ?? false}
      errorMessage={overrides.errorMessage ?? null}
      currentUserId={overrides.currentUserId === undefined ? 'admin-1' : overrides.currentUserId}
      pagination={overrides.pagination ?? { page: 0, total: state.status === 'ready' ? state.users.length : null, onPageChange: vi.fn() }}
    />,
  );
}

const SITE: NonNullable<PublicNavigation['site']> = {
  id: 1,
  siteName: 'Nav',
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
    session: { isPending: false, username: 'admin' },
    isLoginVisible: false,
    login: { isSubmitting: false, errorMessage: null, onSubmit: vi.fn() },
    personal: null,
    adminEntry: null,
    settingsEntry: null,
    branding: {
      pageBackgroundColor: null,
      surfaceColor: null,
      backgroundImagePath: null,
      siteName: 'Nav',
      tagline: null,
      logoPath: null,
      faviconPath: null,
      primaryColor: null,
      defaultTheme: 'light',
      footerText: null,
    },
    search: { query: '', onChange: vi.fn(), showNoResults: false },
    onLogout: vi.fn(),
    onShowLogin: vi.fn(),
    onHideLogin: vi.fn(),
    ...overrides,
  };
}

describe('AdminUsersView — visibility boundary', () => {
  it('renders nothing at all when the state is absent', () => {
    // Guest and ordinary-user sessions must receive no user-management markup.
    expect(renderUsers({ status: 'absent' })).toBe('');
  });

  it('renders no user-management markup on Home for a guest or user (UX-IA)', () => {
    // Home no longer composes management views at all; the markup must be absent
    // regardless of the session. Composition into Admin Management is covered by
    // the AdminManagementView tests.
    const guest = renderToStaticMarkup(
      <PublicNavigationView {...publicProps({ session: { isPending: false, username: null } })} />,
    );
    const user = renderToStaticMarkup(
      <PublicNavigationView {...publicProps({ session: { isPending: false, username: 'userone' } })} />,
    );

    expect(guest).not.toContain('用户管理');
    expect(user).not.toContain('用户管理');
  });
});

describe('AdminUsersView — pagination', () => {
  it.each([
    [0, 0, 1, true, true],
    [99, 0, 1, true, true],
    [100, 0, 1, true, true],
    [101, 0, 2, true, false],
    [101, 1, 2, false, true],
    [200, 1, 2, false, true],
    [201, 1, 3, false, false],
    [201, 2, 3, false, true],
  ] as const)('uses total %i and page %i to show boundaries', (total, page, count, previousDisabled, nextDisabled) => {
    const markup = renderUsers(USERS, { pagination: { page, total, onPageChange: vi.fn() } });
    expect(markup).toContain(`第 ${page + 1} / ${count} 页`);
    expect(markup).toContain(`共 ${total} 个用户`);
    expect(markup.match(/<button[^>]*>上一页<\/button>/)?.[0]?.includes('disabled')).toBe(previousDisabled);
    expect(markup.match(/<button[^>]*>下一页<\/button>/)?.[0]?.includes('disabled')).toBe(nextDisabled);
  });

  it('keeps navigation available while a page is loading without rendering old rows', () => {
    const markup = renderUsers({ status: 'loading' }, {
      pagination: { page: 1, total: 201, onPageChange: vi.fn() },
    });
    expect(markup).toContain('正在加载用户列表');
    expect(markup).toContain('第 2 / 3 页');
    expect(markup).not.toContain('userone');
    expect(markup.match(/<button[^>]*>下一页<\/button>/)?.[0]).not.toContain('disabled');
  });
});

describe('AdminUsersView — list rendering', () => {
  it('shows username, display name, email, role and state for each account', () => {
    const markup = renderUsers(USERS);

    expect(markup).toContain('userone');
    expect(markup).toContain('User One');
    expect(markup).toContain('u1@example.com');
    expect(markup).toContain('普通用户');
    expect(markup).toContain('管理员');
    expect(markup).toContain('已启用');
    expect(markup).toContain('已停用');
  });

  it('distinguishes disabled accounts explicitly', () => {
    const markup = renderUsers(USERS);

    // Both a textual state and a distinguishing class are present.
    expect(markup).toContain('已停用');
    expect(markup).toContain('user-row--disabled');
  });

  it('renders account data as text, never as markup', () => {
    const hostile = user({
      id: 'x',
      username: '<script>alert(1)</script>',
      name: '<img src=x onerror=alert(2)>',
      email: 'x@example.com',
    });
    const markup = renderUsers({ status: 'ready', users: [hostile] });

    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;script&gt;');
  });
});

describe('AdminUsersView — actions', () => {
  it('offers a create control', () => {
    const markup = renderUsers(USERS);

    expect(markup).toContain('＋ 创建用户');
  });

  it('offers disable on an enabled account and enable on a disabled one', () => {
    const markup = renderUsers(USERS);

    expect(markup).toContain('停用');
    expect(markup).toContain('启用');
  });

  it('offers password reset and delete', () => {
    const markup = renderUsers(USERS);

    expect(markup).toContain('重置密码');
    expect(markup).toContain('删除');
  });

  it('does not offer disable or delete for the current admin account', () => {
    const markup = renderUsers(USERS);
    const selfSection = markup.slice(markup.indexOf('admin@example.com'), markup.indexOf('u1@example.com'));

    // The self row is identified and exposes no destructive action.
    expect(selfSection).toContain('当前账号');
    expect(selfSection).not.toContain('>停用<');
    expect(selfSection).not.toContain('>删除<');
    // Password reset for self is still allowed.
    expect(selfSection).toContain('重置密码');
  });

  it('does not show a role selector anywhere', () => {
    const markup = renderUsers(USERS);

    for (const forbidden of ['选择角色', 'role="admin"', 'name="role"', '设为管理员', '提升']) {
      expect(markup, forbidden).not.toContain(forbidden);
    }
  });

  it('disables controls while a mutation is in flight', () => {
    const count = (markup: string) => (markup.match(/disabled/g) ?? []).length;

    expect(count(renderUsers(USERS, { isMutating: true }))).toBeGreaterThan(
      count(renderUsers(USERS, { isMutating: false })),
    );
  });

  it('renders no form until a control is used', () => {
    const markup = renderUsers(USERS);

    expect(markup).not.toContain('name="newUsername"');
    expect(markup).not.toContain('name="resetPassword"');
  });
});

describe('AdminUsersView — loading, error, empty', () => {
  it('renders a loading state', () => {
    expect(renderUsers({ status: 'loading' })).toContain('正在加载用户列表');
  });

  it('renders a generic error state without internals', () => {
    const markup = renderUsers({ status: 'error' });

    expect(markup).toContain('用户列表暂时无法加载');
    expect(markup).not.toMatch(/SQL|sqlite|BANNED_USER|stack|Exception/);
  });

  it('shows a plain mutation error and leaks no Better Auth internals', () => {
    const markup = renderUsers(USERS, {
      errorMessage: '操作失败，请检查输入（用户名或邮箱可能已被占用）。',
    });

    expect(markup).toContain('操作失败，请检查输入');
    expect(markup).not.toMatch(/YOU_CANNOT|BANNED_USER|MISSING_OR_NULL_ORIGIN|stack/);
  });

  it('renders an empty state when there are no users', () => {
    expect(renderUsers({ status: 'ready', users: [] })).toContain('暂无用户');
  });

  it('hides self-actions when the current user id is unknown', () => {
    // With no known self id, every row is treated as another account; the server
    // still rejects self-operations, so this is presentation only.
    const markup = renderUsers(USERS, { currentUserId: null });

    expect(markup).not.toContain('当前账号');
  });
});
