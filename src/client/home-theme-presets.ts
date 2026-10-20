/**
 * The five home-page theme presets.
 *
 * A preset is a **starting point plus a shape language**, and it is deliberately
 * two things rather than one:
 *
 *  1. **Colour** — the three brand colour fields (`primaryColor`,
 *     `pageBackgroundColor`, `surfaceColor`) for both bases. These are real
 *     persisted settings, not a render-time trick: writing them is what makes the
 *     saved home page and the saved admin agree, and it is why a preset can be
 *     implemented without touching the schema.
 *  2. **Shape** — panel / block / chip radius, the panel shadow, and the two
 *     borders a preset may legitimately need to strengthen. These are the
 *     `--home-*` variables `main.css` already reads, keyed off
 *     `data-home-preset` on the document element.
 *
 * The split matters for the seven advanced colour slots: a preset never writes
 * `--home-accent-*` and friends. An administrator's explicit colour therefore
 * cannot be shadowed by a preset switch, and a preset can never silently
 * overwrite one — the two are separate surfaces by construction, not by
 * precedence rules that have to be kept in sync.
 *
 * Every value here is a literal in this file. Nothing reaches the DOM from user
 * input: the `#RRGGBB` validation story in `branding.ts` is untouched, because a
 * preset is the *source* of those values rather than a carrier of them.
 */

import type { HomeThemePresetId } from './api/admin-branding.js';

/** Light or dark. Matches `site_settings.default_theme`. */
export type ThemeBasis = 'light' | 'dark';

/** The three persisted brand colour fields, as the branding form holds them. */
export interface HomeThemePalette {
  primaryColor: string;
  pageBackgroundColor: string;
  surfaceColor: string;
}

/**
 * The CSS custom properties a preset may set, named once.
 *
 * Named here rather than in `main.css` so a preset and the stylesheet cannot
 * drift: `home-theme-css.test.ts` asserts every name below is actually *read*
 * somewhere in the stylesheet. A property that is only written is a silent no-op
 * — the page keeps the default and nothing reports an error.
 */
export const HOME_THEME_SHAPE_PROPERTIES = {
  panelRadius: '--home-panel-radius',
  blockRadius: '--home-block-radius',
  chipRadius: '--home-chip-radius',
  panelShadow: '--home-panel-shadow',
  panelBorder: '--home-panel-border',
  blockHoverBorder: '--home-block-hover-border',
} as const;

export type HomeThemeShapeKey = keyof typeof HOME_THEME_SHAPE_PROPERTIES;

/** Radius values are basis-independent; the rest differ per base. */
export interface HomeThemePresetShape {
  panelRadius: string;
  blockRadius: string;
  chipRadius: string;
  panelShadow: Record<ThemeBasis, string>;
  /**
   * The panel's own boundary colour. Defaults to `var(--border)`; a preset only
   * overrides it when its surface and canvas are too close for the shared
   * derivation to reach the 3:1 that identifies a UI component.
   */
  panelBorder: Record<ThemeBasis, string>;
  /** The hairline a link block grows on hover. */
  blockHoverBorder: Record<ThemeBasis, string>;
}

export interface HomeThemePreset {
  id: HomeThemePresetId;
  name: string;
  /** One line, shown on the card: what this theme is *for*. */
  positioning: string;
  /** Both bases. A preset that only worked in one would be half a theme. */
  palette: Record<ThemeBasis, HomeThemePalette>;
  shape: HomeThemePresetShape;
}

const NO_SHADOW = 'none';

/** Reads as the shared hairline; nothing to override for a normal preset. */
const SHARED_BORDER = 'var(--border)';
const SHARED_HOVER_BORDER = 'var(--border-strong)';

export const HOME_THEME_PRESETS: readonly HomeThemePreset[] = [
  {
    id: 'nordic-frost',
    name: '北欧霜白',
    positioning: '中性偏冷，长时间浏览最省眼。画布与卡片只差一点点，靠边框分层。',
    palette: {
      light: { primaryColor: '#3D6B8C', pageBackgroundColor: '#F4F6F8', surfaceColor: '#FFFFFF' },
      dark: { primaryColor: '#8FB8D4', pageBackgroundColor: '#151A1F', surfaceColor: '#1F262D' },
    },
    shape: {
      panelRadius: '1rem',
      blockRadius: '0.55rem',
      chipRadius: '0.6rem',
      // Separation comes from the hairline, not from a lift. A shadow here would
      // double the boundary the border already draws.
      panelShadow: { light: NO_SHADOW, dark: NO_SHADOW },
      panelBorder: { light: SHARED_BORDER, dark: SHARED_BORDER },
      blockHoverBorder: { light: SHARED_HOVER_BORDER, dark: SHARED_HOVER_BORDER },
    },
  },
  {
    id: 'warm-paper',
    name: '暖纸墨',
    positioning: '低饱和暖白，适合以阅读为主的站点。圆角刻意收小，配合“纸”的硬朗感。',
    palette: {
      light: { primaryColor: '#7A5C3E', pageBackgroundColor: '#F6F3EE', surfaceColor: '#FFFDF9' },
      dark: { primaryColor: '#CBA97E', pageBackgroundColor: '#1C1917', surfaceColor: '#282320' },
    },
    shape: {
      panelRadius: '0.75rem',
      blockRadius: '0.4rem',
      chipRadius: '0.45rem',
      panelShadow: {
        light: '0 1px 2px rgba(60, 45, 28, 0.05), 0 6px 16px rgba(60, 45, 28, 0.06)',
        dark: '0 1px 2px rgba(0, 0, 0, 0.35), 0 8px 20px rgba(0, 0, 0, 0.28)',
      },
      panelBorder: { light: SHARED_BORDER, dark: SHARED_BORDER },
      blockHoverBorder: { light: SHARED_HOVER_BORDER, dark: SHARED_HOVER_BORDER },
    },
  },
  {
    id: 'deep-sea',
    name: '深海静蓝',
    positioning: '深色优先，大屏值守。画布比纯黑抬高一档，圆角最大，是五套里最“软”的。',
    palette: {
      light: { primaryColor: '#2E6E8E', pageBackgroundColor: '#EDF3F6', surfaceColor: '#FFFFFF' },
      dark: { primaryColor: '#7FC4DD', pageBackgroundColor: '#101820', surfaceColor: '#1A2530' },
    },
    shape: {
      panelRadius: '1.25rem',
      blockRadius: '0.65rem',
      chipRadius: '0.7rem',
      panelShadow: {
        light: '0 2px 4px rgba(16, 24, 32, 0.05), 0 10px 26px rgba(16, 24, 32, 0.07)',
        dark: '0 2px 6px rgba(0, 0, 0, 0.4), 0 12px 30px rgba(0, 0, 0, 0.32)',
      },
      panelBorder: { light: SHARED_BORDER, dark: SHARED_BORDER },
      blockHoverBorder: { light: SHARED_HOVER_BORDER, dark: SHARED_HOVER_BORDER },
    },
  },
  {
    id: 'forest-mist',
    name: '林间薄雾',
    positioning: '延续当前的绿品牌但大幅降饱和。老站点切过来视觉几乎不变。',
    palette: {
      light: { primaryColor: '#3F6B57', pageBackgroundColor: '#EFF3F0', surfaceColor: '#FBFDFC' },
      dark: { primaryColor: '#8FC0A5', pageBackgroundColor: '#141A17', surfaceColor: '#1F2723' },
    },
    shape: {
      panelRadius: '1rem',
      blockRadius: '0.5rem',
      chipRadius: '0.55rem',
      panelShadow: { light: NO_SHADOW, dark: NO_SHADOW },
      panelBorder: { light: SHARED_BORDER, dark: SHARED_BORDER },
      blockHoverBorder: { light: SHARED_HOVER_BORDER, dark: SHARED_HOVER_BORDER },
    },
  },
  {
    id: 'high-contrast',
    name: '高对比专注',
    positioning: '纯黑白 + 高饱和蓝，为强光环境与弱视而设。控件边界全部给足 3:1。',
    palette: {
      light: { primaryColor: '#1F4B99', pageBackgroundColor: '#FFFFFF', surfaceColor: '#FFFFFF' },
      dark: { primaryColor: '#9CC4FF', pageBackgroundColor: '#000000', surfaceColor: '#0A0A0A' },
    },
    shape: {
      panelRadius: '0.5rem',
      blockRadius: '0.35rem',
      chipRadius: '0.4rem',
      panelShadow: { light: NO_SHADOW, dark: NO_SHADOW },
      /*
       * The one place a preset overrides a border, and it has to.
       *
       * Canvas and surface are both `#FFFFFF` here, so the panel has nothing but
       * its border to identify it — and the shared derivation draws that border at
       * a 0.22 mix weight, which measured 2.66:1 (light) against the 3:1 that
       * WCAG 1.4.11 asks of the visual information needed to identify a
       * component. Strengthening the derivation engine instead would change every
       * site and require a new persisted field; naming a theme "high contrast"
       * while shipping a 2.66:1 boundary would be worse than either. Pure
       * black/white on this one theme is the minimal fix, and it stays inside
       * the home page.
       */
      panelBorder: { light: '#000000', dark: '#FFFFFF' },
      blockHoverBorder: { light: '#000000', dark: '#FFFFFF' },
    },
  },
];

/** Lookup by id. Returns `undefined` for an unknown or absent preset. */
export function findHomeThemePreset(id: HomeThemePresetId | undefined | null): HomeThemePreset | undefined {
  if (id === undefined || id === null) {
    return undefined;
  }
  return HOME_THEME_PRESETS.find((preset) => preset.id === id);
}

/** The three colour fields for one base, or `undefined` for an unknown preset. */
export function homeThemePresetPalette(
  id: HomeThemePresetId | undefined | null,
  basis: ThemeBasis,
): HomeThemePalette | undefined {
  return findHomeThemePreset(id)?.palette[basis];
}

/**
 * Do the current brand colours still match this preset's palette for this base?
 *
 * The "switching base follows the preset" rule needs exactly this question, and
 * the answer must be **equality, not resemblance**: once the administrator has
 * touched any of the three fields, flipping light↔dark must not overwrite their
 * choice. The comparison is case-insensitive because the picker and the hex field
 * both round-trip through different casings.
 */
export function matchesHomeThemePresetPalette(
  current: HomeThemePalette,
  id: HomeThemePresetId | undefined | null,
  basis: ThemeBasis,
): boolean {
  const palette = homeThemePresetPalette(id, basis);
  if (palette === undefined) {
    return false;
  }
  const normalise = (value: string): string => value.trim().toUpperCase();
  return normalise(current.primaryColor) === normalise(palette.primaryColor)
    && normalise(current.pageBackgroundColor) === normalise(palette.pageBackgroundColor)
    && normalise(current.surfaceColor) === normalise(palette.surfaceColor);
}

/**
 * The shape custom properties a preset contributes for one base.
 *
 * Exported so the CSS guard can assert that every key is *consumed* by the
 * stylesheet, and so the admin preview can mirror production by writing the same
 * values the page receives.
 */
export function homeThemePresetShapeProperties(
  preset: HomeThemePreset,
  basis: ThemeBasis,
): Record<string, string> {
  return {
    [HOME_THEME_SHAPE_PROPERTIES.panelRadius]: preset.shape.panelRadius,
    [HOME_THEME_SHAPE_PROPERTIES.blockRadius]: preset.shape.blockRadius,
    [HOME_THEME_SHAPE_PROPERTIES.chipRadius]: preset.shape.chipRadius,
    [HOME_THEME_SHAPE_PROPERTIES.panelShadow]: preset.shape.panelShadow[basis],
    [HOME_THEME_SHAPE_PROPERTIES.panelBorder]: preset.shape.panelBorder[basis],
    [HOME_THEME_SHAPE_PROPERTIES.blockHoverBorder]: preset.shape.blockHoverBorder[basis],
  };
}

/**
 * The attributes that activate a preset's shape, both set on the **home element
 * itself** (`.app--home`), never on `<html>`.
 *
 * `data-home-preset` was a root attribute in T3, so the shape survived navigation
 * without per-mount bookkeeping. T3.1 measured why that was the wrong trade: the
 * admin preview cannot express an unsaved basis while `<html data-theme>` holds
 * the saved one, because the root's dark-variant rule outranks anything the
 * preview declares. Styling the element that actually carries the preset removes
 * the conflict by construction, and `App.tsx` already re-runs its branding effect
 * on navigation, writing the seven `--home-*` values the same way.
 *
 * `data-home-basis` is a separate attribute rather than a reuse of `data-theme`:
 * `data-theme` also drives the admin, and a home-theme preview must never be able
 * to pull the whole backend to another basis. On the site it mirrors
 * `defaultTheme`; in the admin preview it is the form's draft.
 */
export const HOME_THEME_PRESET_ATTRIBUTE = 'data-home-preset';
export const HOME_THEME_BASIS_ATTRIBUTE = 'data-home-basis';

/** The `data-*` dataset key React/DOM writes for the preset attribute. */
export const HOME_THEME_PRESET_DATASET_KEY = 'homePreset';
