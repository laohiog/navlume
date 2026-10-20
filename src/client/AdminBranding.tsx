import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ConfirmDialog } from './ModalDialog.js';
import { useConfirmation } from './use-confirmation.js';

import type {
  BrandingMutationOutcome,
  BrandingSettings,
  HomeThemeColorKey,
  HomeThemeConfig,
  HomeThemePresetId,
  PublicBranding,
} from './api/admin-branding.js';
import { brandingThemeProperties, HOME_THEME_GATE_NAMES } from './branding-theme.js';
import {
  homeThemePresetPalette,
  matchesHomeThemePresetPalette,
  type ThemeBasis,
} from './home-theme-presets.js';
import { HomeThemePresetCards } from './AdminHomeThemePresets.js';
import { HomeThemePreview } from './AdminHomeThemePreview.js';
import {
  EMPTY_HOME_THEME_DRAFT,
  collectContrastFindings,
  homeThemeDraftFromConfig,
  homeThemeDraftToPayload,
  isCompleteHexColor,
  homeThemeDraftGates,
  invalidHomeThemeSlots,
  isHomeThemeDraftCustomised,
  isHomeThemeDraftUnsaved,
  resolveEffectiveHomeColors,
  type ContrastFinding,
  type HomeThemeDraft,
} from './admin-home-theme-draft.js';
import { isAssetOnlySnapshotChange } from './admin-branding-snapshot.js';

const STARTING_PALETTES = [
  { name: '森林清绿', primary: '#28705B', page: '#EAF0ED', surface: '#FCFEFD', theme: 'light' },
  { name: '海湾深蓝', primary: '#7AAEB9', page: '#16262C', surface: '#20343B', theme: 'dark' },
  { name: '暖灰中性', primary: '#795848', page: '#F2F0EB', surface: '#FEFDFC', theme: 'light' },
] as const;

/** The seven slots, grouped the way an administrator thinks about the page. */
const HOME_THEME_GROUPS: { id: string; title: string; hint: string; slots: { key: HomeThemeColorKey; label: string }[] }[] = [
  {
    id: 'button',
    title: '按钮',
    hint: '「＋ 添加网址」按钮的底色与文字色',
    slots: [
      { key: 'accentBg', label: '主按钮背景色' },
      { key: 'accentInk', label: '主按钮文字色' },
    ],
  },
  {
    id: 'links',
    title: '网址卡片',
    hint: '卡片内网址标题与下方域名／说明文字',
    slots: [
      { key: 'linkTitle', label: '网址标题颜色' },
      { key: 'linkMeta', label: '网址说明／域名颜色' },
    ],
  },
  {
    id: 'icons',
    title: '图标',
    hint: '没有网站图标时显示的首字母占位图标。第三方网站图标是位图，无法用颜色改变其像素。',
    slots: [
      { key: 'iconInk', label: '占位图标文字颜色' },
      { key: 'iconBg', label: '图标容器背景颜色' },
    ],
  },
  {
    id: 'category',
    title: '分类标题',
    hint: '每个分类面板左侧的名称',
    slots: [{ key: 'categoryTitle', label: '分类标题颜色' }],
  },
];

const HOME_THEME_SLOT_LABELS: Record<HomeThemeColorKey, string> = {
  accentBg: '主按钮背景色',
  accentInk: '主按钮文字色',
  linkTitle: '网址标题颜色',
  linkMeta: '网址说明／域名颜色',
  iconInk: '占位图标文字颜色',
  iconBg: '图标容器背景颜色',
  categoryTitle: '分类标题颜色',
};

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
 * The preset section: five cards, plus the one explicit way back.
 *
 * Selecting a card writes the preset's colours for the **currently selected
 * base** into the three brand fields. That is the whole mechanism — no new
 * persisted field, and no way for the saved home page and the saved admin to
 * disagree about what a preset means.
 *
 * Two rules are stated here because they are the ones a user cannot guess:
 *
 *  - `defaultTheme` is never touched. It is a *site-wide* setting that also
 *    restyles the admin, so silently flipping it from a home-page card would be
 *    a side effect well outside "首页主题".
 *  - the seven advanced colour slots are never touched either. They are the
 *    administrator's explicit instructions and outrank any preset.
 */
function HomeThemePresetSection({
  selected,
  disabled,
  basis,
  customisedSlots,
  canRestore,
  onSelect,
  onClear,
  onRestore,
}: {
  selected: HomeThemePresetId | undefined;
  disabled: boolean;
  /** The site's current base, forwarded so the matching swatch can be ringed. */
  basis: ThemeBasis;
  /** How many of the seven advanced slots are explicitly set. */
  customisedSlots: number;
  /** A preset is selected *and* its colours have since been edited. */
  canRestore: boolean;
  onSelect(id: HomeThemePresetId): void;
  onClear(): void;
  onRestore(): void;
}) {
  return (
    <fieldset className="branding__section branding__section--wide branding-presets">
      <legend className="branding__section-title">首页主题预设</legend>

      <HomeThemePresetCards
        selected={selected}
        disabled={disabled}
        basis={basis}
        onSelect={onSelect}
        onClear={onClear}
      />

      {selected !== undefined && customisedSlots > 0 ? (
        <p className="branding__color-hint">
          已保留 {String(customisedSlots)} 项高级自定义颜色，它们优先于主题配色。
        </p>
      ) : null}

      {canRestore ? (
        <div className="branding-home__actions">
          {/*
            Why the basis switch stopped following the preset.

            Shown only in the state that causes it — the three colours no longer
            match the preset — and stated as a fact plus the way out, not as an
            error. A dialog here would be wrong: the administrator did nothing
            wrong, they simply made a choice this feature respects.
          */}
          <p className="branding__color-hint branding-presets__hint">
            当前配色已自定义，切换明暗模式不会覆盖自定义颜色。可点击「恢复本主题默认配色」重新应用。
          </p>
          <button className="branding__button" type="button" disabled={disabled} onClick={onRestore}>
            恢复本主题默认配色
          </button>
          <span className="branding__color-hint">
            把品牌主色、页面背景色与面板色还原为当前主题的搭配；不影响上方选择的形态，也不影响高级自定义颜色。
          </span>
        </div>
      ) : null}
    </fieldset>
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
    /**
     * Explicit home-page colour overrides.
     *
     * `null` clears every override (back to automatic). Always sent on save so a
     * stale document cannot survive a save that did not intend to keep it.
     */
    homeThemeConfig: HomeThemeConfig | null;
  }): Promise<BrandingMutationOutcome>;
  uploadLogo(file: File): Promise<BrandingMutationOutcome>;
  uploadFavicon(file: File): Promise<BrandingMutationOutcome>;
  uploadBackground(file: File): Promise<BrandingMutationOutcome>;
  removeLogo(): Promise<BrandingMutationOutcome>;
  removeFavicon(): Promise<BrandingMutationOutcome>;
  removeBackground(): Promise<BrandingMutationOutcome>;
}

/**
 * A guard the surrounding admin page calls before discarding this view.
 *
 * Resolves `true` when it is safe to leave (nothing unsaved, or the
 * administrator explicitly chose to discard) and `false` to stay put.
 *
 * `AdminManagementView` renders one module at a time, so switching tabs unmounts
 * this component and its `useState` draft with it. The page-level `beforeunload`
 * listener cannot cover that case: no unload happens. Rather than hoisting the
 * draft into a global store, the view hands out this callback and keeps owning
 * both the draft and the confirmation — the smallest arrangement that works.
 */
export type UnsavedChangesGuard = () => Promise<boolean>;

export interface AdminBrandingViewProps {
  state: AdminBrandingState;
  actions: AdminBrandingActions;
  /** True while a branding mutation is in flight. */
  isMutating: boolean;
  /** Non-technical mutation failure text, if any. */
  errorMessage: string | null;
  /**
   * Registers (or clears) the guard the admin page consults before unmounting
   * this view. `null` means "nothing to lose", so the page skips the prompt.
   */
  onUnsavedGuard?: (guard: UnsavedChangesGuard | null) => void;
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
 * One home-page colour slot.
 *
 * Mirrors `ColorField` above so the two look identical, but differs in one
 * important way: the typed value is kept verbatim, including partial input such
 * as `#B45`. Snapping a half-typed value to a colour would be the classic way an
 * "automatic" slot silently becomes an explicit override.
 *
 * The picker itself stays usable at all times, in automatic mode too — T2
 * disabled it whenever the field was empty, so picking a colour required typing a
 * hex value first. It simply shows the colour the slot *actually renders* while
 * automatic, so the swatch matches what the administrator sees.
 */
function HomeThemeSlotField({
  id,
  label,
  value,
  effective,
  disabled,
  findings,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  /** The colour this slot actually renders, shown by the picker in automatic mode. */
  effective: string;
  disabled: boolean;
  findings: ContrastFinding[];
  onChange(value: string): void;
}) {
  const complete = isCompleteHexColor(value);
  // In automatic mode the picker shows the colour that actually renders, so the
  // swatch a administrator clicks to "start from what I see" is the real one —
  // not an unrelated hard-coded placeholder.
  const pickerValue = complete ? value.trim() : effective;
  const slotFindings = findings.filter((finding) => finding.label === label);
  const partial = value.trim().length > 0 && !complete;

  return (
    <div className="branding__field branding-home-slot">
      <label className="branding__label" htmlFor={id}>{label}</label>
      <div className="branding__color-controls">
        {/*
          Always enabled while the form is interactive, including in automatic
          mode. T2 disabled it whenever the text box was empty, which made the
          most common first action — pick a colour — impossible without typing a
          hex value by hand first.
        */}
        <input
          className="branding__color-picker"
          type="color"
          aria-label={`${label}选色`}
          value={pickerValue}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className="branding__input"
          id={id}
          name={`homeTheme${id}`}
          type="text"
          value={value}
          placeholder="自动"
          pattern="\s*#[0-9a-fA-F]{6}\s*|\s*"
          title="请输入六位颜色，如 #285B47，或留空使用自动配色。"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="branding__color-reset"
          type="button"
          aria-label={`${label}恢复自动`}
          disabled={disabled || value.trim().length === 0}
          onClick={() => onChange('')}
        >
          恢复自动
        </button>
      </div>

      {partial ? (
        <span className="branding__color-hint branding-home-slot__hint--invalid">
          请输入完整的六位颜色（如 #285B47），留空则使用自动配色。
        </span>
      ) : null}

      {slotFindings.map((finding) => (
        <span className="branding-home-slot__contrast" key={finding.pair}>
          <span aria-hidden="true">⚠</span>
          <span>
            {finding.pair} 对比度 {String(finding.ratio)}:1
            （{finding.kind === 'text' ? '文字建议' : '图标建议'} {String(finding.minimum)}:1）
          </span>
          {finding.suggestion !== null ? (
            <button
              className="branding-home-slot__suggest"
              type="button"
              disabled={disabled}
              onClick={() => onChange(finding.suggestion ?? '')}
            >
              改为 {finding.suggestion}
            </button>
          ) : (
            <span>请手动选择一个更深的背景或更亮的文字。</span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * The collapsible "advanced home colours" section.
 *
 * Collapsed by default: the seven slots are an advanced need, and PRODUCT.md
 * keeps the ordinary administrator's path short. Everything outside this section
 * behaves exactly as before.
 *
 * The live preview used to sit inside this panel, which meant the one place an
 * administrator could see the effect of a colour was collapsed shut by default.
 * It now lives in the always-visible preview card beside the form (T4.3); this
 * section keeps only the editor, and says where the result shows up.
 */
function HomeThemeSection({
  draft,
  disabled,
  findings,
  effective,
  unsaved,
  invalidSlots,
  onChangeSlot,
  onResetAll,
  hasBackgroundImage,
}: {
  draft: HomeThemeDraft;
  disabled: boolean;
  findings: ContrastFinding[];
  /** The colour each slot actually renders, for the picker in automatic mode. */
  effective: Record<HomeThemeColorKey, string>;
  unsaved: boolean;
  invalidSlots: HomeThemeColorKey[];
  onChangeSlot(key: HomeThemeColorKey, value: string): void;
  onResetAll(): void;
  hasBackgroundImage: boolean;
}) {
  const customised = isHomeThemeDraftCustomised(draft);

  return (
    <details className="branding-home" open={false}>
      <summary className="branding-home__summary">
        <span className="branding__label">高级颜色定制（首页）</span>
        <span className="branding__color-hint">
          {customised ? '已设置自定义颜色，保存后对所有访客生效' : '未设置时全部使用自动配色'}
        </span>
      </summary>

      <div className="branding-home__body">
        <p className="branding__asset-hint">
          留空即使用自动配色。自动配色会依据当前品牌色推导可读的前景色，因此通常无需逐项填写。
        </p>

        <p className="branding__asset-hint">
          修改会实时反映在页面右侧的「实时预览」中（手机端在下方），保存后对所有访客生效。
        </p>

        {/*
          Two separate messages, deliberately not merged:
          "unsaved" means the draft differs from what the server holds, while
          "invalid" means a value cannot be stored at all. T2 reused one flag for
          both and then disabled the whole section on it, which trapped the
          administrator inside the panel they were trying to fix.
        */}
        {unsaved ? (
          <p className="branding-home__notice" role="status">
            有未保存的首页颜色修改，离开此页面将丢失。
          </p>
        ) : null}

        {invalidSlots.length > 0 ? (
          <p className="branding-home__notice branding-home__notice--error" role="alert">
            有 {String(invalidSlots.length)} 项颜色格式不完整，请补全六位颜色或改为自动后才能保存。
          </p>
        ) : null}

        {hasBackgroundImage ? (
          // Stated plainly rather than silently omitted: a single colour cannot
          // describe every pixel behind the text, so no ratio would be truthful.
          <p className="branding-home__note">
            站点设置了背景图片，上面的对比度结果仅基于卡片底色估算。图片中较亮或较暗的区域可能让文字更难看清，请以真实首页为准。
          </p>
        ) : null}

        {HOME_THEME_GROUPS.map((group) => (
          <fieldset className="branding-home__group" key={group.id}>
            <legend className="branding__section-title">{group.title}</legend>
            <p className="branding__asset-hint">{group.hint}</p>
            {/*
              A slots wrapper rather than letting the group itself go two-up:
              the legend and the hint must stay full-width above the grid, and a
              fieldset's legend is not a grid item, so the columns would
              otherwise start beside the hint.
            */}
            <div className="branding-home__slots">
              {group.slots.map((slot) => (
                <HomeThemeSlotField
                  key={slot.key}
                  id={slot.key}
                  label={slot.label}
                  value={draft[slot.key]}
                  effective={effective[slot.key]}
                  disabled={disabled}
                  findings={findings}
                  onChange={(value) => { onChangeSlot(slot.key, value); }}
                />
              ))}
            </div>
          </fieldset>
        ))}

        <div className="branding-home__actions">
          <button
            className="branding__button"
            type="button"
            disabled={disabled || !customised}
            onClick={onResetAll}
          >
            全部恢复自动
          </button>
          <span className="branding__color-hint">
            「全部恢复自动」只清除首页颜色，不影响品牌主色、背景色或图片。
          </span>
        </div>
      </div>
    </details>
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
  onUnsavedGuard,
}: AdminBrandingViewProps) {
  const [siteName, setSiteName] = useState('');
  const [tagline, setTagline] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [pageBackgroundColor, setPageBackgroundColor] = useState('');
  const [surfaceColor, setSurfaceColor] = useState('');
  const [defaultTheme, setDefaultTheme] = useState<'light' | 'dark'>('light');
  const [footerText, setFooterText] = useState('');
  const [accessMode, setAccessMode] = useState<'public' | 'login_required'>('public');
  const [homeTheme, setHomeTheme] = useState<HomeThemeDraft>(EMPTY_HOME_THEME_DRAFT);
  /**
   * The draft's preset identity.
   *
   * Kept out of `homeTheme` on purpose: a slot holds a typed string the
   * administrator is editing, whereas this is the *choice* the form is making.
   * Merging them would mean a preset could be half-typed and half-saved.
   */
  const [homePreset, setHomePreset] = useState<HomeThemePresetId | undefined>(undefined);

  const data = state.status === 'ready' ? state.data : null;

  /**
   * Sync the form from authoritative server state **during render**.
   *
   * Uses React's documented "adjust state when a prop changes" pattern rather
   * than an effect: the server payload is the source of truth, so when it changes
   * (initial load, or after a successful save refetches) the form must adopt it.
   * A failed save refetches nothing, so whatever the user typed is preserved.
   *
   * A refetch caused by an asset operation adopts the new snapshot and leaves
   * the form alone (T4.3.1): the draft keeps its unsaved state, the save bar
   * keeps reporting it, and the asset previews update on their own because they
   * read `state.data` directly. Everything else — a save above all, including a
   * save whose stored result normalises back to the previous value — still syncs
   * the whole form, so a saved value can never be stranded behind this guard.
   */
  const [syncedFrom, setSyncedFrom] = useState<BrandingSettings | null>(null);
  const confirmation = useConfirmation();

  if (data !== null && data !== syncedFrom) {
    const assetsOnly = isAssetOnlySnapshotChange(syncedFrom, data);
    setSyncedFrom(data);
    if (!assetsOnly) {
      setSiteName(data.siteName);
      setTagline(data.tagline ?? '');
      setPrimaryColor(data.primaryColor ?? '');
      setPageBackgroundColor(data.pageBackgroundColor ?? '');
      setSurfaceColor(data.surfaceColor ?? '');
      setDefaultTheme(data.defaultTheme);
      setFooterText(data.footerText ?? '');
      setAccessMode(data.accessMode);
      // Adopt the stored home colours. Slots left automatic stay as empty strings
      // so opening the editor never materialises today's automatic appearance.
      setHomeTheme(homeThemeDraftFromConfig(data.homeThemeConfig));
      // `presetId` is the identity the stored document carries. A site saved before
      // T3 has none, and that must stay "no preset" rather than being snapped to
      // the recommended one (AC5).
      setHomePreset(data.homeThemeConfig?.presetId);
    }
  }

  /*
   * Mirror the draft's seven colour gates onto the document element.
   *
   * The T1 colour rules are `:root[data-home-<slot>='true'] .app.app--home …`, so
   * setting the same attributes here lets the preview run the production cascade
   * verbatim instead of a look-alike. This is safe on the admin page: every one
   * of those rules also requires `.app--home`, which no admin surface has.
   *
   * The **preset and basis are deliberately not mirrored here.** T3 mirrored the
   * preset onto `<html>` so the shape would survive navigation on the real page —
   * which is correct there and fatal in this form: `<html data-theme>` is the
   * saved basis, so its dark-variant rule outranked whatever the preview declared
   * and the miniature showed the saved theme's shape over the draft's colours.
   * The preview carries both on its own element instead (see `HomeThemePreview`).
   */
  const previewGates = useMemo(() => homeThemeDraftGates(homeTheme), [homeTheme]);
  useEffect(() => {
    const root = document.documentElement;
    const managed = [...HOME_THEME_GATE_NAMES];
    const clear = () => {
      for (const gate of managed) {
        root.removeAttribute(`data-${gate.replace(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`)}`);
      }
    };
    clear();
    for (const [attribute, value] of Object.entries(previewGates)) {
      root.setAttribute(attribute, value);
    }
    return clear;
  }, [previewGates]);

  /**
   * The draft branding, as the runtime sees it.
   *
   * One derivation feeds three consumers — the contrast baseline, the measured
   * card colour, and the preview's inline `--brand-*` — so they cannot disagree
   * about what the draft looks like. Empty fields become `null` here, which is
   * exactly what "automatic" means to `brandingThemeProperties()`.
   */
  const draftBranding = useMemo<PublicBranding>(() => ({
    siteName: '',
    tagline: null,
    logoPath: null,
    faviconPath: null,
    primaryColor: primaryColor.trim() || null,
    pageBackgroundColor: pageBackgroundColor.trim() || null,
    surfaceColor: surfaceColor.trim() || null,
    backgroundImagePath: null,
    defaultTheme,
    footerText: null,
    homeThemeConfig: null,
  }), [primaryColor, pageBackgroundColor, surfaceColor, defaultTheme]);

  /** The draft's derived custom properties — the same call the home page makes. */
  const draftBrandProperties = useMemo(
    () => brandingThemeProperties(draftBranding),
    [draftBranding],
  );

  /** The card/panel colour the preview paints and text ratios are measured against. */
  const cardBackground = useMemo(() => {
    const surface = draftBrandProperties['--brand-surface'];
    return typeof surface === 'string' ? surface : (defaultTheme === 'dark' ? '#202936' : '#FFFFFF');
  }, [draftBrandProperties, defaultTheme]);

  /**
   * Contrast findings for the current draft.
   *
   * Computed from the same resolution the preview and the page use, so what is
   * flagged is what will actually render.
   */
  /*
   * The automatic baseline every slot falls back to.
   *
   * Read from the same `brandingThemeProperties()` output the page consumes, so
   * the contrast checker measures against colours that will actually render
   * rather than a second hand-written set. A site with no brand colours gets the
   * stylesheet's own light-theme tokens, which is what would render anyway.
   */
  const homeBaseline = useMemo(() => {
    const dark = defaultTheme === 'dark';
    const brand = draftBrandProperties;
    const pick = (name: string, lightFallback: string, darkFallback: string): string => {
      const value = brand[name];
      return typeof value === 'string' ? value : (dark ? darkFallback : lightFallback);
    };
    return {
      accentBg: pick('--brand-primary', '#285B47', '#89C4A1'),
      accentInk: pick('--brand-on-primary', '#FFFFFF', '#0F1A13'),
      iconBg: pick('--brand-surface-muted-fill', '#EEF2F6', '#2A3544'),
      iconInk: pick('--brand-surface-ink', dark ? '#89C4A1' : '#285B47', '#89C4A1'),
      linkTitle: pick('--brand-surface-text', '#202B38', '#E8EEF4'),
      linkMeta: pick('--brand-surface-muted', '#566374', '#B3C0D0'),
      categoryTitle: pick('--brand-surface-text', '#202B38', '#E8EEF4'),
    };
  }, [draftBrandProperties, defaultTheme]);

  /**
   * Every slot's effective colour: the administrator's choice where present, the
   * automatic value otherwise, with automatic foregrounds following a chosen
   * background exactly as the home page does.
   */
  const homeEffective = useMemo(
    () => resolveEffectiveHomeColors(homeTheme, homeBaseline),
    [homeTheme, homeBaseline],
  );

  /**
   * Contrast findings.
   *
   * Computed from the *effective* colours, so choosing only a button text colour
   * against the automatic background is now checked — previously the automatic
   * background was absent from the input and the pair was skipped silently.
   */
  const homeFindings = useMemo(
    () => collectContrastFindings(homeEffective, cardBackground, HOME_THEME_SLOT_LABELS),
    [homeEffective, cardBackground],
  );

  /** The same effective colours, keyed by slot, for the automatic-mode picker. */
  const homeEffectiveBySlot = useMemo<Record<HomeThemeColorKey, string>>(() => ({
    accentBg: homeEffective['--home-accent-bg'] ?? homeBaseline.accentBg,
    accentInk: homeEffective['--home-accent-ink'] ?? homeBaseline.accentInk,
    linkTitle: homeEffective['--home-link-title'] ?? homeBaseline.linkTitle,
    linkMeta: homeEffective['--home-link-meta'] ?? homeBaseline.linkMeta,
    iconInk: homeEffective['--home-icon-ink'] ?? homeBaseline.iconInk,
    iconBg: homeEffective['--home-icon-bg'] ?? homeBaseline.iconBg,
    categoryTitle: homeEffective['--home-category-title'] ?? homeBaseline.categoryTitle,
  }), [homeEffective, homeBaseline]);

  /** Slots holding a value the server would reject. Blocks saving, never editing. */
  const homeInvalid = useMemo(() => invalidHomeThemeSlots(homeTheme), [homeTheme]);

  /** The preset the server last confirmed, or `undefined` for an older site. */
  const savedPresetId = syncedFrom?.homeThemeConfig?.presetId;

  /**
   * True when the home-theme draft differs from the last snapshot the server
   * confirmed.
   *
   * Two independent things can be lost by leaving this page, and both are
   * covered:
   *
   *  1. the seven advanced colours — `isHomeThemeDraftUnsaved` compares the raw
   *     field text against the stored document, including the preset identity;
   *  2. a newly chosen preset — which is *not* visible in `homeTheme` at all,
   *     since selecting a card writes the three brand colour fields instead.
   *     Without this second term, picking a theme and navigating away would lose
   *     it silently, which is exactly the failure AC9 is about.
   */
  const homeUnsaved = useMemo(
    () => isHomeThemeDraftUnsaved(homeTheme, syncedFrom?.homeThemeConfig ?? null, homePreset)
      || homePreset !== savedPresetId,
    [homeTheme, syncedFrom, homePreset, savedPresetId],
  );

  /**
   * True when the **whole form** differs from the last snapshot the server
   * confirmed.
   *
   * The guard used to cover only the home theme and the preset choice, because
   * those were the only surfaces with a comparison helper. That left the plain
   * fields — site name, tagline, brand colours, footer, access mode — silently
   * discardable: switching tabs lost them with no prompt at all. This is the
   * same comparison `isHomeThemeDraftUnsaved` applies to the seven slots,
   * extended to the rest of the form (T4.3), so the save bar's state and the
   * leave guard answer one question instead of two.
   */
  const baseUnsaved = useMemo(() => {
    if (syncedFrom === null) {
      return false;
    }
    return siteName !== syncedFrom.siteName
      || tagline !== (syncedFrom.tagline ?? '')
      || primaryColor !== (syncedFrom.primaryColor ?? '')
      || pageBackgroundColor !== (syncedFrom.pageBackgroundColor ?? '')
      || surfaceColor !== (syncedFrom.surfaceColor ?? '')
      || defaultTheme !== syncedFrom.defaultTheme
      || footerText !== (syncedFrom.footerText ?? '')
      || accessMode !== syncedFrom.accessMode;
  }, [siteName, tagline, primaryColor, pageBackgroundColor, surfaceColor, defaultTheme, footerText, accessMode, syncedFrom]);

  const formUnsaved = baseUnsaved || homeUnsaved;

  /**
   * Write a preset's colours for the given base into the three brand fields.
   *
   * Form-draft only. Nothing here calls an action, so a theme change is
   * reversible by simply choosing a different card — the server is not involved
   * until the administrator presses 保存.
   */
  const applyPresetPalette = useCallback((presetId: HomeThemePresetId, basis: 'light' | 'dark') => {
    const palette = homeThemePresetPalette(presetId, basis);
    if (palette === undefined) {
      return;
    }
    setPrimaryColor(palette.primaryColor);
    setPageBackgroundColor(palette.pageBackgroundColor);
    setSurfaceColor(palette.surfaceColor);
  }, []);

  const handleSelectPreset = useCallback((presetId: HomeThemePresetId) => {
    // The seven advanced slots are untouched on purpose: an explicit colour is
    // always the more specific instruction, so switching theme must not discard
    // one. What changes is everything the preset does not speak for.
    setHomePreset(presetId);
    applyPresetPalette(presetId, defaultTheme === 'dark' ? 'dark' : 'light');
  }, [applyPresetPalette, defaultTheme]);

  /** Drop the preset: the shape returns to B2, the colours stay as they are. */
  const handleClearPreset = useCallback(() => {
    setHomePreset(undefined);
  }, []);

  /**
   * Switching light↔dark follows the preset — but only while the three fields
   * still hold exactly what the preset put there.
   *
   * The equality test is the whole rule. Once the administrator has edited any of
   * them, their choice outranks the theme and flipping the base must not silently
   * repaint it.
   */
  const handleDefaultThemeChange = useCallback((next: 'light' | 'dark') => {
    const previous = defaultTheme === 'dark' ? 'dark' : 'light';
    const untouched = matchesHomeThemePresetPalette(
      {
        primaryColor: primaryColor.trim(),
        pageBackgroundColor: pageBackgroundColor.trim(),
        surfaceColor: surfaceColor.trim(),
      },
      homePreset,
      previous,
    );
    setDefaultTheme(next);
    if (untouched) {
      applyPresetPalette(homePreset as HomeThemePresetId, next);
    }
  }, [defaultTheme, primaryColor, pageBackgroundColor, surfaceColor, homePreset, applyPresetPalette]);

  /**
   * "Restore this theme's default colours."
   *
   * Reachable only when a preset is selected *and* its three colours were
   * changed afterwards; if they already match, the button would do nothing and
   * offering it would be noise.
   */
  const presetColoursChanged = useMemo(
    () => homePreset !== undefined
      && !matchesHomeThemePresetPalette(
        {
          primaryColor: primaryColor.trim(),
          pageBackgroundColor: pageBackgroundColor.trim(),
          surfaceColor: surfaceColor.trim(),
        },
        homePreset,
        defaultTheme === 'dark' ? 'dark' : 'light',
      ),
    [homePreset, primaryColor, pageBackgroundColor, surfaceColor, defaultTheme],
  );

  const handleRestorePresetPalette = useCallback(() => {
    if (homePreset !== undefined) {
      applyPresetPalette(homePreset, defaultTheme === 'dark' ? 'dark' : 'light');
    }
  }, [homePreset, defaultTheme, applyPresetPalette]);

  /** How many of the seven advanced slots are explicitly set. */
  const customisedSlotCount = useMemo(
    () => (Object.keys(homeTheme) as HomeThemeColorKey[])
      .filter((key) => homeTheme[key].trim().length > 0).length,
    [homeTheme],
  );

  /*
   * Warn before a page-level unload while the draft is unsaved.
   *
   * Scoped to this one form's state rather than a navigation-guard framework:
   * the listener exists only while there is something to lose, and is removed
   * the moment the draft matches what was saved.
   */
  useEffect(() => {
    if (!formUnsaved) {
      return undefined;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers require returnValue to be set to show the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [formUnsaved]);

  /*
   * A brief "saved" acknowledgement for the save bar.
   *
   * Derived, not timed: it shows exactly while the last thing that happened
   * was a successful save and nothing has changed since. The moment a field is
   * touched the form becomes unsaved and the bar says that instead, so the
   * acknowledgement cannot outstay its meaning. (A timeout would need
   * `setState` inside an effect, which this project's lint rules forbid — and
   * the derived form is the smaller mechanism anyway.)
   */
  const [saveCount, setSaveCount] = useState(0);
  const savedAck = saveCount > 0 && !formUnsaved;

  /*
   * In-page guard, covering the case `beforeunload` cannot: the admin page shows
   * one module at a time, so switching tabs or returning to the Home unmounts
   * this component and its draft together, with no page unload involved.
   *
   * A stable callback identity is used so the page can call it without
   * re-registering on every keystroke; it reads the current state through refs.
   */
  const formUnsavedRef = useRef(formUnsaved);
  const confirmationRef = useRef(confirmation);
  /** Set only while a discard prompt is open; resolved by confirm or cancel. */
  const resolveDiscardRef = useRef<((value: boolean) => void) | null>(null);

  // Mirrored into refs after commit so the guard can keep a stable identity and
  // still read the current values; writing during render is not allowed.
  useEffect(() => {
    formUnsavedRef.current = formUnsaved;
    confirmationRef.current = confirmation;
  });

  const guard = useCallback(async (): Promise<boolean> => {
    if (!formUnsavedRef.current) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      resolveDiscardRef.current = (value) => {
        resolveDiscardRef.current = null;
        resolve(value);
      };
      confirmationRef.current.confirm({
        title: '放弃未保存的修改？',
        message: '离开品牌设置后，尚未保存的修改将丢失。',
        actionLabel: '放弃修改',
        onConfirm: async () => {
          resolveDiscardRef.current?.(true);
          return { status: 'ok' };
        },
      });
    });
  }, []);

  useEffect(() => {
    if (onUnsavedGuard === undefined) {
      return undefined;
    }
    onUnsavedGuard(formUnsaved ? guard : null);
    return () => { onUnsavedGuard(null); };
  }, [formUnsaved, guard, onUnsavedGuard]);

  // Cancelling the dialog must resolve the guard as "stay here". Only the guard
  // sets the resolver, so a closing low-contrast prompt leaves this untouched.
  const activeRequest = confirmation.request;
  useEffect(() => {
    if (activeRequest === null && resolveDiscardRef.current !== null) {
      resolveDiscardRef.current(false);
    }
  }, [activeRequest]);

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

  /*
   * The save bar's single state, derived rather than stored.
   *
   * Five states, in priority order: a mutation in flight outranks everything;
   * an unusable colour blocks the save and says so; then the two states the
   * administrator is actually looking for — something to save, or the brief
   * acknowledgement that it landed. `clean` is the resting state.
   */
  const saveState = isMutating
    ? 'saving'
    : homeInvalid.length > 0
      ? 'invalid'
      : formUnsaved
        ? 'unsaved'
        : savedAck
          ? 'saved'
          : 'clean';
  const saveStatus = saveState === 'saving'
    ? '保存中…'
    : saveState === 'invalid'
      ? `有 ${String(homeInvalid.length)} 项颜色格式不完整，暂时无法保存`
      : saveState === 'unsaved'
        ? '有未保存的修改'
        : saveState === 'saved'
          ? '已保存'
          : '所有修改均已保存';

  return (
    <section className="branding" aria-labelledby="branding-title">
      <header className="branding__header">
        <div className="branding__header-text">
          <h2 className="branding__title" id="branding-title">
            品牌设置
          </h2>
          <p className="branding__lede">
            配置站点标识、首页主题与品牌图片。网站信息、主题与颜色需点击「保存」后生效；Logo、Favicon、背景图片的上传与移除立即生效。
          </p>
        </div>
      </header>

      {errorMessage !== null && errorMessage.length > 0 ? (
        <p className="branding__error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {/*
        The theme picker leads the page and spans its full width.

        It is the primary appearance control — everything below it either feeds
        it (the three brand colours a preset writes) or refines it (the seven
        advanced slots) — so it gets the hero position instead of sitting under
        a column of text fields. T4.2 had it below the two-column form, where
        the unbalanced columns pushed it past the fold.
      */}
      <HomeThemePresetSection
        selected={homePreset}
        disabled={isMutating}
        basis={defaultTheme === 'dark' ? 'dark' : 'light'}
        customisedSlots={customisedSlotCount}
        canRestore={presetColoursChanged}
        onSelect={handleSelectPreset}
        onClear={handleClearPreset}
        onRestore={handleRestorePresetPalette}
      />

      <div className="branding__layout">
        <form
          className="branding__form"
          id="branding-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (isMutating || siteName.trim().length === 0) {
              return;
            }

            // Refuse to submit an unusable colour. The field stays editable and the
            // section stays enabled — only this one action is withheld, and the
            // reason is already shown in the panel.
            if (homeInvalid.length > 0) {
              return;
            }

            const input = {
              siteName,
              tagline: tagline.trim().length === 0 ? null : tagline,
              primaryColor: primaryColor.trim().length === 0 ? null : primaryColor,
              pageBackgroundColor: pageBackgroundColor.trim().length === 0 ? null : pageBackgroundColor,
              surfaceColor: surfaceColor.trim().length === 0 ? null : surfaceColor,
              defaultTheme,
              footerText: footerText.trim().length === 0 ? null : footerText,
              accessMode,
              // Always sent. The stored `presetId` is carried through so clearing
              // every colour restores automatic rendering *without* detaching the
              // site from its theme identity — see `homeThemeDraftToPayload`. The
              // *draft's* preset wins, never the stored one: that is the whole
              // point of choosing a theme before saving.
              homeThemeConfig: homeThemeDraftToPayload(homeTheme, homePreset),
            };

            // A contrast problem must never block the administrator, but it must
            // never pass unnoticed either: they confirm, explicitly.
            if (homeFindings.length > 0) {
              // The dialog's `onConfirm` contract returns the mutation outcome, so
              // reuse it rather than firing and forgetting: the dialog closes only
              // when the save actually reports success.
              confirmation.confirm({
                title: '仍有对比度不足的颜色',
                message: `以下颜色组合可读性不足：${homeFindings.map((f) => f.pair).join('、')}。`
                  + '保存后这些颜色会照常生效，确定继续吗？',
                actionLabel: '仍然保存',
                onConfirm: async () => {
                  const outcome = await actions.save(input);
                  if (outcome.status === 'ok') {
                    setSaveCount((count) => count + 1);
                  }
                  return outcome;
                },
              });
              return;
            }

            void actions.save(input).then((outcome) => {
              if (outcome.status === 'ok') {
                setSaveCount((count) => count + 1);
              }
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

          {/*
            The three brand colours and the base, on their own.

            They used to share a card with the access mode and the preview, which
            made 「外观与访问」 a drawer of unrelated things. These three fields are
            what a preset writes and what the preview reads, so they belong
            together; access mode is not an appearance setting at all.
          */}
          <fieldset className="branding__section">
            <legend className="branding__section-title">品牌配色与明暗</legend>
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
                onChange={(event) => { handleDefaultThemeChange(event.target.value === 'dark' ? 'dark' : 'light'); }}
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
          </fieldset>

          <HomeThemeSection
            draft={homeTheme}
            disabled={isMutating}
            findings={homeFindings}
            effective={homeEffectiveBySlot}
            unsaved={homeUnsaved}
            invalidSlots={homeInvalid}
            hasBackgroundImage={state.data.backgroundImagePath !== null}
            onChangeSlot={(key, value) => {
              // Never disable the panel on a bad value: an unfinished entry must
              // stay editable so it can be completed, cleared or reverted.
              setHomeTheme((previous) => ({ ...previous, [key]: value }));
            }}
            onResetAll={() => {
              setHomeTheme(EMPTY_HOME_THEME_DRAFT);
            }}
          />

          {/*
            The assets moved inside the form and into a real card.

            They used to hang off the bottom of the page as a bare heading plus a
            grid, outside the form entirely — the one group on the page without
            the card treatment every other group has, and past the save button,
            which made them read as an afterthought rather than settings.
          */}
          <fieldset className="branding__section">
            <legend className="branding__section-title">品牌图片</legend>
            <p className="branding__asset-hint">图片的上传与移除立即生效，不经过「保存」。</p>
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
          </fieldset>

          <fieldset className="branding__section">
            <legend className="branding__section-title">访问设置</legend>
            <p className="branding__asset-hint">决定访客打开导航站时是否需要先登录。</p>
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
          </fieldset>
        </form>

        {/*
          The preview rail, beside the form on desktop and above the save bar on
          a phone.

          Both existing previews live here, each labelled for the question it
          answers: the home panel runs the production cascade (preset shape plus
          the seven advanced colours, on the real class names), and the frame
          shows the brand colours on the page chrome. Neither is new machinery —
          the components, their inline draft values and their gate attributes
          are unchanged; only their position is. The home panel preview used to
          sit inside the collapsed advanced panel, where the one place to see a
          colour's effect was shut by default, and the frame preview sat in the
          middle of the form. One destination for "what will it look like" is
          the clearer hierarchy.
        */}
        <aside className="branding__aside" aria-label="实时预览">
          <div className="branding__section branding__preview-card">
            <h3 className="branding__section-title">实时预览</h3>
            <p className="branding__asset-hint">当前草稿的渲染效果，与保存后的首页一致；未保存不会影响线上站点。</p>

            <div className="branding__preview-block">
              <span className="branding__label">首页面板</span>
              <HomeThemePreview
                draft={homeTheme}
                brandProperties={draftBrandProperties}
                presetId={homePreset}
                basis={defaultTheme === 'dark' ? 'dark' : 'light'}
              />
            </div>

            <div className="branding__live-preview">
              <span className="branding__label">页面框架与品牌色</span>
              <span className="branding__color-hint">颜色实时预览，保存后应用；图片上传后更新。</span>
              <BrandingPreview branding={{ ...state.data, siteName, tagline, primaryColor,
                pageBackgroundColor, surfaceColor, defaultTheme }} />
            </div>
          </div>
        </aside>
      </div>

      {/*
        The single save entry, always reachable.

        The old button sat at the end of a form that measures 2,000–3,600px, so
        saving meant scrolling back past everything just edited — measured at
        652px below the fold collapsed and 2,275px with the advanced panel open.
        This bar is `position: sticky`, so it rides the bottom of the viewport
        for as long as the page is on screen, states what is unsaved, and is the
        only save control on the page: the in-form button is gone rather than
        duplicated. It submits the form by association (`form=`), so the save
        logic above is untouched.
      */}
      <div className="branding__savebar" data-state={saveState}>
        <span className="branding__savebar-status" role="status">
          {saveStatus}
        </span>
        <button
          className="branding__button branding__button--primary branding__savebar-button"
          type="submit"
          form="branding-form"
          disabled={isMutating || siteName.trim().length === 0 || homeInvalid.length > 0}
        >
          保存
        </button>
      </div>

      <ConfirmDialog request={confirmation.request} onDismiss={confirmation.dismiss} />
    </section>
  );
}
