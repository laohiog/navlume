import { describe, expect, it } from 'vitest';
import { FALLBACK_BRANDING } from '../../src/client/api/admin-branding.js';
import { BRANDING_THEME_PROPERTIES, brandingThemeProperties, colorContrast } from '../../src/client/branding-theme.js';

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
