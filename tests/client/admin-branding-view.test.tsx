import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AdminBrandingView,
  BrandingPreview,
  type AdminBrandingActions,
  type AdminBrandingState,
} from '../../src/client/AdminBranding.js';
import {
  PublicNavigationView,
  type PublicNavigationViewProps,
} from '../../src/client/PublicNavigation.js';
import type { PublicNavigation } from '../../src/client/api/public-navigation.js';
import type { BrandingSettings } from '../../src/client/api/admin-branding.js';

const SETTINGS: BrandingSettings = {
  pageBackgroundColor: null,
  surfaceColor: null,
  backgroundImagePath: null,
  siteName: 'Example Company 导航',
  tagline: '公司内部导航',
  logoPath: '/api/public/brand-assets/11111111-1111-1111-1111-111111111111.png',
  faviconPath: '/api/public/brand-assets/22222222-2222-2222-2222-222222222222.ico',
  primaryColor: '#2F6FEB',
  defaultTheme: 'dark',
  footerText: 'Self-hosted navigation',
  accessMode: 'public',
};

function actions(overrides: Partial<AdminBrandingActions> = {}): AdminBrandingActions {
  return {
    save: vi.fn(),
    uploadLogo: vi.fn(),
    uploadFavicon: vi.fn(),
    uploadBackground: vi.fn(),
    removeLogo: vi.fn(),
    removeFavicon: vi.fn(),
    removeBackground: vi.fn(),
    ...overrides,
  } as AdminBrandingActions;
}

function renderBranding(
  state: AdminBrandingState,
  overrides: { isMutating?: boolean; errorMessage?: string | null } = {},
): string {
  return renderToStaticMarkup(
    <AdminBrandingView
      state={state}
      actions={actions()}
      isMutating={overrides.isMutating ?? false}
      errorMessage={overrides.errorMessage ?? null}
    />,
  );
}

const SITE: NonNullable<PublicNavigation['site']> = {
  id: 1,
  siteName: 'Ignored Nav Name',
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
    session: { isPending: false, username: null },
    isLoginVisible: false,
    login: { isSubmitting: false, errorMessage: null, onSubmit: vi.fn() },
    personal: null,
    adminEntry: null,
    settingsEntry: null,
    branding: SETTINGS,
    search: { query: '', onChange: vi.fn(), showNoResults: false },
    onLogout: vi.fn(),
    onShowLogin: vi.fn(),
    onHideLogin: vi.fn(),
    ...overrides,
  };
}

describe('AdminBrandingView — visibility boundary', () => {
  it('renders nothing at all when the state is absent', () => {
    // Guests and normal users must receive no branding admin markup.
    expect(renderBranding({ status: 'absent' })).toBe('');
  });

  it('renders no branding admin markup on Home (UX-IA)', () => {
    // Branding management moved to Admin Management; Home renders only the
    // branded presentation. Composition is covered by the AdminManagementView
    // tests.
    const markup = renderToStaticMarkup(
      <PublicNavigationView {...publicProps({ branding: SETTINGS })} />,
    );

    expect(markup).not.toContain('品牌设置');
  });
});

describe('AdminBrandingView — form', () => {
  it('offers a compact draft preview and three editable starting palettes plus default', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    expect(markup).toContain('未保存的品牌外观预览');
    expect(markup).toContain('颜色实时预览，保存后应用');
    for (const name of ['森林清绿', '海湾深蓝', '暖灰中性', '主题默认']) expect(markup).toContain(`>${name}</button>`);
    expect(markup).toContain('当前使用主题默认');
    expect(markup).toContain('当前使用自定义颜色');
  });

  it('renders preview from the supplied draft colors and identity without publishing global styles', () => {
    const draft = { ...SETTINGS, siteName: '草木书房', pageBackgroundColor: '#EAF0ED', surfaceColor: '#FCFEFD', primaryColor: '#28705B' };
    const markup = renderToStaticMarkup(<BrandingPreview branding={draft} />);
    expect(markup).toContain('草木书房');
    expect(markup).toContain('--brand-page-background:#EAF0ED');
    expect(markup).toContain('--brand-surface:#FCFEFD');
    expect(markup).toContain('--brand-primary:#28705B');
    expect(markup).not.toContain('<style');
    expect(markup).not.toContain('<input');
  });
  it('offers three keyboard-editable colors with native pickers and explicit theme reset', () => {
    const markup = renderBranding({ status: 'ready', data: {
      ...SETTINGS, pageBackgroundColor: '#102030', surfaceColor: '#F1E2D3',
    } });
    expect((markup.match(/type="color"/g) ?? [])).toHaveLength(3);
    expect(markup).toContain('name="brandingPageBackgroundColor"');
    expect(markup).toContain('name="brandingSurfaceColor"');
    expect(markup).toContain('value="#102030"');
    expect(markup).toContain('value="#F1E2D3"');
    expect((markup.match(/>使用主题默认</g) ?? [])).toHaveLength(3);
    expect(markup).toContain('for="brandingPageBackgroundColor"');
  });

  it('shows bounded background preview and the existing upload/remove affordances', () => {
    const path = '/api/public/brand-assets/12345678-1234-1234-1234-123456789abc.webp';
    const markup = renderBranding({ status: 'ready', data: { ...SETTINGS, backgroundImagePath: path } });
    expect(markup).toContain(path);
    expect(markup).toContain('branding__preview--background');
    expect(markup).toContain('背景图片文件');
    expect(markup).toContain('PNG / JPEG / WebP · 最大 5 MiB');
    expect((markup.match(/type="file"/g) ?? [])).toHaveLength(3);
    expect(markup).not.toContain('远程');
  });
  it('exposes every editable setting', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });

    expect(markup).toContain('品牌设置');
    expect(markup).toContain('name="brandingSiteName"');
    expect(markup).toContain('name="brandingTagline"');
    expect(markup).toContain('name="brandingPrimaryColor"');
    expect(markup).toContain('name="brandingDefaultTheme"');
    expect(markup).toContain('name="brandingFooterText"');
    expect(markup).toContain('name="brandingAccessMode"');
  });

  it('explains footer link syntax with an associated hint', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    expect(markup).toContain('for="brandingFooterText"');
    expect(markup).toContain('aria-describedby="branding-footer-hint"');
    expect(markup).toContain('支持文字和 HTTP/HTTPS 超链接');
    expect(markup).toContain('&lt;a href=&quot;https://example.com&quot;&gt;链接文字&lt;/a&gt;');
    expect(markup).toContain('其他标签及属性按文字显示');
  });

  it('renders the current server values', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });

    expect(markup).toContain('Example Company 导航');
    expect(markup).toContain('公司内部导航');
    expect(markup).toContain('#2F6FEB');
    expect(markup).toContain('Self-hosted navigation');
  });

  it('labels the access modes in plain language', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });

    expect(markup).toContain('公开访问');
    expect(markup).toContain('登录后访问');
  });

  it('renders logo and favicon upload controls with previews', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });

    expect(markup).toContain('type="file"');
    expect(markup).toContain(SETTINGS.logoPath ?? '');
    expect(markup).toContain(SETTINGS.faviconPath ?? '');
    expect(markup).toContain('移除');
  });

  it('does not offer removal when no asset is set', () => {
    const markup = renderBranding({
      status: 'ready',
      data: { ...SETTINGS, logoPath: null, faviconPath: null },
    });

    expect(markup).toContain('未设置');
    expect(markup).not.toContain('移除');
  });

  it('disables controls while a mutation is in flight', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS }, { isMutating: true });

    expect(markup).toContain('disabled');
  });

  it('shows a plain error and leaks nothing technical', () => {
    const markup = renderBranding(
      { status: 'ready', data: SETTINGS },
      { errorMessage: '保存失败，请检查输入。' },
    );

    expect(markup).toContain('保存失败，请检查输入。');
    expect(markup).not.toMatch(/SQL|sqlite|ENOENT|stack|uploads\//);
  });

  it('renders loading and error states without internals', () => {
    expect(renderBranding({ status: 'loading' })).toContain('正在加载品牌设置');

    const error = renderBranding({ status: 'error' });
    expect(error).toContain('品牌设置暂时无法加载');
    expect(error).not.toMatch(/SQL|stack|Exception/);
  });
});

describe('public branding presentation', () => {
  it('renders the branded name, tagline and footer', () => {
    const markup = renderToStaticMarkup(<PublicNavigationView {...publicProps()} />);

    expect(markup).toContain('Example Company 导航');
    expect(markup).toContain('公司内部导航');
    expect(markup).toContain('Self-hosted navigation');
    // Branding, not the navigation payload, is the identity source.
    expect(markup).not.toContain('Ignored Nav Name');
  });

  it('renders safe footer links alongside escaped hostile content', () => {
    const markup = renderToStaticMarkup(<PublicNavigationView {...publicProps({
      branding: { ...SETTINGS, footerText: '文字 <a href="http://example.com/">链接</a><img src=x onerror=alert(1)>' },
    })} />);
    expect(markup).toContain('<footer class="site-footer">文字 <a href="http://example.com/" target="_blank" rel="noopener noreferrer">链接</a>');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img src=x');
  });

  it.each([null, ''])('omits the footer when its value is %s', (footerText) => {
    const markup = renderToStaticMarkup(<PublicNavigationView {...publicProps({
      branding: { ...SETTINGS, footerText },
    })} />);
    expect(markup).not.toContain('<footer');
  });

  it('renders the uploaded logo as a plain image', () => {
    const markup = renderToStaticMarkup(<PublicNavigationView {...publicProps()} />);

    expect(markup).toContain('<img');
    expect(markup).toContain(SETTINGS.logoPath ?? '');
    expect(markup).toContain('site-header__logo');
  });

  it('omits the logo element when none is configured', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({ branding: { ...SETTINGS, logoPath: null } })}
      />,
    );

    expect(markup).not.toContain('site-header__logo');
  });

  it('keeps the login_required screen branded', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView {...publicProps({ state: { status: 'unauthenticated' } })} />,
    );

    // Branding renders even though no navigation is available.
    expect(markup).toContain('Example Company 导航');
    expect(markup).toContain('请登录');
    expect(markup).toContain('app--login-required');
    // No navigation data leaks into the login screen.
    expect(markup).not.toContain('link-card');
  });

  it('renders branding text as text, never as markup', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({ branding: { ...SETTINGS, footerText: hostile } })}
      />,
    );

    // Escaped into text, never parsed as markup: the raw tags must not appear,
    // and the payload survives only in escaped (&lt;…&gt;) form.
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('escapes a hostile site name and tagline', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({
          branding: { ...SETTINGS, siteName: '<b>x</b>', tagline: '<i>y</i>' },
        })}
      />,
    );

    expect(markup).not.toContain('<b>x</b>');
    expect(markup).not.toContain('<i>y</i>');
    expect(markup).toContain('&lt;b&gt;');
  });

  it('applies a fallback brand when branding failed to load', () => {
    const markup = renderToStaticMarkup(
      <PublicNavigationView
        {...publicProps({
          branding: {
            pageBackgroundColor: null,
            surfaceColor: null,
            backgroundImagePath: null,
            siteName: '导航',
            tagline: null,
            logoPath: null,
            faviconPath: null,
            primaryColor: null,
            defaultTheme: 'light',
            footerText: null,
          },
        })}
      />,
    );

    expect(markup).toContain('导航');
  });
});
