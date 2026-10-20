import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/client/ModalDialog.js';
import { PersonalNavigationView, type PersonalNavigationActions } from '../../src/client/PersonalNavigation.js';
import { PublicNavigationView, type PublicNavigationViewProps } from '../../src/client/PublicNavigation.js';
import { FALLBACK_BRANDING } from '../../src/client/api/admin-branding.js';

function publicProps(): PublicNavigationViewProps {
  return {
    state: { status: 'ready', data: { site: null, categories: [] } },
    session: { isPending: false, username: null }, isLoginVisible: false,
    login: { isSubmitting: false, errorMessage: null, onSubmit: vi.fn() },
    personal: null, adminEntry: null, settingsEntry: null, branding: FALLBACK_BRANDING,
    search: { query: '', onChange: vi.fn(), showNoResults: false, resultCount: null },
    onLogout: vi.fn(), onShowLogin: vi.fn(), onHideLogin: vi.fn(), onRetry: vi.fn(),
  };
}

describe('P0 accessible navigation states', () => {
  it('announces the supplied combined count once and offers recovery at zero', () => {
    const props = publicProps();
    props.search = { ...props.search, query: 'missing', resultCount: 0, showNoResults: true };
    const html = renderToStaticMarkup(<PublicNavigationView {...props} />);
    expect(html.match(/找到 0 个网址/g)).toHaveLength(1);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('清空搜索');
    expect(html).toContain('试试域名或分类名');
    props.search.resultCount = 12;
    props.search.showNoResults = false;
    const matches = renderToStaticMarkup(<PublicNavigationView {...props} />);
    expect(matches).toContain('找到 12 个网址');
    expect(matches).not.toContain('清空搜索');
  });

  it('does not announce zero for unresolved data and exposes public retry', () => {
    const props = publicProps();
    props.search.query = 'example';
    props.state = { status: 'loading' };
    expect(renderToStaticMarkup(<PublicNavigationView {...props} />)).not.toContain('找到 0');
    props.state = { status: 'error' };
    const html = renderToStaticMarkup(<PublicNavigationView {...props} />);
    expect(html).toContain('重试加载公共导航');
    expect(html).not.toContain('找到 0');
  });

  it('offers first-link QuickAdd only for an unfiltered empty personal list', () => {
    const props = {
      state: { status: 'ready' as const, data: { categories: [{ id: 1, name: '我的常用', sortOrder: 0, isDefault: true, links: [] }] } },
      actions: {} as PersonalNavigationActions, isMutating: false, errorMessage: null, searchQuery: '', onRetry: vi.fn(),
    };
    const html = renderToStaticMarkup(<PersonalNavigationView {...props} />);
    expect(html).toContain('＋ 添加第一个网址');
    expect(renderToStaticMarkup(<PersonalNavigationView {...props} searchQuery="missing" />)).not.toContain('＋ 添加第一个网址');
    expect(renderToStaticMarkup(<PersonalNavigationView {...props} state={{ status: 'error' }} />)).toContain('重试加载个人导航');
  });

  it('labels a dangerous confirmation and does not execute it while rendering', () => {
    const onConfirm = vi.fn();
    const html = renderToStaticMarkup(<ConfirmDialog onDismiss={vi.fn()} request={{
      title: '删除用户', message: '删除此账号不可恢复。', actionLabel: '删除用户', trigger: null, onConfirm,
    }} />);
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('取消');
    expect(html).toContain('删除此账号不可恢复。');
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
