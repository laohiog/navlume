/**
 * The admin's editable draft of the seven home-page colour slots.
 *
 * Kept apart from the view so the *preview*, the *contrast checks* and the
 * *save payload* are all derived from one place. That matters: if the preview
 * recomputed colours on its own, it would eventually disagree with the real home
 * page — which is exactly the defect this module prevents. Everything here
 * delegates to `homeThemeOverrides()` from T1, the same function the home page
 * itself uses.
 *
 * A slot holds a **user-typed string**, not a resolved colour. That distinction
 * is the whole point: an empty string means "automatic" and must never be turned
 * into a concrete colour on the way to the server, or opening the editor would
 * silently freeze today's automatic appearance into an explicit override.
 */

import {
  colorContrast,
  homeThemeOverrideGates,
  homeThemeOverrides,
  readableForeground,
} from './branding-theme.js';
import type { HomeThemeColorKey, HomeThemeConfig } from './api/admin-branding.js';

export type HomeThemeDraft = Record<HomeThemeColorKey, string>;

/** Every slot starts automatic; an empty draft means "no explicit configuration". */
export const EMPTY_HOME_THEME_DRAFT: HomeThemeDraft = {
  accentBg: '',
  accentInk: '',
  linkTitle: '',
  linkMeta: '',
  iconInk: '',
  iconBg: '',
  categoryTitle: '',
};

/**
 * Read a stored document into an editable draft.
 *
 * Only slots holding an explicit colour become typed text; everything else stays
 * empty so the automatic behaviour is preserved rather than materialised.
 */
export function homeThemeDraftFromConfig(config: HomeThemeConfig | null | undefined): HomeThemeDraft {
  const draft: HomeThemeDraft = { ...EMPTY_HOME_THEME_DRAFT };
  if (config === null || config === undefined) {
    return draft;
  }
  for (const key of Object.keys(EMPTY_HOME_THEME_DRAFT) as HomeThemeColorKey[]) {
    const value = config.overrides[key];
    if (typeof value === 'string') {
      draft[key] = value;
    }
  }
  return draft;
}

/** True when the draft contains at least one explicit colour. */
export function isHomeThemeDraftCustomised(draft: HomeThemeDraft): boolean {
  return (Object.keys(draft) as HomeThemeColorKey[]).some((key) => draft[key].trim().length > 0);
}

/**
 * The draft's own preview document. Empty string slots stay automatic.
 *
 * A value that is not a complete `#RRGGBB` is treated as **absent** rather than
 * forwarded. That is what stops a half-typed `#B45` from reaching a CSS custom
 * property: the browser rejects the whole declaration, silently falls back to the
 * automatic colour, and the preview would silently disagree with the field.
 */
export function homeThemeDraftToConfig(draft: HomeThemeDraft): HomeThemeConfig {
  const overrides: HomeThemeConfig['overrides'] = {};
  for (const key of Object.keys(draft) as HomeThemeColorKey[]) {
    const value = draft[key].trim();
    overrides[key] = isCompleteHexColor(value) ? value.toUpperCase() : null;
  }
  return { version: 1, overrides };
}

/**
 * The payload to persist.
 *
 * Clearing every colour must not throw the theme's **identity** away. A document
 * carrying only `presetId` is still meaningful: it records which theme the site
 * is on while leaving every colour automatic. Dropping it would silently detach a
 * T3 theme switch from the administrator's choices — the preset would appear
 * forgotten, and re-selecting it later would not restore anything.
 *
 * `null` is therefore reserved for the genuinely default state: no preset and no
 * overrides, which is what a fresh site should store.
 */
export function homeThemeDraftToPayload(
  draft: HomeThemeDraft,
  presetId: HomeThemeConfig['presetId'] | undefined,
): HomeThemeConfig | null {
  if (!isHomeThemeDraftCustomised(draft)) {
    return presetId === undefined ? null : { version: 1, presetId, overrides: {} };
  }
  return presetId === undefined
    ? homeThemeDraftToConfig(draft)
    : { ...homeThemeDraftToConfig(draft), presetId };
}

/**
 * Whether the draft differs from what is currently saved.
 *
 * Compares the **raw text of each field**, not the converted document, because
 * `homeThemeDraftToConfig()` deliberately discards anything that is not a
 * complete `#RRGGBB`. Comparing the converted form would therefore report "no
 * change" for a half-typed `#B45` on an otherwise-automatic slot — the field on
 * screen visibly differs from the saved state, and that difference must not be
 * silently discarded. (T2.2 Finding 2.)
 *
 * Comparison stays insensitive to formatting that cannot be stored anyway:
 * surrounding whitespace and hex case are normalised away, so re-typing the same
 * colour with different capitals does not raise a false alarm. Such a field
 * cannot be saved, so it also cannot be a meaningful edit.
 */
export function isHomeThemeDraftUnsaved(
  draft: HomeThemeDraft,
  saved: HomeThemeConfig | null,
  presetId?: HomeThemeConfig['presetId'],
): boolean {
  const current = saved ?? null;
  const slotKeys = Object.keys(EMPTY_HOME_THEME_DRAFT) as HomeThemeColorKey[];

  if (current === null) {
    return isHomeThemeDraftCustomised(draft) || presetId !== undefined;
  }

  // The draft does not carry an identity of its own — it is passed alongside — so
  // compare it explicitly. Clearing every colour must still count as a change
  // when a preset would be preserved, otherwise that save would look like a
  // no-op and the administrator would never be told it took effect.
  if (presetId !== current.presetId) {
    return true;
  }

  for (const key of slotKeys) {
    const typed = draft[key].trim();
    const stored = typeof current.overrides[key] === 'string'
      ? current.overrides[key]!.trim()
      : '';
    if (typed.toUpperCase() !== stored.toUpperCase()) {
      return true;
    }
  }

  return false;
}

/**
 * Slots whose typed value cannot be persisted.
 *
 * Used to block the save and to flag the row — never to disable the editor:
 * locking the whole panel because one field is mid-typing traps the
 * administrator in the section they are trying to fix.
 */
export function invalidHomeThemeSlots(draft: HomeThemeDraft): HomeThemeColorKey[] {
  return (Object.keys(draft) as HomeThemeColorKey[])
    .filter((key) => draft[key].trim().length > 0 && !isCompleteHexColor(draft[key]));
}

/** Drop an unusable slot back to automatic, used by "revert this one". */
export function withoutInvalidSlots(draft: HomeThemeDraft): HomeThemeDraft {
  const next = { ...draft };
  for (const key of invalidHomeThemeSlots(draft)) {
    next[key] = '';
  }
  return next;
}

/** Is this typed value a usable `#RRGGBB`? Rejects partial input while typing. */
export function isCompleteHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

/** Text/background pairs worth reporting a contrast ratio for. */
export type ContrastPairKind = 'text' | 'nonText';

export interface ContrastFinding {
  /** The slot whose colour is at fault, so the message can name it. */
  slot: HomeThemeColorKey;
  label: string;
  /** What the ratio was measured between. */
  pair: string;
  kind: ContrastPairKind;
  ratio: number;
  minimum: number;
  /** A concrete colour that would pass, or `null` when none can be derived. */
  suggestion: string | null;
}

/**
 * Measure the foreground/background pairs that can be **known** from colours alone.
 *
 * `resolved` holds the *effective* value of every slot — the administrator's
 * choice where they made one, the automatic value otherwise. T2 originally passed
 * only the override properties, so a pair whose background stayed automatic had
 * nothing to measure and was silently skipped: choosing a button text colour that
 * clashes with the automatic background raised no warning at all. Callers now
 * resolve first (see `resolveEffectiveHomeColors`) and pass the complete picture.
 *
 * A background *image* is still deliberately excluded. A single colour cannot
 * describe every pixel behind the text, so any ratio computed there would be a
 * false assurance; the view states the limitation in words instead.
 */
export function collectContrastFindings(
  resolved: Record<string, string>,
  cardBackground: string,
  labels: Record<HomeThemeColorKey, string>,
): ContrastFinding[] {
  const findings: ContrastFinding[] = [];

  const push = (slot: HomeThemeColorKey, pair: string, kind: ContrastPairKind, fg: string, bg: string) => {
    if (!isCompleteHexColor(fg) || !isCompleteHexColor(bg)) {
      return;
    }
    const minimum = kind === 'text' ? 4.5 : 3;
    const ratio = Math.round(colorContrast(fg, bg) * 100) / 100;
    if (ratio < minimum) {
      findings.push({
        slot,
        label: labels[slot],
        pair,
        kind,
        ratio,
        minimum,
        suggestion: suggestReadable(fg, bg, minimum),
      });
    }
  };

  const accentBg = resolved['--home-accent-bg'];
  const accentInk = resolved['--home-accent-ink'];
  if (accentBg !== undefined && accentInk !== undefined) {
    push('accentInk', '主按钮文字 / 按钮背景', 'text', accentInk, accentBg);
  }

  for (const [slot, variable, pair] of [
    ['linkTitle', '--home-link-title', '网址标题 / 卡片底色'],
    ['linkMeta', '--home-link-meta', '网址说明／域名颜色 / 卡片底色'],
    ['categoryTitle', '--home-category-title', '分类标题 / 卡片底色'],
  ] as const) {
    const fg = resolved[variable];
    if (fg !== undefined) {
      push(slot, pair, 'text', fg, cardBackground);
    }
  }

  // The icon glyph against its own tile is a non-text affordance: 3:1 is the
  // reference, not 4.5:1. Demanding more would fail perfectly usable icons.
  const iconBg = resolved['--home-icon-bg'];
  const iconInk = resolved['--home-icon-ink'];
  if (iconBg !== undefined && iconInk !== undefined) {
    push('iconInk', '图标文字 / 图标底色', 'nonText', iconInk, iconBg);
  }

  return findings;
}

/**
 * Resolve every slot to the colour that will actually render.
 *
 * Starts from the automatic baseline the stylesheet would use, then lets the
 * draft's explicit choices win — and, crucially, recomputes an automatic
 * foreground against a **chosen** background, exactly as the home page does.
 *
 * `baseline` carries the resolved brand/theme tokens. Anything it cannot supply
 * (an unbranded site) falls back to the stylesheet's own light-theme values, which
 * is what the page would render for that case.
 */
export function resolveEffectiveHomeColors(
  draft: HomeThemeDraft,
  baseline: {
    accentBg: string;
    accentInk: string;
    iconBg: string;
    iconInk: string;
    linkTitle: string;
    linkMeta: string;
    categoryTitle: string;
  },
): Record<string, string> {
  const explicit = (key: HomeThemeColorKey): string | undefined => {
    const value = draft[key].trim();
    return isCompleteHexColor(value) ? value.toUpperCase() : undefined;
  };

  const accentBg = explicit('accentBg') ?? baseline.accentBg;
  const explicitInk = explicit('accentInk');
  // Same rule as T1: an automatic foreground follows the *chosen* background.
  const accentInk = explicitInk ?? (explicit('accentBg') !== undefined
    ? readableForeground(accentBg)
    : baseline.accentInk);

  const iconBg = explicit('iconBg') ?? baseline.iconBg;
  const explicitIconInk = explicit('iconInk');
  const iconInk = explicitIconInk ?? (explicit('iconBg') !== undefined
    ? readableForeground(iconBg)
    : baseline.iconInk);

  return {
    '--home-accent-bg': accentBg,
    '--home-accent-ink': accentInk,
    '--home-icon-bg': iconBg,
    '--home-icon-ink': iconInk,
    '--home-link-title': explicit('linkTitle') ?? baseline.linkTitle,
    '--home-link-meta': explicit('linkMeta') ?? baseline.linkMeta,
    '--home-category-title': explicit('categoryTitle') ?? baseline.categoryTitle,
  };
}

/**
 * Keep the foreground's hue and move it away from the background until it passes.
 *
 * Interpolates toward whichever of black/white contrasts more, so the suggestion
 * stays on the administrator's colour rather than jumping to a flat extreme.
 *
 * Returns `null` only when *neither* extreme reaches the threshold. That does
 * exist — a mid-tone background around `#757575` sits between the two, where
 * black gives ~4.4:1 and white ~4.5:1 — and reporting honestly is better than
 * handing back a colour that will still fail.
 */
export function suggestReadable(foreground: string, background: string, minimum = 4.5): string | null {
  const towardsBlack = '#000000';
  const towardsWhite = '#FFFFFF';
  const score = (candidate: string) => colorContrast(candidate, background);

  if (Math.max(score(towardsBlack), score(towardsWhite)) < minimum) {
    return null;
  }

  const target = score(towardsBlack) >= score(towardsWhite) ? towardsBlack : towardsWhite;
  const from = parseHex(foreground);
  const to = parseHex(target);
  if (from === null || to === null) {
    return null;
  }

  for (let step = 100; step >= 0; step -= 2) {
    const ratio = step / 100;
    const candidate = `#${[0, 1, 2]
      .map((i) => Math.round(from[i]! + (to[i]! - from[i]!) * ratio)
        .toString(16).padStart(2, '0'))
      .join('')}`.toUpperCase();
    if (colorContrast(candidate, background) >= minimum) {
      return candidate;
    }
  }
  return null;
}

function parseHex(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return null;
  }
  return [
    Number.parseInt(trimmed.slice(1, 3), 16),
    Number.parseInt(trimmed.slice(3, 5), 16),
    Number.parseInt(trimmed.slice(5, 7), 16),
  ];
}

/**
 * Resolve a draft into the exact custom properties the home page would receive.
 *
 * Reuses T1's `homeThemeOverrides()`, so the preview cannot drift from the real
 * page: the automatic foreground recomputation, the null-slot handling and the
 * verbatim pass-through of explicit colours are the same code the page runs.
 */
export function resolveDraftProperties(draft: HomeThemeDraft): Record<string, string> {
  return homeThemeOverrides(homeThemeDraftToConfig(draft));
}
/**
 * The gate attributes a draft implies, as DOM attribute pairs.
 *
 * Shared by the preview and the admin view (which mirrors them onto
 * `documentElement`) so both derive the same list from the same resolution — the
 * property that keeps the preview honest.
 */
export function homeThemeDraftGates(draft: HomeThemeDraft): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const gate of homeThemeOverrideGates(resolveDraftProperties(draft))) {
    attributes[`data-${gate.replace(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`)}`] = 'true';
  }
  return attributes;
}
