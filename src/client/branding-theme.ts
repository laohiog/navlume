import type { PublicBranding } from './api/admin-branding.js';

export const BRANDING_THEME_PROPERTIES = [
  '--brand-primary', '--brand-on-primary', '--brand-page-background', '--brand-surface',
  '--brand-background-image', '--brand-image-opacity', ...['page', 'surface'].flatMap((area) =>
    ['text', 'muted', 'subtle', 'border', 'input-border', 'muted-fill', 'ink', 'focus', 'danger']
      .map((role) => `--brand-${area}-${role}`)),
];

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
