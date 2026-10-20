import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AdminBrandingView,
  BrandingPreview,
  type AdminBrandingActions,
  type AdminBrandingState,
} from '../../src/client/AdminBranding.js';
import { isAssetOnlySnapshotChange } from '../../src/client/admin-branding-snapshot.js';
import {
  PublicNavigationView,
  type PublicNavigationViewProps,
} from '../../src/client/PublicNavigation.js';
import type { PublicNavigation } from '../../src/client/api/public-navigation.js';
import type { BrandingSettings } from '../../src/client/api/admin-branding.js';
import { homeThemePresetPalette } from '../../src/client/home-theme-presets.js';

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
  homeThemeConfig: null,
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
  it('offers three keyboard-editable brand colors with native pickers and explicit theme reset', () => {
    const markup = renderBranding({ status: 'ready', data: {
      ...SETTINGS, pageBackgroundColor: '#102030', surfaceColor: '#F1E2D3',
    } });
    // The three *brand* colours keep their own pickers and reset affordances. The
    // seven home-page slots render separately, so they are counted apart rather
    // than lumped in — a shared total would hide a regression in either group.
    expect((markup.match(/name="branding(?:PrimaryColor|PageBackgroundColor|SurfaceColor)"/g) ?? [])).toHaveLength(3);
    expect((markup.match(/>使用主题默认</g) ?? [])).toHaveLength(3);
    expect(markup).toContain('name="brandingPageBackgroundColor"');
    expect(markup).toContain('name="brandingSurfaceColor"');
    expect(markup).toContain('value="#102030"');
    expect(markup).toContain('value="#F1E2D3"');
    expect(markup).toContain('for="brandingPageBackgroundColor"');
  });

  it('offers the seven home-page slots with their own pickers and reset labels', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    for (const slot of ['accentBg', 'accentInk', 'linkTitle', 'linkMeta', 'iconInk', 'iconBg', 'categoryTitle']) {
      expect(markup, `slot ${slot} must be editable`).toContain(`name="homeTheme${slot}"`);
    }
    expect((markup.match(/>恢复自动</g) ?? [])).toHaveLength(7);
    // Automatic slots must read as automatic, not as a custom colour.
    expect(markup).toContain('placeholder="自动"');
    expect(markup).toContain('高级颜色定制（首页）');
  });

  it('leaves the home colour pickers enabled in automatic mode (T2.1 Finding 1)', () => {
    // T2 disabled every picker while its field was empty, so the most common
    // first action — open the picker, choose a colour — was impossible.
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    expect((markup.match(/type="color"/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(markup).not.toMatch(/type="color"[^>]*disabled/);
  });

  it('does not disable the section when one field holds a partial value (T2.1 Finding 1)', () => {
    // The regression locked the whole panel: typing "#B45" disabled every control,
    // so the value could be neither completed nor cleared from the UI.
    const markup = renderBranding({
      status: 'ready',
      data: { ...SETTINGS, homeThemeConfig: { version: 1, overrides: { accentBg: '#B45' } } as never },
    });
    expect(markup).toContain('高级颜色定制（首页）');
    expect(markup).toContain('请输入完整的六位颜色');
    // Only the *save* action is withheld; the controls themselves stay live.
    expect(markup).not.toContain('branding__body--disabled');
  });

  it('keeps the advanced section collapsed by default', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    expect(markup).toContain('<details class="branding-home"');
    expect(markup).not.toContain('<details class="branding-home" open');
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
    /*
     * The affordance, not the word. T4.3.1 added a hint that legitimately
     * mentions 移除 (「图片的上传与移除立即生效，不经过『保存』。」), so a bare
     * substring ban now fails on help text while no button exists. What must
     * not appear is the removal *button* — matching on the element keeps the
     * original intent intact.
     */
    expect(markup).not.toMatch(/<button[^>]*>\s*移除/);
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
            homeThemeConfig: null,
          },
        })}
      />,
    );

    expect(markup).toContain('导航');
  });
});

/*
 * T3 — preset wiring.
 *
 * `renderToStaticMarkup` runs no effects and no interaction, so what is asserted
 * here is the *wiring*: which card is checked, what the form says about the
 * preset, and that the preview root carries the classes the production CSS
 * requires. The behaviour those clicks trigger (which palette a preset writes,
 * whether a base switch follows it) lives in pure functions and is covered in
 * `home-theme-presets.test.ts` and in the browser evidence — writing a single
 * unit test that pretends to click would test nothing.
 */
describe('AdminBrandingView — theme presets', () => {
  /**
   * A saved state that genuinely matches a preset on a given base.
   *
   * Building it from `homeThemePresetPalette` rather than hard-coding colours
   * matters: a fixture with a *mismatched* brand colour is a legitimately
   * "customised palette", and any test that assumed otherwise would be asserting
   * against a state the component is right to treat differently.
   */
  function presetState(presetId: 'forest-mist' | 'warm-paper' | 'deep-sea', basis: 'light' | 'dark'): BrandingSettings {
    const palette = homeThemePresetPalette(presetId, basis)!;
    return {
      ...SETTINGS,
      ...palette,
      defaultTheme: basis,
      homeThemeConfig: { version: 1, presetId, overrides: {} },
    };
  }

  const WITH_PRESET = presetState('forest-mist', 'dark');

  const WITH_PRESET_AND_OVERRIDE: BrandingSettings = {
    ...WITH_PRESET,
    homeThemeConfig: {
      version: 1,
      presetId: 'forest-mist',
      overrides: { accentBg: '#123456', linkTitle: '#654321' },
    },
  };

  it('offers all five themes as one radio group', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="首页主题预设"');
    for (const name of ['北欧霜白', '暖纸墨', '深海静蓝', '林间薄雾', '高对比专注']) {
      expect(markup, `missing preset card ${name}`).toContain(name);
    }
    expect((markup.match(/role="radio"/g) ?? [])).toHaveLength(6);
  });

  it('marks the stored preset as the current selection', () => {
    const markup = renderBranding({ status: 'ready', data: WITH_PRESET });
    expect(markup).toContain('branding-preset-card--selected');
    expect(markup).toContain('当前选择');
    // Exactly one checked radio: the chosen card and nothing else.
    expect((markup.match(/aria-checked="true"/g) ?? [])).toHaveLength(1);
  });

  it('leaves a site without a preset on "no preset" rather than snapping one on (AC5)', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    expect(markup).not.toContain('branding-preset-card--selected');
    expect(markup).not.toContain('当前选择');
    // "不使用主题预设" is the checked one, so the existing look is described
    // accurately instead of implying a theme was chosen.
    expect(markup).toMatch(/aria-checked="true"[^>]*>\s*不使用主题预设|不使用主题预设/);
    expect(markup).toContain('不使用主题预设');
  });

  it('states that advanced colours survive a preset choice (AC4)', () => {
    const plain = renderBranding({ status: 'ready', data: WITH_PRESET });
    expect(plain).not.toContain('已保留');

    const customised = renderBranding({ status: 'ready', data: WITH_PRESET_AND_OVERRIDE });
    expect(customised).toContain('已保留 2 项高级自定义颜色');
    expect(customised).toContain('优先于主题配色');
  });

  it('offers "restore this theme\'s colours" only when they were actually changed', () => {
    const pristine = renderBranding({ status: 'ready', data: presetState('forest-mist', 'dark') });
    expect(pristine).not.toContain('恢复本主题默认配色');

    const edited = renderBranding({ status: 'ready', data: { ...presetState('forest-mist', 'dark'), primaryColor: '#010203' } });
    expect(edited).toContain('恢复本主题默认配色');
  });

  it('keeps the preview inside the production cascade', () => {
    // `home-theme-css.test.ts` whitelists `.branding-home-preview` as the one
    // non-`.app--home` consumer of the preset shape variables. That whitelist is
    // only safe while this root carries both home classes — so the dependency is
    // asserted from the other side, here.
    const markup = renderBranding({ status: 'ready', data: WITH_PRESET });
    expect(markup).toMatch(/class="branding-home-preview app app--home"/);
  });

  it('carries the draft basis and preset on the preview itself, not on <html> (T3.1)', () => {
    /*
     * The load-bearing assertion of this fix.
     *
     * The saved site is dark (`SETTINGS.defaultTheme === 'dark'`). The preview must
     * still declare that basis on its own scope wrapper — if it fell back to the
     * document, the miniature would render light tokens over a dark draft, which
     * is precisely the reported Finding 1.
     */
    const markup = renderBranding({ status: 'ready', data: WITH_PRESET });
    expect(markup).toMatch(/class="branding-home-preview-scope" data-theme="dark"/);
    expect(markup).toContain('data-home-preset="forest-mist"');
    expect(markup).toContain('data-home-basis="dark"');

    // And nothing may write a preset or a basis onto the document element: that
    // is the whole reason the gate moved off `:root`.
    const source = readFileSync(fileURLToPath(new URL('../../src/client/AdminBranding.tsx', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/documentElement[^;]*HOME_THEME_PRESET_ATTRIBUTE/s);
  });

  it('states why the basis switch stopped following a customised preset', () => {
    const untouched = renderBranding({ status: 'ready', data: presetState('forest-mist', 'dark') });
    expect(untouched).not.toContain('切换明暗模式不会覆盖自定义颜色');

    const customised = renderBranding({ status: 'ready', data: { ...presetState('forest-mist', 'dark'), primaryColor: '#010203' } });
    expect(customised).toContain('当前配色已自定义，切换明暗模式不会覆盖自定义颜色');
    // Pointing at the way out, and no new dialog for a state that is not an error.
    expect(customised).toContain('恢复本主题默认配色');
    expect(customised).not.toContain('aria-modal');
  });

  it('gives the preview the draft\'s derived brand colours inline', () => {
    /*
     * The preview root has to carry these itself: the admin panel around it
     * resolves `--text` / `--border` / `--surface-raised` against the **saved**
     * branding, so an inherited value would always show the last saved theme.
     * A static render can only show the first state, where draft and saved
     * agree — that the properties are passed at all is what is provable here;
     * that they *change* with the draft is browser evidence.
     */
    const markup = renderBranding({
      status: 'ready',
      data: {
        ...SETTINGS,
        defaultTheme: 'light',
        primaryColor: '#3F6B57',
        pageBackgroundColor: '#EFF3F0',
        surfaceColor: '#FBFDFC',
      },
    });
    // The inline style lives on the *inner* root; T3.1 added a scope wrapper
    // around it to carry `data-theme`, so slice from that root, not from the
    // wrapper's opening tag.
    const preview = markup.slice(markup.indexOf('<div class="branding-home-preview app app--home'));
    const openingTag = preview.slice(0, preview.indexOf('>'));
    expect(openingTag).toContain('--brand-surface:#FBFDFC');
    expect(openingTag).toContain('--brand-page-background:#EFF3F0');
    expect(openingTag).toContain('--brand-primary:#3F6B57');
  });

  it('never renders a preset card as disabled while the form is idle', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    expect(markup).not.toMatch(/branding-preset-card[^>]*disabled/);
  });

  it('disables the preset cards while a mutation is in flight', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS }, { isMutating: true });
    expect(markup).toMatch(/branding-preset-card[^>]*disabled/);
  });
});

/*
 * ── T4.3：页面结构、单一保存入口与预览栏 ─────────────────────────────────
 *
 * 守的是**结构约定**：分组是否成卡、保存是否只有一个入口、预览是否还在生产
 * 级联里。这类改动不会报错，只会让页面安静地退化回「长抽屉 + 找不到的保存
 * 按钮」。布局与视觉由 `verify-t3/interaction-t43.mjs` 的浏览器证据覆盖。
 */
describe('AdminBrandingView — T4.3 page structure', () => {
  it('states the save semantics above the form', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    // The one fact a first-time administrator cannot guess: nothing applies
    // until 保存. It belongs above the form, not in a hint halfway down.
    // (T4.3.1 refined the wording to separate the immediate image operations;
    //  the requirement — stated above the form — is unchanged.)
    expect(markup).toContain('网站信息、主题与颜色需点击「保存」后生效');
    expect(markup.indexOf('branding__lede')).toBeLessThan(markup.indexOf('branding__form'));
  });

  it('gives every group the same card treatment, inside the form', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    // 品牌图片 used to hang off the bottom of the page as a bare heading and a
    // grid, outside the form and past the save button.
    const form = markup.slice(markup.indexOf('<form'), markup.indexOf('</form>'));
    for (const legend of ['站点信息', '品牌配色与明暗', '品牌图片', '访问设置']) {
      expect(form, `${legend} must be a card inside the form`).toContain(legend);
    }
    // And nothing may render a second, heading-styled copy outside it.
    const after = markup.slice(markup.indexOf('</form>'));
    expect(after).not.toContain('品牌图片');
  });

  it('offers exactly one save entry, associated with the form', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    // Two save buttons — the old in-form one plus a bar — is exactly the
    // "multiple confusing entries" the brief forbids. The bar submits the form
    // by association, so the count must be one and the association explicit.
    expect(markup).toContain('id="branding-form"');
    expect((markup.match(/type="submit"/g) ?? [])).toHaveLength(1);
    expect(markup).toMatch(/type="submit"[^>]*form="branding-form"/);
    expect(markup).toContain('branding__savebar');
  });

  it('keeps the real preview in a rail beside the form, not inside the collapsed panel', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    // The rail is a sibling of the form, after it — the desktop two-column
    // layout's right track.
    expect(markup).toContain('branding__aside');
    const formEnd = markup.indexOf('</form>');
    const aside = markup.indexOf('branding__aside');
    expect(aside, 'the rail must follow the form').toBeGreaterThan(formEnd);
    // And the production-cascade preview is in the rail, not in the collapsed
    // advanced panel where it used to sit (shut by default).
    expect(markup.indexOf('branding-home-preview app app--home')).toBeGreaterThan(aside);
    const advanced = markup.slice(markup.indexOf('class="branding-home"'));
    expect(advanced.slice(0, advanced.indexOf('</details>'))).not.toContain('branding-home-preview');
  });

  it('tracks the plain fields as unsaved, not only the home theme', () => {
    /*
     * The leave guard used to cover only the home theme and the preset, so an
     * edited site name could be lost by switching tabs with no prompt at all.
     * Static markup cannot run the guard; what it can prove is that the view
     * compares the base fields against the server snapshot — the same
     * comparison the home slots get.
     */
    const source = readFileSync(fileURLToPath(new URL('../../src/client/AdminBranding.tsx', import.meta.url)), 'utf8');
    const comparison = source.slice(
      source.indexOf('const baseUnsaved'),
      source.indexOf('const formUnsaved'),
    );
    for (const field of ['siteName', 'tagline', 'primaryColor', 'pageBackgroundColor', 'surfaceColor', 'defaultTheme', 'footerText', 'accessMode']) {
      expect(comparison, `${field} must take part in the unsaved comparison`).toContain(field);
    }
    expect(source).toContain('const formUnsaved = baseUnsaved || homeUnsaved;');
  });

  it('guards the discard prompt with wording that covers every field', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/client/AdminBranding.tsx', import.meta.url)), 'utf8');
    // The dialog used to name only the home colours; the guard now covers the
    // whole form, so the question must not promise otherwise.
    expect(source).toContain('放弃未保存的修改？');
    expect(source).not.toContain('放弃未保存的颜色修改？');
  });
});

/*
 * ── T4.3.1：图片操作不得吞掉未保存草稿 + 保存语义文案 ────────────────────
 *
 * 守的是一个**只在真实浏览器里发生的丢失**：图片上传/移除会触发品牌配置重取，
 * 而旧的渲染期同步对每次重取都整体覆盖表单。`renderToStaticMarkup` 不重取、
 * 不覆盖，测不出这个行为 —— 但删掉那个「仅资产变化则跳过」的判断不会有任何
 * 报错，只会静默回到丢草稿的状态。这里钉住判断的存在与形状，浏览器证据在
 * `review/t4.3.1/`（修复前复现 3 项 FAIL、修复后全过）。
 */
describe('AdminBrandingView — T4.3.1 asset refetch vs unsaved draft', () => {
  it('skips the form sync when a refetch changed only the asset paths', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/client/AdminBranding.tsx', import.meta.url)), 'utf8');

    // The decision itself is exercised behaviourally below (it is a pure
    // function in its own module); what is asserted here is that the
    // render-phase sync actually *uses* it and gates every field write behind
    // it — the wiring, not the logic.
    expect(source, 'the asset-only decision must be imported').toContain("import { isAssetOnlySnapshotChange } from './admin-branding-snapshot.js'");
    expect(source).toContain('const assetsOnly = isAssetOnlySnapshotChange(syncedFrom, data)');
    // Source order is the assertion: the first field write must sit inside the
    // guard, so an asset-only refetch reaches none of them.
    const sync = source.slice(source.indexOf('const assetsOnly'), source.indexOf('setHomePreset(data.homeThemeConfig?.presetId);'));
    expect(sync, 'the field updates must be skipped for asset-only refetches').toContain('if (!assetsOnly) {');
    expect(sync.indexOf('setSiteName(data.siteName)'), 'setSiteName must sit inside the guard')
      .toBeGreaterThan(sync.indexOf('if (!assetsOnly) {'));
  });

  it('states which operations need 保存 and which take effect immediately', () => {
    const markup = renderBranding({ status: 'ready', data: SETTINGS });
    // The old blanket claim was false for images: they persist through their own
    // endpoints the moment they succeed.
    expect(markup).not.toContain('所有修改只在点击「保存」后对所有访客生效');
    expect(markup).toContain('网站信息、主题与颜色需点击「保存」后生效');
    expect(markup).toContain('Logo、Favicon、背景图片的上传与移除立即生效');
    // And the same fact is restated where the images actually are, so an
    // administrator cannot believe an upload can be abandoned by not saving.
    expect(markup).toContain('图片的上传与移除立即生效，不经过「保存」。');
  });
});

/*
 * ── T4.3.1 Review Fix：规范化保存不得被误判为「仅图片变化」 ───────────────
 *
 * 行为化回归：服务端修剪文本、颜色规范化为大写，所以「保存一个规范化后与旧
 * 快照相同的值」会产生一次非图片字段完全相同的重取。旧判断只看签名，于是
 * 跳过表单同步——表单停在用户输入的原始草稿，保存栏在保存成功后永远误报
 * 未保存（实测：输入框保持 ` 示例导航 ` 与 `#285b47`）。
 *
 * 这里直接驱动导出的判定函数，覆盖边界两侧，而不是再查一遍源码字符串。
 */
describe('isAssetOnlySnapshotChange — T4.3.1 review fix', () => {
  const BASE: BrandingSettings = {
    pageBackgroundColor: null,
    surfaceColor: null,
    backgroundImagePath: null,
    siteName: '示例导航',
    tagline: null,
    logoPath: null,
    faviconPath: null,
    primaryColor: '#285B47',
    defaultTheme: 'light',
    footerText: null,
    accessMode: 'public',
    homeThemeConfig: null,
  };
  const withLogo = { ...BASE, logoPath: '/api/public/brand-assets/logo.png' };

  it('treats an asset-only refetch as asset-only (draft protection)', () => {
    expect(isAssetOnlySnapshotChange(BASE, withLogo)).toBe(true);
    expect(isAssetOnlySnapshotChange(BASE, { ...BASE, faviconPath: '/f.ico' })).toBe(true);
    expect(isAssetOnlySnapshotChange(withLogo, { ...withLogo, faviconPath: '/f.ico' })).toBe(true);
  });

  it('treats a normalising save as a form change even though the fields match', () => {
    /*
     * The regression, exactly as measured: the server trimmed ` 示例导航 `
     * back to `示例导航` and upper-cased `#285b47` back to `#285B47`, so the
     * post-save snapshot equals the pre-save one field for field. The form
     * must still adopt it — otherwise it keeps the raw draft and the save bar
     * reports unsaved changes forever.
     */
    expect(isAssetOnlySnapshotChange(BASE, { ...BASE })).toBe(false);
    expect(isAssetOnlySnapshotChange(withLogo, { ...withLogo })).toBe(false);
  });

  it('treats a real edit as a form change', () => {
    expect(isAssetOnlySnapshotChange(BASE, { ...BASE, siteName: '新名称' })).toBe(false);
    expect(isAssetOnlySnapshotChange(BASE, { ...BASE, primaryColor: '#010203' })).toBe(false);
    expect(isAssetOnlySnapshotChange(BASE, { ...BASE, defaultTheme: 'dark' })).toBe(false);
    expect(isAssetOnlySnapshotChange(BASE, { ...BASE, accessMode: 'login_required' })).toBe(false);
    expect(isAssetOnlySnapshotChange(BASE, { ...BASE, footerText: '页脚' })).toBe(false);
    expect(isAssetOnlySnapshotChange(BASE, {
      ...BASE,
      homeThemeConfig: { version: 1, overrides: { accentBg: '#123456' } } as never,
    })).toBe(false);
  });

  it('never treats an edit-plus-asset change as asset-only', () => {
    expect(isAssetOnlySnapshotChange(BASE, { ...withLogo, siteName: '新名称' })).toBe(false);
  });

  it('syncs the first snapshot the form has ever seen', () => {
    // No previous snapshot means there is no draft to protect yet.
    expect(isAssetOnlySnapshotChange(null, BASE)).toBe(false);
  });
});
