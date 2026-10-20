/**
 * The home-theme document contract.
 *
 * These cases are the security boundary: the document ends up reaching CSS custom
 * properties, so "what is allowed in" is asserted as tightly as the branding
 * colour validator asserts `#RRGGBB`. A future change that widens the accepted
 * shape must fail here first.
 */
import { describe, expect, it } from 'vitest';

import {
  HOME_THEME_COLOR_KEYS,
  HOME_THEME_CONFIG_MAX_BYTES,
  HOME_THEME_PRESET_IDS,
  parseStoredHomeThemeConfig,
  serializeHomeThemeConfig,
  validateHomeThemeConfig,
} from '../../src/server/home-theme-config.js';

describe('home theme config contract', () => {
  describe('accepts the intended shape', () => {
    it('accepts an empty override set', () => {
      expect(validateHomeThemeConfig({ version: 1, overrides: {} })).toEqual({
        version: 1,
        overrides: {},
      });
    });

    it('accepts every declared colour key', () => {
      const overrides: Record<string, string> = {};
      for (const key of HOME_THEME_COLOR_KEYS) {
        overrides[key] = '#123456';
      }
      expect(validateHomeThemeConfig({ version: 1, overrides })).toEqual({
        version: 1,
        overrides,
      });
    });

    it('keeps null as an explicit "use the automatic colour"', () => {
      expect(
        validateHomeThemeConfig({ version: 1, overrides: { accentBg: null, linkTitle: '#ABCDEF' } }),
      ).toEqual({ version: 1, overrides: { accentBg: null, linkTitle: '#ABCDEF' } });
    });

    it('canonicalises hex to upper case', () => {
      expect(validateHomeThemeConfig({ version: 1, overrides: { accentBg: '#aabbcc' } }).overrides)
        .toEqual({ accentBg: '#AABBCC' });
    });

    it('carries a known preset identity', () => {
      for (const presetId of HOME_THEME_PRESET_IDS) {
        expect(validateHomeThemeConfig({ version: 1, presetId, overrides: {} }).presetId).toBe(presetId);
      }
    });
  });

  describe('rejects anything that could reach CSS', () => {
    it('rejects a non-object document', () => {
      for (const value of [null, undefined, 42, 'x', [], true]) {
        expect(() => validateHomeThemeConfig(value)).toThrow(/must be an object/);
      }
    });

    it('rejects an unsupported version', () => {
      expect(() => validateHomeThemeConfig({ version: 2, overrides: {} })).toThrow(/version must be 1/);
      expect(() => validateHomeThemeConfig({ overrides: {} })).toThrow(/version must be 1/);
    });

    it('rejects an unknown top-level field rather than dropping it', () => {
      expect(() => validateHomeThemeConfig({ version: 1, overrides: {}, injected: 1 }))
        .toThrow(/unknown field "injected"/);
    });

    it('rejects an unknown colour key rather than dropping it', () => {
      expect(() => validateHomeThemeConfig({ version: 1, overrides: { evil: '#FFFFFF' } }))
        .toThrow(/unknown colour "evil"/);
    });

    it('rejects a non-hex colour', () => {
      for (const value of ['red', 'var(--x)', 'url(https://evil.test/x)', '#FFF', '#FFFFFF00', 'expression(alert(1))']) {
        expect(() => validateHomeThemeConfig({ version: 1, overrides: { accentBg: value } }))
          .toThrow(/must be a #RRGGBB hex color/);
      }
    });

    it('rejects a non-string colour', () => {
      expect(() => validateHomeThemeConfig({ version: 1, overrides: { accentBg: 123 } })).toThrow(/must be a string/);
    });

    it('rejects a non-object overrides container', () => {
      expect(() => validateHomeThemeConfig({ version: 1, overrides: '#FFFFFF' })).toThrow(/must be an object/);
      expect(() => validateHomeThemeConfig({ version: 1 })).toThrow(/must be an object/);
    });

    it('rejects an unknown preset id', () => {
      expect(() => validateHomeThemeConfig({ version: 1, presetId: 'my-own-theme', overrides: {} }))
        .toThrow(/not a known theme preset/);
    });

    it('rejects an over-large document', () => {
      const huge = JSON.stringify({ version: 1, overrides: { accentBg: '#FFFFFF' }, filler: 'x'.repeat(HOME_THEME_CONFIG_MAX_BYTES) });
      expect(() => parseStoredHomeThemeConfig(huge)).toThrow(/too large/);
    });
  });

  describe('stored column round trip', () => {
    it('treats a null or absent column as "no explicit configuration"', () => {
      expect(parseStoredHomeThemeConfig(null)).toBeNull();
      expect(parseStoredHomeThemeConfig(undefined)).toBeNull();
    });

    it('parses a stored document', () => {
      const stored = JSON.stringify({ version: 1, overrides: { linkTitle: '#112233' } });
      expect(parseStoredHomeThemeConfig(stored)).toEqual({
        version: 1,
        overrides: { linkTitle: '#112233' },
      });
    });

    it('surfaces malformed JSON instead of silently resetting', () => {
      expect(() => parseStoredHomeThemeConfig('{not json')).toThrow(/must be valid JSON/);
    });

    it('surfaces a stored document that violates the whitelist', () => {
      const stored = JSON.stringify({ version: 1, overrides: { color: 'red' } });
      expect(() => parseStoredHomeThemeConfig(stored)).toThrow(/unknown colour "color"/);
    });

    it('serialises null back to null so the column can be cleared', () => {
      expect(serializeHomeThemeConfig(null)).toBeNull();
    });

    it('round-trips a document unchanged', () => {
      const config = {
        version: 1 as const,
        presetId: 'deep-sea' as const,
        overrides: { accentBg: '#0A1929', accentInk: null, linkTitle: '#334455' },
      };
      expect(parseStoredHomeThemeConfig(serializeHomeThemeConfig(config))).toEqual(config);
    });

    it('re-validates on the way out so an invalid document is never persisted', () => {
      expect(() =>
        serializeHomeThemeConfig({ version: 1, overrides: { accentBg: 'red' } as never }),
      ).toThrow(/must be a #RRGGBB hex color/);
    });
  });
});