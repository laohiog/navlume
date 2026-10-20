import { describe, expect, it } from 'vitest';
import { FALLBACK_BRANDING } from '../../src/client/api/admin-branding.js';
import {
  BRANDING_THEME_PROPERTIES,
  HOME_THEME_COLOR_VARIABLE_NAMES,
  brandingThemeProperties,
  colorContrast,
  homeThemeOverrideGates,
  homeThemeOverrides,
} from '../../src/client/branding-theme.js';

describe('branding presentation derivation', () => {
  it('leaves every override absent for null light/dark branding', () => {
    expect(brandingThemeProperties(FALLBACK_BRANDING)).toEqual({});
    expect(brandingThemeProperties({ ...FALLBACK_BRANDING, defaultTheme: 'dark' })).toEqual({});
  });

  it('derives independently readable foregrounds on strongly different page/surface colors', () => {
    for (const [page, surface] of [['#061B27', '#FFF5E1'], ['#FFFFFF', '#102030'], ['#777777', '#808080']]) {
      const properties = brandingThemeProperties({ ...FALLBACK_BRANDING,
        primaryColor: '#FFFF00', pageBackgroundColor: page!, surfaceColor: surface! });
      for (const [area, background] of [['page', page], ['surface', surface]]) {
        for (const role of ['text', 'muted', 'subtle', 'ink', 'danger']) {
          expect(colorContrast(properties[`--brand-${area}-${role}`]!, background!)).toBeGreaterThanOrEqual(4.5);
        }
        expect(colorContrast(properties[`--brand-${area}-input-border`]!, background!)).toBeGreaterThanOrEqual(3);
        expect(colorContrast(properties[`--brand-${area}-text`]!, properties[`--brand-${area}-muted-fill`]!)).toBeGreaterThanOrEqual(4.5);
      }
      expect(colorContrast(properties['--brand-on-primary']!, '#FFFF00')).toBeGreaterThanOrEqual(4.5);
      expect(Object.keys(properties).every((key) => BRANDING_THEME_PROPERTIES.includes(key))).toBe(true);
    }
  });

  it('keeps the opposite default surface readable when only one area is customized', () => {
    const page = brandingThemeProperties({ ...FALLBACK_BRANDING, pageBackgroundColor: '#000000' });
    expect(page['--brand-page-text']).toBe('#FFFFFF');
    expect(page).not.toHaveProperty('--brand-surface-text');
    const surface = brandingThemeProperties({ ...FALLBACK_BRANDING, defaultTheme: 'dark', surfaceColor: '#FFFFFF' });
    expect(surface['--brand-surface-text']).toBe('#000000');
    expect(surface).not.toHaveProperty('--brand-page-text');
  });

  it('accepts only the managed public background path in the CSS image property', () => {
    const path = '/api/public/brand-assets/12345678-1234-1234-1234-123456789abc.webp';
    expect(brandingThemeProperties({ ...FALLBACK_BRANDING, backgroundImagePath: path }))
      .toHaveProperty('--brand-background-image', `url("${path}")`);
    expect(brandingThemeProperties({ ...FALLBACK_BRANDING, backgroundImagePath: path }, false)).toEqual({});
    for (const value of ['https://evil.example/x.png', 'url(x)', '/uploads/x.svg', `${path}"); color:red`]) {
      expect(brandingThemeProperties({ ...FALLBACK_BRANDING, backgroundImagePath: value }))
        .not.toHaveProperty('--brand-background-image');
    }
  });

  it('keeps headings readable over the brightest and darkest wallpaper pixels without label backings', () => {
    for (const page of ['#EAF0ED', '#16262C', '#777777', '#808080']) {
      const properties = brandingThemeProperties({ ...FALLBACK_BRANDING, pageBackgroundColor: page,
        backgroundImagePath: '/api/public/brand-assets/12345678-1234-1234-1234-123456789abc.jpg' });
      const opacity = Number.parseInt(properties['--brand-image-opacity']!, 10) / 100;
      for (const pixel of [0, 255]) {
        const background = '#' + [1, 3, 5].map((offset) => Math.round(
          Number.parseInt(page.slice(offset, offset + 2), 16) * opacity + pixel * (1 - opacity),
        ).toString(16).padStart(2, '0')).join('');
        for (const role of ['text', 'muted', 'subtle']) {
          expect(colorContrast(properties[`--brand-page-${role}`]!, background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('matches standard black/white contrast', () => {
    expect(colorContrast('#000000', '#FFFFFF')).toBeCloseTo(21);
    expect(colorContrast('#808080', '#808080')).toBe(1);
  });
});

describe('home page colour overrides', () => {
  const ALL = {
    accentBg: '#B45309',
    accentInk: '#FFF7ED',
    linkTitle: '#7C2D12',
    linkMeta: '#9A3412',
    iconInk: '#7C2D12',
    iconBg: '#FFEDD5',
    categoryTitle: '#431407',
  };

  it('emits nothing when there is no configuration, leaving the automatic defaults', () => {
    expect(homeThemeOverrides(null)).toEqual({});
    expect(homeThemeOverrides(undefined)).toEqual({});
    expect(homeThemeOverrides({ version: 1, overrides: {} })).toEqual({});
  });

  it('emits one property per explicitly chosen colour', () => {
    expect(homeThemeOverrides({ version: 1, overrides: ALL })).toEqual({
      '--home-accent-bg': '#B45309',
      '--home-accent-ink': '#FFF7ED',
      '--home-link-title': '#7C2D12',
      '--home-link-meta': '#9A3412',
      '--home-icon-ink': '#7C2D12',
      '--home-icon-bg': '#FFEDD5',
      '--home-category-title': '#431407',
    });
  });

  it('leaves unrelated slots untouched when one colour is chosen', () => {
    const properties = homeThemeOverrides({ version: 1, overrides: { accentBg: '#B45309' } });
    expect(properties['--home-accent-bg']).toBe('#B45309');
    // These must stay absent so their rules never switch on and the existing
    // theme/brand cascade keeps rendering them (T1.1 partial-override fix).
    expect(properties['--home-link-title']).toBeUndefined();
    expect(properties['--home-link-meta']).toBeUndefined();
    expect(properties['--home-icon-ink']).toBeUndefined();
    expect(properties['--home-icon-bg']).toBeUndefined();
    expect(properties['--home-category-title']).toBeUndefined();
  });

  it('treats an explicit null foreground as automatic and recomputes it', () => {
    // `null` means "use the automatic colour", so the background override makes
    // the foreground eligible for recomputation — this is exactly the
    // white-background/white-text defect T1.1 fixes.
    const properties = homeThemeOverrides({ version: 1, overrides: { accentBg: '#B45309', accentInk: null } });
    expect(properties['--home-accent-bg']).toBe('#B45309');
    expect(properties['--home-accent-ink']).toBe('#FFFFFF');
  });

  it('passes an explicit colour through verbatim rather than substituting black or white', () => {
    // A deliberately poor-contrast pair must survive, so the settings UI can
    // detect and warn about it. Silently "fixing" it here would hide the problem.
    const properties = homeThemeOverrides({ version: 1, overrides: { accentBg: '#FFE8CC', accentInk: '#FFF3E6' } });
    expect(properties['--home-accent-bg']).toBe('#FFE8CC');
    expect(properties['--home-accent-ink']).toBe('#FFF3E6');
    expect(colorContrast(properties['--home-accent-ink']!, properties['--home-accent-bg']!)).toBeLessThan(4.5);
  });

  it('only ever emits the seven declared home-only properties', () => {
    const properties = homeThemeOverrides({
      version: 1,
      overrides: { ...ALL, ...({ evil: '#000000' } as Record<string, string>) },
    });
    expect(Object.keys(properties).sort()).toEqual([...HOME_THEME_COLOR_VARIABLE_NAMES].sort());
    // No shared token may appear: that is what keeps the admin out of scope.
    for (const name of Object.keys(properties)) {
      expect(BRANDING_THEME_PROPERTIES).not.toContain(name);
      expect(name.startsWith('--home-')).toBe(true);
    }
  });
});

describe('home page automatic foreground follows the final background (T1.1)', () => {
  it('derives a readable accent foreground from an overriding light background', () => {
    const properties = homeThemeOverrides({ version: 1, overrides: { accentBg: '#FFFFFF' } });
    // White background must not inherit a white foreground.
    expect(properties['--home-accent-ink']).toBe('#000000');
    expect(colorContrast(properties['--home-accent-ink']!, properties['--home-accent-bg']!))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('derives a readable accent foreground from an overriding dark background', () => {
    const properties = homeThemeOverrides({ version: 1, overrides: { accentBg: '#0A1929' } });
    expect(properties['--home-accent-ink']).toBe('#FFFFFF');
    expect(colorContrast(properties['--home-accent-ink']!, properties['--home-accent-bg']!))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('never lets an automatic foreground end up invisible on its own background', () => {
    // Sweep the range rather than trusting two samples: whatever the background,
    // the automatic pairing must clear the 4.5:1 text threshold.
    for (const background of ['#000000', '#111827', '#FFFFFF', '#F5F5F5', '#B45309',
      '#0A1929', '#808080', '#FFFF00', '#F0D9A8', '#3D6B8C']) {
      const properties = homeThemeOverrides({ version: 1, overrides: { accentBg: background } });
      const ink = properties['--home-accent-ink']!;
      expect(
        colorContrast(ink, background),
        `${ink} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('applies the same pairing rule to the icon tile', () => {
    const light = homeThemeOverrides({ version: 1, overrides: { iconBg: '#FFFFFF' } });
    expect(light['--home-icon-ink']).toBe('#000000');

    const dark = homeThemeOverrides({ version: 1, overrides: { iconBg: '#101820' } });
    expect(dark['--home-icon-ink']).toBe('#FFFFFF');
  });

  it('keeps an explicitly chosen foreground verbatim, never recomputing it', () => {
    // The regression this guards: an explicit but low-contrast pair must survive
    // so the settings UI can detect and warn about it.
    const properties = homeThemeOverrides({
      version: 1,
      overrides: { accentBg: '#FFFFFF', accentInk: '#FFF3E6' },
    });
    expect(properties['--home-accent-ink']).toBe('#FFF3E6');
    expect(colorContrast('#FFF3E6', '#FFFFFF')).toBeLessThan(4.5);

    const icons = homeThemeOverrides({ version: 1, overrides: { iconBg: '#101820', iconInk: '#0B0B0B' } });
    expect(icons['--home-icon-ink']).toBe('#0B0B0B');
  });

  it('does not touch the automatic engine when nothing is overridden', () => {
    // A background-only override must not perturb any unrelated slot's absence.
    const properties = homeThemeOverrides({ version: 1, overrides: { linkTitle: '#7C2D12' } });
    expect(Object.keys(properties)).toEqual(['--home-link-title']);
  });
});

describe('per-slot gate activation (T1.1)', () => {
  it('activates only the slots that produced a value', () => {
    const gates = homeThemeOverrideGates(homeThemeOverrides({
      version: 1,
      overrides: { accentBg: '#B45309', linkMeta: '#9A3412' },
    }));
    expect(gates.sort()).toEqual(['homeAccentBg', 'homeAccentInk', 'homeLinkMeta'].sort());
  });

  it('activates nothing when there is no configuration', () => {
    expect(homeThemeOverrideGates(homeThemeOverrides(null))).toEqual([]);
    expect(homeThemeOverrideGates(homeThemeOverrides({ version: 1, overrides: {} }))).toEqual([]);
  });

  it('drops a gate once its override is removed', () => {
    const before = homeThemeOverrideGates(homeThemeOverrides({ version: 1, overrides: { iconBg: '#FFEDD5' } }));
    expect(before).toContain('homeIconBg');
    const after = homeThemeOverrideGates(homeThemeOverrides({ version: 1, overrides: { iconBg: null } }));
    expect(after).not.toContain('homeIconBg');
  });
});
