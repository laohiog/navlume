import { useRef, useState, type CSSProperties } from 'react';
import { ConfirmDialog } from './ModalDialog.js';
import { useConfirmation } from './use-confirmation.js';

import type { BrandingMutationOutcome, BrandingSettings } from './api/admin-branding.js';
import { brandingThemeProperties } from './branding-theme.js';

const STARTING_PALETTES = [
  { name: '森林清绿', primary: '#28705B', page: '#EAF0ED', surface: '#FCFEFD', theme: 'light' },
  { name: '海湾深蓝', primary: '#7AAEB9', page: '#16262C', surface: '#20343B', theme: 'dark' },
  { name: '暖灰中性', primary: '#795848', page: '#F2F0EB', surface: '#FEFDFC', theme: 'light' },
] as const;

/** A draft-only view: shares runtime derivation, never writes settings or global styles. */
export function BrandingPreview({ branding }: { branding: BrandingSettings }) {
  const dark = branding.defaultTheme === 'dark';
  const validColor = (value: string | null, fallback: string) => value !== null && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : fallback;
  const properties = brandingThemeProperties({ ...branding,
    primaryColor: validColor(branding.primaryColor, dark ? '#89C4A1' : '#285B47'),
    pageBackgroundColor: validColor(branding.pageBackgroundColor, dark ? '#161C25' : '#F5F7FA'),
    surfaceColor: validColor(branding.surfaceColor, dark ? '#202936' : '#FFFFFF'),
  });
  return (
    <div className="branding-live-preview" role="img" aria-label="未保存的品牌外观预览" style={properties as CSSProperties}>
      <div className="branding-live-preview__identity">
        {branding.logoPath !== null ? <img src={branding.logoPath} alt="" width={28} height={28} /> : null}
        <strong>{branding.siteName.trim() || '导航'}</strong>
        <span>{branding.tagline || '常用网址，随手直达'}</span>
      </div>
      <div className="branding-live-preview__search">搜索网址</div>
      <div className="branding-live-preview__category">日常工作 <span>添加网址</span></div>
      <div className="branding-live-preview__cards">
        {['团队文档', '项目协作', '设计资源'].map((title) => <div className="branding-live-preview__card" key={title}>
          <span>{title.slice(0, 1)}</span><strong>{title}</strong>
        </div>)}
      </div>
    </div>
  );
}

/**
 * Render state for the admin branding section.
 *
 * `absent` means "no admin surface here" — a guest, a normal user, or an
 * unresolved session. Distinct from `error` so a non-admin is never shown a
 * failure, and no admin markup is rendered for them at all.
 */
export type AdminBrandingState =
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: BrandingSettings };

/** Mutations the container implements; the view only triggers them. */
export interface AdminBrandingActions {
  save(input: {
    siteName: string;
    tagline: string | null;
    primaryColor: string | null;
    pageBackgroundColor: string | null;
    surfaceColor: string | null;
    defaultTheme: 'light' | 'dark';
    footerText: string | null;
    accessMode: 'public' | 'login_required';
  }): Promise<BrandingMutationOutcome>;
  uploadLogo(file: File): Promise<BrandingMutationOutcome>;
  uploadFavicon(file: File): Promise<BrandingMutationOutcome>;
  uploadBackground(file: File): Promise<BrandingMutationOutcome>;
  removeLogo(): Promise<BrandingMutationOutcome>;
  removeFavicon(): Promise<BrandingMutationOutcome>;
  removeBackground(): Promise<BrandingMutationOutcome>;
}

export interface AdminBrandingViewProps {
  state: AdminBrandingState;
  actions: AdminBrandingActions;
  /** True while a branding mutation is in flight. */
  isMutating: boolean;
  /** Non-technical mutation failure text, if any. */
  errorMessage: string | null;
}

/** One asset row: preview, upload, and explicit remove. */
function AssetField({
  label,
  accept,
  currentPath,
  isBusy,
  onUpload,
  onRemove,
  guidance,
}: {
  label: string;
  accept: string;
  currentPath: string | null;
  isBusy: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => void;
  guidance?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="branding__asset">
      <span className="branding__label">{label}</span>
      {guidance !== undefined ? <span className="branding__asset-hint">{guidance}</span> : null}

      {currentPath !== null ? (
        <img className={`branding__preview${label === '背景图片' ? ' branding__preview--background' : ''}`} src={currentPath} alt={`${label}预览`}
          width={label === '背景图片' ? 160 : 48} height={label === '背景图片' ? 72 : 48} />
      ) : (
        <span className="branding__empty">未设置</span>
      )}

      <div className="branding__asset-actions">
        <input
          ref={inputRef}
          className="branding__file"
          type="file"
          name={`branding${label}`}
          accept={accept}
          disabled={isBusy}
          aria-label={`${label}文件`}
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file !== undefined) {
              void onUpload(file).finally(() => {
                // Allow re-selecting the same file after a failed attempt.
                if (inputRef.current !== null) {
                  inputRef.current.value = '';
                }
              });
            }
          }}
        />
        {currentPath !== null ? (
          <button className="branding__button" type="button" disabled={isBusy} onClick={onRemove}>
            移除
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ColorField({ label, name, value, fallback, disabled, onChange }: {
  label: string; name: string; value: string; fallback: string; disabled: boolean;
  onChange(value: string): void;
}) {
  const pickerValue = /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : fallback;
  return (
    <div className="branding__field">
      <label className="branding__label" htmlFor={name}>{label}</label>
      <div className="branding__color-controls">
        <input className="branding__color-picker" type="color" aria-label={`${label}选色`}
          value={pickerValue} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
        <input className="branding__input" id={name} name={name} type="text" value={value}
          placeholder="主题默认" pattern="\s*#[0-9a-fA-F]{6}\s*|\s*" title="请输入六位颜色，如 #285B47，或留空使用主题默认。"
          disabled={disabled} onChange={(event) => onChange(event.target.value)} />
        <button className="branding__color-reset" type="button" aria-label={`${label}使用主题默认`}
          disabled={disabled || value.length === 0} onClick={() => onChange('')}>使用主题默认</button>
      </div>
      <span className="branding__color-hint">{value.trim() === '' ? '当前使用主题默认' : '当前使用自定义颜色'}</span>
    </div>
  );
}

/**
 * Admin branding settings form.
 *
 * Presentational apart from local form state. It performs no fetching and no
 * session calls; the container owns loading, authorization state, dispatch, and
 * refetching.
 *
 * Renders nothing in the `absent` state, so a guest or normal user receives no
 * admin markup. That is a render decision, not a security boundary — every
 * branding route is authorized on the server.
 */
export function AdminBrandingView({
  state,
  actions,
  isMutating,
  errorMessage,
}: AdminBrandingViewProps) {
  const [siteName, setSiteName] = useState('');
  const [tagline, setTagline] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [pageBackgroundColor, setPageBackgroundColor] = useState('');
  const [surfaceColor, setSurfaceColor] = useState('');
  const [defaultTheme, setDefaultTheme] = useState<'light' | 'dark'>('light');
  const [footerText, setFooterText] = useState('');
  const [accessMode, setAccessMode] = useState<'public' | 'login_required'>('public');

  const data = state.status === 'ready' ? state.data : null;

  /**
   * Sync the form from authoritative server state **during render**.
   *
   * Uses React's documented "adjust state when a prop changes" pattern rather
   * than an effect: the server payload is the source of truth, so when it changes
   * (initial load, or after a successful save refetches) the form must adopt it.
   * A failed save refetches nothing, so whatever the user typed is preserved.
   */
  const [syncedFrom, setSyncedFrom] = useState<BrandingSettings | null>(null);
  const confirmation = useConfirmation();

  if (data !== null && data !== syncedFrom) {
    setSyncedFrom(data);
    setSiteName(data.siteName);
    setTagline(data.tagline ?? '');
    setPrimaryColor(data.primaryColor ?? '');
    setPageBackgroundColor(data.pageBackgroundColor ?? '');
    setSurfaceColor(data.surfaceColor ?? '');
    setDefaultTheme(data.defaultTheme);
    setFooterText(data.footerText ?? '');
    setAccessMode(data.accessMode);
  }

  if (state.status === 'absent') {
    return null;
  }

  if (state.status === 'loading') {
    return (
      <section className="branding" aria-labelledby="branding-title">
        <h2 className="branding__title" id="branding-title">
          品牌设置
        </h2>
        <p className="status" role="status">
          正在加载品牌设置…
        </p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="branding" aria-labelledby="branding-title">
        <h2 className="branding__title" id="branding-title">
          品牌设置
        </h2>
        <p className="status status--error" role="alert">
          品牌设置暂时无法加载，请稍后重试。
        </p>
      </section>
    );
  }

  return (
    <section className="branding" aria-labelledby="branding-title">
      <h2 className="branding__title" id="branding-title">
        品牌设置
      </h2>

      {errorMessage !== null && errorMessage.length > 0 ? (
        <p className="branding__error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <form
        className="branding__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (isMutating || siteName.trim().length === 0) {
            return;
          }

          void actions.save({
            siteName,
            tagline: tagline.trim().length === 0 ? null : tagline,
            primaryColor: primaryColor.trim().length === 0 ? null : primaryColor,
            pageBackgroundColor: pageBackgroundColor.trim().length === 0 ? null : pageBackgroundColor,
            surfaceColor: surfaceColor.trim().length === 0 ? null : surfaceColor,
            defaultTheme,
            footerText: footerText.trim().length === 0 ? null : footerText,
            accessMode,
          });
        }}
      >
        <fieldset className="branding__section">
          <legend className="branding__section-title">站点信息</legend>
          <label className="branding__field">
            <span className="branding__label">网站名称</span>
            <input
              className="branding__input"
              type="text"
              name="brandingSiteName"
              value={siteName}
              disabled={isMutating}
              onChange={(event) => setSiteName(event.target.value)}
            />
          </label>

          <label className="branding__field">
            <span className="branding__label">Tagline</span>
            <input
              className="branding__input"
              type="text"
              name="brandingTagline"
              value={tagline}
              disabled={isMutating}
              onChange={(event) => setTagline(event.target.value)}
            />
          </label>

          <div className="branding__field">
            <label className="branding__label" htmlFor="brandingFooterText">Footer 内容</label>
            <input
              className="branding__input"
              type="text"
              id="brandingFooterText"
              name="brandingFooterText"
              aria-describedby="branding-footer-hint"
              value={footerText}
              disabled={isMutating}
              onChange={(event) => setFooterText(event.target.value)}
            />
            <span className="branding__asset-hint" id="branding-footer-hint">
              支持文字和 HTTP/HTTPS 超链接，例如 {'<a href="https://example.com">链接文字</a>'}。其他标签及属性按文字显示。
            </span>
          </div>
        </fieldset>

        <fieldset className="branding__section">
          <legend className="branding__section-title">外观与访问</legend>
          <div className="branding__starting-palettes" aria-label="起始配色">
            <span className="branding__label">从配色开始，也可逐项调整</span>
            <div>
              <button type="button" disabled={isMutating} onClick={() => {
                setPrimaryColor(''); setPageBackgroundColor(''); setSurfaceColor('');
              }}>主题默认</button>
              {STARTING_PALETTES.map((palette) => <button type="button" key={palette.name} disabled={isMutating} onClick={() => {
                setPrimaryColor(palette.primary); setPageBackgroundColor(palette.page);
                setSurfaceColor(palette.surface); setDefaultTheme(palette.theme);
              }}>{palette.name}</button>)}
            </div>
          </div>
          <ColorField label="品牌主色" name="brandingPrimaryColor" value={primaryColor}
            fallback={defaultTheme === 'dark' ? '#89C4A1' : '#285B47'} disabled={isMutating} onChange={setPrimaryColor} />
          <ColorField label="页面背景色" name="brandingPageBackgroundColor" value={pageBackgroundColor}
            fallback={defaultTheme === 'dark' ? '#161C25' : '#F5F7FA'} disabled={isMutating} onChange={setPageBackgroundColor} />
          <ColorField label="卡片 / 面板色" name="brandingSurfaceColor" value={surfaceColor}
            fallback={defaultTheme === 'dark' ? '#202936' : '#FFFFFF'} disabled={isMutating} onChange={setSurfaceColor} />

          <label className="branding__field">
            <span className="branding__label">默认主题</span>
            <select
              className="branding__input"
              name="brandingDefaultTheme"
              value={defaultTheme}
              disabled={isMutating}
              onChange={(event) => setDefaultTheme(event.target.value === 'dark' ? 'dark' : 'light')}
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>

          <fieldset className="branding__fieldset">
            <legend className="branding__label">访问模式</legend>
            <label className="branding__radio">
              <input
                type="radio"
                name="brandingAccessMode"
                value="public"
                checked={accessMode === 'public'}
                disabled={isMutating}
                onChange={() => setAccessMode('public')}
              />
              <span>公开访问</span>
            </label>
            <label className="branding__radio">
              <input
                type="radio"
                name="brandingAccessMode"
                value="login_required"
                checked={accessMode === 'login_required'}
                disabled={isMutating}
                onChange={() => setAccessMode('login_required')}
              />
              <span>登录后访问</span>
            </label>
          </fieldset>
          <div className="branding__live-preview">
            <span className="branding__label">外观预览</span>
            <span className="branding__color-hint">颜色实时预览，保存后应用；图片上传后更新。</span>
            <BrandingPreview branding={{ ...state.data, siteName, tagline, primaryColor,
              pageBackgroundColor, surfaceColor, defaultTheme }} />
          </div>
        </fieldset>

        <button className="branding__button branding__button--primary" type="submit" disabled={isMutating}>
          保存
        </button>
      </form>

      <h3 className="branding__section-title">品牌图片</h3>
      <div className="branding__assets">
        <AssetField
          label="Logo"
          accept="image/png,image/jpeg,image/webp"
          currentPath={state.data.logoPath}
          isBusy={isMutating}
          onUpload={async (file) => {
            await actions.uploadLogo(file);
          }}
          onRemove={() => {
            confirmation.confirm({ title: '移除 Logo', actionLabel: '移除 Logo',
              message: '确定移除 Logo 吗？', onConfirm: actions.removeLogo });
          }}
        />
        <AssetField
          label="Favicon"
          accept="image/png,image/x-icon,image/vnd.microsoft.icon"
          currentPath={state.data.faviconPath}
          isBusy={isMutating}
          onUpload={async (file) => {
            await actions.uploadFavicon(file);
          }}
          onRemove={() => {
            confirmation.confirm({ title: '移除 Favicon', actionLabel: '移除 Favicon',
              message: '确定移除 Favicon 吗？', onConfirm: actions.removeFavicon });
          }}
        />
        <AssetField label="背景图片" accept="image/png,image/jpeg,image/webp"
          guidance="PNG / JPEG / WebP · 最大 5 MiB" currentPath={state.data.backgroundImagePath}
          isBusy={isMutating} onUpload={async (file) => { await actions.uploadBackground(file); }}
          onRemove={() => {
            confirmation.confirm({ title: '移除背景图片', actionLabel: '移除背景图片',
              message: '确定移除背景图片吗？', onConfirm: actions.removeBackground });
          }} />
      </div>
      <ConfirmDialog request={confirmation.request} onDismiss={confirmation.dismiss} />
    </section>
  );
}
