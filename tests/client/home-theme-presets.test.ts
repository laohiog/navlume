/**
 * Preset derivation and contract guards.
 *
 * Two things are protected here. First, the client preset list must stay
 * identical to the server's whitelist — the client is what *offers* the themes and
 * the server is what *accepts* them, so a mismatch would produce a card that
 * fails to save with no local explanation. Second, the numbers themselves: the
 * five themes have to be distinguishable (a set that only swaps hue is the exact
 * defect the v3 design called out) and the theme that claims accessibility has to
 * actually clear the threshold it names.
 */
import { describe, expect, it } from 'vitest';

import {
  HOME_THEME_PRESETS,
  HOME_THEME_SHAPE_PROPERTIES,
  findHomeThemePreset,
  homeThemePresetPalette,
  homeThemePresetShapeProperties,
  matchesHomeThemePresetPalette,
} from '../../src/client/home-theme-presets.js';
import { colorContrast } from '../../src/client/branding-theme.js';
// Imported across the client/server boundary deliberately, and only here: the
// server owns the authoritative whitelist, and the failure this guards is a
// disagreement between two lists that live in different files.
import { HOME_THEME_PRESET_IDS } from '../../src/server/home-theme-config.js';

const HEX = /^#[0-9A-F]{6}$/;

describe('home theme presets', () => {
  it('offers exactly the presets the server will accept', () => {
    expect(HOME_THEME_PRESETS.map((preset) => preset.id)).toEqual([...HOME_THEME_PRESET_IDS]);
  });

  it('defines both bases for every preset, with storable colours', () => {
    for (const preset of HOME_THEME_PRESETS) {
      for (const basis of ['light', 'dark'] as const) {
        const palette = preset.palette[basis];
        expect(palette, `${preset.id}/${basis}`).toBeDefined();
        // Upper case: the server canonicalises on write, and a preset that
        // disagreed with its own stored form would make the palette-equality
        // test below fail for a purely cosmetic reason.
        for (const [field, value] of Object.entries(palette)) {
          expect(value, `${preset.id}/${basis}.${field} = ${value}`).toMatch(HEX);
        }
      }
    }
  });

  it('is visually distinguishable, not just a different hue', () => {
    // The v3 design's §2.6 finding: three presets that changed colour but shared
    // every radius and had no shadow gave almost no perceptual difference. The
    // fix was form, so form has to vary.
    const radii = new Set(HOME_THEME_PRESETS.map((preset) => preset.shape.panelRadius));
    expect(radii.size, 'panel radii must differ between themes').toBeGreaterThanOrEqual(4);

    const shadows = new Set(HOME_THEME_PRESETS.map((preset) => preset.shape.panelShadow.light));
    expect(shadows.size, 'panel shadows must differ between themes').toBeGreaterThanOrEqual(2);

    // And the five must not collapse into one another on canvas either.
    const canvases = new Set(HOME_THEME_PRESETS.map((preset) => preset.palette.light.pageBackgroundColor));
    expect(canvases.size).toBe(HOME_THEME_PRESETS.length);
  });

  it('emits exactly the declared shape properties', () => {
    for (const preset of HOME_THEME_PRESETS) {
      for (const basis of ['light', 'dark'] as const) {
        expect(Object.keys(homeThemePresetShapeProperties(preset, basis)).sort())
          .toEqual(Object.values(HOME_THEME_SHAPE_PROPERTIES).sort());
      }
    }
  });

  it('recognises an untouched palette, case-insensitively', () => {
    const palette = homeThemePresetPalette('warm-paper', 'light');
    expect(palette).toBeDefined();
    expect(matchesHomeThemePresetPalette({
      primaryColor: palette!.primaryColor.toLowerCase(),
      pageBackgroundColor: ` ${palette!.pageBackgroundColor} `,
      surfaceColor: palette!.surfaceColor,
    }, 'warm-paper', 'light')).toBe(true);
  });

  it('does not recognise a palette once any one field differs', () => {
    const base = homeThemePresetPalette('warm-paper', 'light')!;
    for (const field of ['primaryColor', 'pageBackgroundColor', 'surfaceColor'] as const) {
      expect(
        matchesHomeThemePresetPalette({ ...base, [field]: '#123456' }, 'warm-paper', 'light'),
        `${field} must break the match`,
      ).toBe(false);
    }
    // The other base is a different palette and must not match either.
    expect(matchesHomeThemePresetPalette(base, 'warm-paper', 'dark')).toBe(false);
    expect(matchesHomeThemePresetPalette(base, undefined, 'light')).toBe(false);
  });

  it('returns nothing for an absent or unknown preset rather than guessing', () => {
    expect(findHomeThemePreset(undefined)).toBeUndefined();
    expect(homeThemePresetPalette(undefined, 'light')).toBeUndefined();
    // The 'forest mist' colours must not leak into a preset-less site.
    expect(homeThemePresetPalette(undefined, 'dark')).toBeUndefined();
  });

  it('keeps every primary button boundary at or above 3:1 against its own surface', () => {
    // The accent button is a UI component: WCAG 1.4.11 asks 3:1 of the visual
    // information needed to identify it, not 4.5:1.
    for (const preset of HOME_THEME_PRESETS) {
      for (const basis of ['light', 'dark'] as const) {
        const { primaryColor, surfaceColor } = preset.palette[basis];
        expect(
          colorContrast(primaryColor, surfaceColor),
          `${preset.id}/${basis} button vs surface`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  describe('high contrast', () => {
    const preset = findHomeThemePreset('high-contrast')!;

    it('draws its own panel border instead of inheriting the shared one', () => {
      // This is the point of the preset: its canvas and surface are identical, so
      // the border is the only thing identifying the panel.
      expect(preset.palette.light.pageBackgroundColor).toBe(preset.palette.light.surfaceColor);
      for (const basis of ['light', 'dark'] as const) {
        expect(preset.shape.panelBorder[basis]).not.toBe('var(--border)');
      }
    });

    it('actually reaches the 3:1 its name promises', () => {
      for (const basis of ['light', 'dark'] as const) {
        const border = preset.shape.panelBorder[basis];
        // The declaration is a literal on purpose: if it ever became a token
        // reference this guard could no longer measure it, which is exactly when
        // it would matter.
        expect(border, `${basis} border must be a literal`).toMatch(HEX);
        expect(
          colorContrast(border, preset.palette[basis].surfaceColor),
          `${basis} panel border vs surface`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  });

  it('leaves the seven advanced colour slots to the administrator', () => {
    // A preset that could declare one of these would outrank an explicit colour
    // with a themed default — the silent override AC4 forbids. The shape map is
    // the only thing a preset may contribute.
    const allowed = new Set<string>(Object.values(HOME_THEME_SHAPE_PROPERTIES));
    for (const preset of HOME_THEME_PRESETS) {
      for (const property of Object.keys(homeThemePresetShapeProperties(preset, 'light'))) {
        expect(allowed.has(property), `${preset.id} must not emit ${property}`).toBe(true);
      }
    }
  });
});
