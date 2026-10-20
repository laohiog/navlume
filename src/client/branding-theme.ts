import type { HomeThemeConfig, HomeThemeColorKey, PublicBranding } from './api/admin-branding.js';

export const BRANDING_THEME_PROPERTIES = [
  '--brand-primary', '--brand-on-primary', '--brand-page-background', '--brand-surface',
  '--brand-background-image', '--brand-image-opacity', ...['page', 'surface'].flatMap((area) =>
    ['text', 'muted', 'subtle', 'border', 'input-border', 'muted-fill', 'ink', 'focus', 'danger']
      .map((role) => `--brand-${area}-${role}`)),
];

/**
 * Map each overridable home-page colour slot to its CSS custom property **and**
 * its per-slot gate attribute.
 *
 * These are **home-only**. They are declared on, and consumed by, `.app--home` —
 * never on `:root`/`.app` — so an explicit home-page colour can never reach the
 * admin surfaces, which keep using the shared `--brand-*` and `--text` tokens.
 *
 * The gate is per slot rather than one shared flag. A single flag switched on
 * every rule at once, so overriding one colour silently re-declared the other six
 * with their *defaults* — which in two cases differ from what the theme and
 * brand rules would otherwise have produced. Gating per slot means an untouched
 * slot emits no rule at all and keeps its existing cascade.
 */
const HOME_THEME_COLOR_SLOTS: Record<HomeThemeColorKey, { variable: string; gate: string }> = {
  accentBg: { variable: '--home-accent-bg', gate: 'homeAccentBg' },
  accentInk: { variable: '--home-accent-ink', gate: 'homeAccentInk' },
  linkTitle: { variable: '--home-link-title', gate: 'homeLinkTitle' },
  linkMeta: { variable: '--home-link-meta', gate: 'homeLinkMeta' },
  iconInk: { variable: '--home-icon-ink', gate: 'homeIconInk' },
  iconBg: { variable: '--home-icon-bg', gate: 'homeIconBg' },
  categoryTitle: { variable: '--home-category-title', gate: 'homeCategoryTitle' },
};

export const HOME_THEME_COLOR_VARIABLE_NAMES = Object.values(HOME_THEME_COLOR_SLOTS)
  .map((slot) => slot.variable);

/** The `data-*` dataset key that activates each slot's rule. */
export const HOME_THEME_GATE_NAMES = Object.values(HOME_THEME_COLOR_SLOTS)
  .map((slot) => slot.gate);

/**
 * Slots whose automatic foreground must be recomputed when the matching
 * background is explicitly overridden.
 *
 * Without this, setting only `accentBg` left `accentInk` pointing at
 * `--brand-on-primary` — a colour derived from the *brand* primary. On a white
 * custom background that produced white-on-white, because the automatic pairing
 * never saw the background that actually rendered.
 */
const FOREGROUND_SLOT_PAIRS = [
  { background: 'accentBg', foreground: 'accentInk' },
  { background: 'iconBg', foreground: 'iconInk' },
] as const satisfies readonly { background: HomeThemeColorKey; foreground: HomeThemeColorKey }[];

/**
 * Resolve explicit home-page colour overrides into CSS custom properties.
 *
 * Only slots the administrator actually chose produce a property; everything
 * else emits nothing and keeps its existing cascade untouched.
 *
 * A paired foreground is the one exception: when its background is overridden and
 * the foreground was left on automatic, the foreground is recomputed here from
 * the **overriding** background so the pair stays readable. An explicitly chosen
 * foreground is always emitted verbatim — never swapped for black or white — so
 * the settings UI can detect and warn about a poor choice.
 */
export function homeThemeOverrides(config: HomeThemeConfig | null | undefined): Record<string, string> {
  const properties: Record<string, string> = {};
  if (config === null || config === undefined) {
    return properties;
  }

  const overrides = config.overrides;
  const explicit: Partial<Record<HomeThemeColorKey, string>> = {};
  for (const [key, slot] of Object.entries(HOME_THEME_COLOR_SLOTS) as [HomeThemeColorKey, { variable: string; gate: string }][]) {
    const value = overrides[key];
    if (typeof value === 'string') {
      explicit[key] = value;
      properties[slot.variable] = value;
    }
  }

  for (const pair of FOREGROUND_SLOT_PAIRS) {
    const background = explicit[pair.background];
    const foreground = explicit[pair.foreground];
    // Only when the background was overridden *and* the foreground was not.
    if (background !== undefined && foreground === undefined) {
      properties[HOME_THEME_COLOR_SLOTS[pair.foreground].variable] = readableForeground(background);
    }
  }

  return properties;
}

/**
 * Which slots produced a property, as `data-*` attribute names.
 *
 * Consumed by `App.tsx` to activate exactly the rules that have a value. The
 * attributes are additive and always cleared first, so removing an override in a
 * later save turns its rule back off.
 */
export function homeThemeOverrideGates(properties: Record<string, string>): string[] {
  const present = new Set(Object.keys(properties));
  return Object.values(HOME_THEME_COLOR_SLOTS)
    .filter((slot) => present.has(slot.variable))
    .map((slot) => slot.gate);
}

/**
 * Pick a readable foreground for a background: whichever of black or white
 * contrasts more. Reuses the same rule the automatic derivation uses elsewhere,
 * so an automatic pairing here is indistinguishable from a derived one.
 */
export function readableForeground(background: string): string {
  return colorContrast('#FFFFFF', background) >= colorContrast('#000000', background)
    ? '#FFFFFF' : '#000000';
}

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as RGB;
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function colorContrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function foreground(background: string): string {
  return colorContrast('#FFFFFF', background) >= colorContrast('#000000', background)
    ? '#FFFFFF' : '#000000';
}

function mix(first: string, second: string, weight: number): string {
  const a = rgb(first);
  const b = rgb(second);
  return `#${a.map((value, index) => Math.round(value * weight + b[index]! * (1 - weight))
    .toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Keep secondary text readable even near the light/dark foreground threshold. */
function readableMix(text: string, background: string, weight: number, minimum: number): string {
  const mixed = mix(text, background, weight);
  return colorContrast(mixed, background) >= minimum ? mixed : text;
}

/** Only presentation derivation; validation and persistence remain server-owned. */
export function brandingThemeProperties(branding: PublicBranding, includeImage = true): Record<string, string> {
  const properties: Record<string, string> = {};
  const dark = branding.defaultTheme === 'dark';
  const primary = branding.primaryColor ?? (dark ? '#89C4A1' : '#285B47');
  if (branding.primaryColor !== null) properties['--brand-primary'] = primary;
  if (branding.primaryColor !== null || branding.pageBackgroundColor !== null || branding.surfaceColor !== null) {
    properties['--brand-on-primary'] = foreground(primary);
  }
  const path = branding.backgroundImagePath;
  const hasImage = includeImage && path !== null && /^\/api\/public\/brand-assets\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(path);
  const page = branding.pageBackgroundColor ?? (dark ? '#161C25' : '#F5F7FA');
  const pageText = foreground(page);
  // One ambient tint, with a small safety adjustment near the foreground threshold.
  // Test both extreme photo pixels rather than placing boxes behind every heading.
  let opacity = 0.9;
  while (opacity < 0.99 && ['#000000', '#FFFFFF'].some((pixel) => colorContrast(pageText, mix(page, pixel, opacity)) < 4.5)) {
    opacity += 0.01;
  }
  const areas = { page: branding.pageBackgroundColor ?? (hasImage ? page : null), surface: branding.surfaceColor };
  for (const [area, background] of Object.entries(areas)) {
    if (background === null) {
      if (branding.primaryColor !== null || branding.pageBackgroundColor !== null || branding.surfaceColor !== null) {
        const base = area === 'page' ? (dark ? '#161C25' : '#F5F7FA') : (dark ? '#202936' : '#FFFFFF');
        properties[`--brand-${area}-ink`] = colorContrast(primary, base) >= 4.5 ? primary : foreground(base);
      }
      continue;
    }
    properties[area === 'page' ? '--brand-page-background' : '--brand-surface'] = background;
    const text = foreground(background);
    properties[`--brand-${area}-text`] = text;
    for (const [role, weight] of [['muted', 0.75], ['subtle', 0.68]] as const) {
      const secondary = readableMix(text, background, weight, 4.5);
      properties[`--brand-${area}-${role}`] = area === 'page' && hasImage && ['#000000', '#FFFFFF']
        .some((pixel) => colorContrast(secondary, mix(page, pixel, opacity)) < 4.5) ? text : secondary;
    }
    properties[`--brand-${area}-border`] = mix(text, background, 0.22);
    properties[`--brand-${area}-input-border`] = readableMix(text, background, 0.55, 3);
    properties[`--brand-${area}-muted-fill`] = mix(text === '#FFFFFF' ? '#000000' : '#FFFFFF', background, 0.06);
    properties[`--brand-${area}-ink`] = colorContrast(primary, background) >= 4.5 ? primary : text;
    properties[`--brand-${area}-focus`] = colorContrast(primary, background) >= 3 ? primary : text;
    const danger = text === '#FFFFFF' ? '#FDA4AF' : '#9F1239';
    properties[`--brand-${area}-danger`] = colorContrast(danger, background) >= 4.5 ? danger : text;
  }
  // Consume only a managed PublicBranding path, never an arbitrary CSS/URL value.
  if (hasImage) {
    properties['--brand-background-image'] = `url("${path}")`;
    properties['--brand-image-opacity'] = `${Math.round(opacity * 100)}%`;
  }
  return properties;
}
