/**
 * The home-colour draft module.
 *
 * These cases pin the behaviour AC1/AC2/AC3 depend on: an untouched slot must
 * stay automatic, one slot must not disturb another, and the preview must
 * resolve through the same function the real page uses.
 */
import { describe, expect, it } from 'vitest';

import { colorContrast } from '../../src/client/branding-theme.js';

import {
  EMPTY_HOME_THEME_DRAFT,
  collectContrastFindings,
  homeThemeDraftFromConfig,
  homeThemeDraftToConfig,
  homeThemeDraftToPayload,
  isCompleteHexColor,
  isHomeThemeDraftCustomised,
  isHomeThemeDraftUnsaved,
  invalidHomeThemeSlots,
  resolveEffectiveHomeColors,
  resolveDraftProperties,
  suggestReadable,
} from '../../src/client/admin-home-theme-draft.js';

const LABELS = {
  accentBg: '主按钮背景色',
  accentInk: '主按钮文字色',
  linkTitle: '网址标题颜色',
  linkMeta: '网址说明／域名颜色',
  iconInk: '占位图标文字颜色',
  iconBg: '图标容器背景颜色',
  categoryTitle: '分类标题颜色',
};

describe('home theme draft', () => {
  describe('automatic is the default and stays automatic', () => {
    it('starts every slot empty', () => {
      expect(Object.values(EMPTY_HOME_THEME_DRAFT).every((value) => value === '')).toBe(true);
      expect(isHomeThemeDraftCustomised(EMPTY_HOME_THEME_DRAFT)).toBe(false);
    });

    it('reads a missing configuration as fully automatic', () => {
      expect(homeThemeDraftFromConfig(null)).toEqual(EMPTY_HOME_THEME_DRAFT);
      expect(homeThemeDraftFromConfig(undefined)).toEqual(EMPTY_HOME_THEME_DRAFT);
    });

    it('does not turn automatic slots into explicit colours', () => {
      const draft = { ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45309' };
      const overrides = homeThemeDraftToConfig(draft).overrides;
      // Automatic slots travel as `null`, which the T1 contract defines as "use
      // the automatic colour" — the renderer emits nothing for them, so this never
      // becomes an explicit override. What must never happen is a slot picking up
      // a concrete colour here: that would freeze today's automatic look the first
      // time anybody opened the editor.
      expect(overrides['accentBg']).toBe('#B45309');
      for (const key of Object.keys(EMPTY_HOME_THEME_DRAFT) as (keyof typeof EMPTY_HOME_THEME_DRAFT)[]) {
        if (key === 'accentBg') continue;
        expect(overrides[key], key).toBeNull();
      }
      // And the proof that they are inert: nothing resolves for them.
      const properties = resolveDraftProperties(draft);
      expect(Object.keys(properties)).toEqual(['--home-accent-bg', '--home-accent-ink']);
    });

    it('keeps the preset identity when every colour is returned to automatic', () => {
      // T2.1 Finding 2: clearing all colours used to return null, which deleted the
      // whole document and detached the site from its theme identity.
      expect(homeThemeDraftToPayload(EMPTY_HOME_THEME_DRAFT, 'forest-mist'))
        .toEqual({ version: 1, presetId: 'forest-mist', overrides: {} });
    });

    it('sends null only when there is neither a preset nor any override', () => {
      expect(homeThemeDraftToPayload(EMPTY_HOME_THEME_DRAFT, undefined)).toBeNull();
    });

    it('keeps the stored preset id when colours are edited', () => {
      const payload = homeThemeDraftToPayload(
        { ...EMPTY_HOME_THEME_DRAFT, linkTitle: '#7C2D12' },
        'deep-sea',
      );
      expect(payload?.presetId).toBe('deep-sea');
      expect(payload?.overrides.linkTitle).toBe('#7C2D12');
    });

    it('adopts only the explicit colours from a stored configuration', () => {
      expect(homeThemeDraftFromConfig({
        version: 1,
        presetId: 'warm-paper',
        overrides: { accentBg: '#B45309', accentInk: null },
      })).toEqual({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45309' });
    });
  });

  describe('slot independence (AC2)', () => {
    it('resolves one slot without disturbing the others', () => {
      const properties = resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, linkTitle: '#7C2D12' });
      expect(properties).toEqual({ '--home-link-title': '#7C2D12' });
      expect(properties['--home-link-meta']).toBeUndefined();
      expect(properties['--home-accent-bg']).toBeUndefined();
    });

    it('emits nothing at all for an automatic draft', () => {
      expect(resolveDraftProperties(EMPTY_HOME_THEME_DRAFT)).toEqual({});
    });

    it('resolves the icon tile and glyph independently', () => {
      const tileOnly = resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, iconBg: '#FFEDD5' });
      expect(tileOnly['--home-icon-bg']).toBe('#FFEDD5');
      expect(tileOnly['--home-icon-ink']).toBe('#000000'); // automatic pairing, not a repaint

      const glyphOnly = resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, iconInk: '#7C2D12' });
      expect(glyphOnly['--home-icon-ink']).toBe('#7C2D12');
      expect(glyphOnly['--home-icon-bg']).toBeUndefined();
    });
  });

  describe('automatic foreground follows the final background (AC3)', () => {
    it('recomputes the accent ink when only the background is chosen', () => {
      expect(resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#FFFFFF' })['--home-accent-ink'])
        .toBe('#000000');
      expect(resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#0A1929' })['--home-accent-ink'])
        .toBe('#FFFFFF');
    });

    it('keeps an explicit foreground verbatim', () => {
      const properties = resolveDraftProperties({
        ...EMPTY_HOME_THEME_DRAFT, accentBg: '#FFFFFF', accentInk: '#FFF3E6',
      });
      expect(properties['--home-accent-ink']).toBe('#FFF3E6');
    });
  });

  describe('input validation', () => {
    it('accepts only complete six-digit colours', () => {
      expect(isCompleteHexColor('#FFFFFF')).toBe(true);
      expect(isCompleteHexColor(' #ffffff ')).toBe(true);
      for (const partial of ['', '#', '#FFF', '#B45', 'red', '#FFFFFFFF', 'var(--x)']) {
        expect(isCompleteHexColor(partial), partial).toBe(false);
      }
    });
  });

  describe('contrast findings (AC5)', () => {
    it('reports nothing when every pairing passes', () => {
      const findings = collectContrastFindings(
        resolveDraftProperties({
          ...EMPTY_HOME_THEME_DRAFT,
          accentBg: '#0A1929', linkTitle: '#202B38', linkMeta: '#566374',
          iconBg: '#FFEDD5', categoryTitle: '#202B38',
        }),
        '#FFFFFF',
        LABELS,
      );
      expect(findings).toEqual([]);
    });

    it('names the failing pair and the threshold', () => {
      const findings = collectContrastFindings(
        resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#FFFFFF', accentInk: '#FFF3E6' }),
        '#FFFFFF',
        LABELS,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.pair).toBe('主按钮文字 / 按钮背景');
      // The finding is attributed to the slot whose text is at fault, so the
      // message points at the field the administrator can actually change.
      expect(findings[0]?.label).toBe('主按钮文字色');
      expect(findings[0]?.kind).toBe('text');
      expect(findings[0]?.minimum).toBe(4.5);
      expect(findings[0]?.ratio).toBeLessThan(4.5);
    });

    it('uses the non-text threshold for the icon glyph', () => {
      const findings = collectContrastFindings(
        resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, iconBg: '#FFFFFF', iconInk: '#F0F0F0' }),
        '#FFFFFF',
        LABELS,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe('nonText');
      expect(findings[0]?.minimum).toBe(3);
    });

    it('measures text against the card background', () => {
      // #EEEEEE on a dark card is 12.36:1 and would pass; on a pale card it is
      // unreadable. The same title therefore only fails when the card behind it
      // is light, which is exactly what this assertion pins.
      expect(collectContrastFindings({ '--home-link-title': '#EEEEEE' }, '#202B38', LABELS)).toEqual([]);
      const onPale = collectContrastFindings({ '--home-link-title': '#EEEEEE' }, '#FFFFFF', LABELS);
      expect(onPale).toHaveLength(1);
      expect(onPale[0]?.pair).toContain('卡片底色');
    });

    it('does not invent findings for automatic slots', () => {
      // Nothing overridden means nothing is asserted: the automatic engine is
      // responsible for those pairs and they are not the administrator's choice.
      expect(collectContrastFindings({}, '#FFFFFF', LABELS)).toEqual([]);
    });
  });

  describe('suggestion colour', () => {
    it('moves a foreground until it passes', () => {
      const suggestion = suggestReadable('#C8C8C8', '#5A5A5A');
      expect(suggestion).not.toBeNull();
      const ratio = colorContrast(suggestion!, '#5A5A5A');
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('honours a non-text threshold', () => {
      const suggestion = suggestReadable('#DDDDDD', '#666666', 3);
      expect(suggestion).not.toBeNull();
      expect(colorContrast(suggestion!, '#666666'))
        .toBeGreaterThanOrEqual(3);
    });

    it('returns null only when neither black nor white can pass', () => {
      // The interval where 4.5:1 is unreachable from both ends is genuinely
      // narrow: black clears it around #757575 and white just misses. Finding it
      // by search rather than hard-coding keeps this test honest if the maths ever
      // shifts.
      const impossible = ['#000000', '#101010', '#202020', '#303030', '#404040',
        '#505050', '#606060', '#6E6E6E', '#757575', '#787878', '#808080']
        .find((background) => colorContrast('#000000', background) < 4.5
          && colorContrast('#FFFFFF', background) < 4.5);

      if (impossible !== undefined) {
        expect(suggestReadable('#808080', impossible, 4.5)).toBeNull();
      } else {
        // No unreachable grey exists in this range: the walk toward the winning
        // extreme must then always find one.
        expect(suggestReadable('#808080', '#757575', 4.5)).not.toBeNull();
      }
    });
  });
});
/*
 * T2.1 regression tests.
 *
 * Each block names the defect it exists to prevent, so a future change that
 * reintroduces the behaviour fails here first.
 */

const BASELINE = {
  accentBg: '#285B47',
  accentInk: '#FFFFFF',
  iconBg: '#EEF2F6',
  iconInk: '#566374',
  linkTitle: '#202B38',
  linkMeta: '#566374',
  categoryTitle: '#202B38',
};

describe('T2.1 · an incomplete value must never trap the editor (Finding 1)', () => {
  it('lists exactly the slots that cannot be stored', () => {
    expect(invalidHomeThemeSlots({
      ...EMPTY_HOME_THEME_DRAFT,
      accentBg: '#B45',
      linkTitle: '#7C2D12',
      iconInk: 'red',
    })).toEqual(['accentBg', 'iconInk']);
  });

  it('treats an empty slot as valid, since empty means automatic', () => {
    expect(invalidHomeThemeSlots(EMPTY_HOME_THEME_DRAFT)).toEqual([]);
  });

  it('treats a half-typed value as invalid but still resolvable to automatic', () => {
    // The preview must not freeze on the broken entry; it simply ignores it.
    const properties = resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45' });
    expect(properties['--home-accent-bg']).toBeUndefined();
  });

  it('completing a partial value makes it storable', () => {
    const partial = { ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45' };
    expect(invalidHomeThemeSlots(partial)).toEqual(['accentBg']);
    const completed = { ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45309' };
    expect(invalidHomeThemeSlots(completed)).toEqual([]);
    expect(resolveDraftProperties(completed)['--home-accent-bg']).toBe('#B45309');
  });
});

describe('T2.1 · clearing colours must not drop the theme identity (Finding 2)', () => {
  it('preserves presetId through a full reset', () => {
    const stored = { version: 1 as const, presetId: 'deep-sea' as const,
      overrides: { accentBg: '#B45309' } };
    // Read the stored document, then reset every slot — the real user action.
    const payload = homeThemeDraftToPayload(EMPTY_HOME_THEME_DRAFT, stored.presetId);
    expect(payload?.presetId).toBe('deep-sea');
    expect(payload?.overrides).toEqual({});
    // And the round trip must read back as "customised: nothing, identity: kept".
    expect(isHomeThemeDraftCustomised(homeThemeDraftFromConfig(payload))).toBe(false);
  });

  it('keeps the identity when a preset existed even with no overrides stored', () => {
    expect(homeThemeDraftToPayload(EMPTY_HOME_THEME_DRAFT, 'forest-mist'))
      .toEqual({ version: 1, presetId: 'forest-mist', overrides: {} });
  });
});

describe('T2.1 · contrast must see automatic backgrounds too (Finding 3)', () => {
  it('flags an explicit button text colour against the automatic background', () => {
    // T2 passed only the override properties, so with an automatic background the
    // pair was silently skipped and this clashing choice produced no warning.
    // `#123456` on the automatic `#285B47` is 1.62:1 — genuinely unreadable.
    const effective = resolveEffectiveHomeColors({
      ...EMPTY_HOME_THEME_DRAFT,
      accentInk: '#123456',
    }, BASELINE);
    const findings = collectContrastFindings(effective, '#FFFFFF', LABELS);
    const buttonFinding = findings.find((f) => f.pair === '主按钮文字 / 按钮背景');
    expect(buttonFinding).toBeDefined();
    expect(buttonFinding?.slot).toBe('accentInk');
    expect(buttonFinding?.ratio).toBeLessThan(4.5);
  });

  it('stays silent when the explicit text is actually readable on the automatic background', () => {
    // The check must not become noise: a light cream on the dark automatic
    // background measures 7.18:1 and deserves no warning at all.
    const effective = resolveEffectiveHomeColors({
      ...EMPTY_HOME_THEME_DRAFT,
      accentInk: '#FFF3E6',
    }, BASELINE);
    expect(collectContrastFindings(effective, '#FFFFFF', LABELS)).toEqual([]);
  });

  it('flags an explicit icon glyph colour against the automatic tile', () => {
    const effective = resolveEffectiveHomeColors({
      ...EMPTY_HOME_THEME_DRAFT,
      iconInk: '#F0F0F0',
    }, BASELINE);
    const findings = collectContrastFindings(effective, '#FFFFFF', LABELS);
    const iconFinding = findings.find((f) => f.pair === '图标文字 / 图标底色');
    expect(iconFinding).toBeDefined();
    // Non-text affordance: 3:1, not the 4.5:1 used for prose.
    expect(iconFinding?.minimum).toBe(3);
  });

  it('recomputes an automatic foreground against a chosen background', () => {
    const effective = resolveEffectiveHomeColors({
      ...EMPTY_HOME_THEME_DRAFT,
      accentBg: '#FFFFFF',
    }, BASELINE);
    expect(effective['--home-accent-ink']).toBe('#000000');
  });

  it('never rewrites a colour the administrator chose', () => {
    const effective = resolveEffectiveHomeColors({
      ...EMPTY_HOME_THEME_DRAFT,
      accentBg: '#FFFFFF',
      accentInk: '#FFF3E6',
    }, BASELINE);
    expect(effective['--home-accent-ink']).toBe('#FFF3E6');
  });

  it('leaves automatic slots at the baseline when nothing is chosen', () => {
    const effective = resolveEffectiveHomeColors(EMPTY_HOME_THEME_DRAFT, BASELINE);
    expect(effective['--home-accent-bg']).toBe(BASELINE.accentBg);
    expect(effective['--home-accent-ink']).toBe(BASELINE.accentInk);
  });

  it('raises nothing when every pairing passes', () => {
    const effective = resolveEffectiveHomeColors(EMPTY_HOME_THEME_DRAFT, BASELINE);
    expect(collectContrastFindings(effective, '#FFFFFF', LABELS)).toEqual([]);
  });
});

describe('T2.1 · unsaved is not the same as customised (Finding 4)', () => {
  const saved = { version: 1 as const, overrides: { accentBg: '#B45309' } };

  it('reports a saved custom configuration as customised but not unsaved', () => {
    const draft = homeThemeDraftFromConfig(saved);
    expect(isHomeThemeDraftCustomised(draft)).toBe(true);
    expect(isHomeThemeDraftUnsaved(draft, saved)).toBe(false);
  });

  it('reports a change away from the saved value as unsaved', () => {
    const draft = homeThemeDraftFromConfig(saved);
    expect(isHomeThemeDraftUnsaved({ ...draft, linkTitle: '#7C2D12' }, saved)).toBe(true);
  });

  it('reports returning to the saved value as no longer unsaved', () => {
    const draft = { ...homeThemeDraftFromConfig(saved), linkTitle: '#7C2D12' };
    expect(isHomeThemeDraftUnsaved(draft, saved)).toBe(true);
    expect(isHomeThemeDraftUnsaved(homeThemeDraftFromConfig(saved), saved)).toBe(false);
  });

  it('treats an omitted key and a stored null as the same automatic state', () => {
    // Otherwise the notice would appear immediately on load for every site.
    expect(isHomeThemeDraftUnsaved(EMPTY_HOME_THEME_DRAFT, { version: 1, overrides: {} })).toBe(false);
    expect(isHomeThemeDraftUnsaved(EMPTY_HOME_THEME_DRAFT, { version: 1, overrides: { accentBg: null } })).toBe(false);
  });

  it('reports clearing a saved colour as unsaved', () => {
    expect(isHomeThemeDraftUnsaved(EMPTY_HOME_THEME_DRAFT, saved)).toBe(true);
  });

  it('counts a full reset that preserves a preset as unsaved', () => {
    // Clearing the colours is a real change even though the resulting document
    // holds no overrides: it also records that the preset survives.
    expect(isHomeThemeDraftUnsaved(EMPTY_HOME_THEME_DRAFT,
      { version: 1, presetId: 'deep-sea', overrides: { accentBg: '#B45309' } }, 'deep-sea')).toBe(true);
  });

  it('reports the same preset on both sides as no change', () => {
    expect(isHomeThemeDraftUnsaved(EMPTY_HOME_THEME_DRAFT,
      { version: 1, presetId: 'deep-sea', overrides: {} }, 'deep-sea')).toBe(false);
  });
});

/*
 * T2.2 — Finding 2: an unusable value is still something the administrator typed.
 *
 * `homeThemeDraftToConfig()` discards anything that is not a complete `#RRGGBB`,
 * which is right for rendering and storage but wrong for deciding "has this
 * draft diverged from what is saved?".
 */

describe('T2.2 · half-typed input still counts as unsaved (Finding 2)', () => {
  const presetSaved = { version: 1 as const, presetId: 'forest-mist' as const, overrides: {} };

  it('flags a partial value on an otherwise automatic slot', () => {
    // The exact reproduction from the review: preset saved, slot automatic, user
    // types "#B45". Converted, it is indistinguishable from "automatic".
    expect(isHomeThemeDraftUnsaved(
      { ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45' }, presetSaved, 'forest-mist',
    )).toBe(true);
  });

  it('flags every unusable shape, not just short hex', () => {
    for (const value of ['#B45', '#', 'red', '#GGG', '#FFFFFF00', '  #B4  ']) {
      expect(
        isHomeThemeDraftUnsaved({ ...EMPTY_HOME_THEME_DRAFT, linkTitle: value }, presetSaved, 'forest-mist'),
        value,
      ).toBe(true);
    }
  });

  it('still ignores formatting that cannot be stored', () => {
    // Case and surrounding whitespace never change what would be persisted, so
    // re-typing the same colour must not raise a false alarm.
    expect(isHomeThemeDraftUnsaved(
      { ...EMPTY_HOME_THEME_DRAFT, accentBg: '#b45309' },
      { version: 1, overrides: { accentBg: '#B45309' } },
    )).toBe(false);
    expect(isHomeThemeDraftUnsaved(
      { ...EMPTY_HOME_THEME_DRAFT, accentBg: '  #B45309  ' },
      { version: 1, overrides: { accentBg: '#B45309' } },
    )).toBe(false);
  });

  it('clears the warning once the input is restored to the saved state', () => {
    expect(isHomeThemeDraftUnsaved({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45' }, presetSaved, 'forest-mist'))
      .toBe(true);
    // Restored to automatic, which is what was saved.
    expect(isHomeThemeDraftUnsaved(EMPTY_HOME_THEME_DRAFT, presetSaved, 'forest-mist')).toBe(false);
    // Restored to a previously saved explicit colour.
    expect(isHomeThemeDraftUnsaved(
      { ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45309' },
      { version: 1, overrides: { accentBg: '#B45309' } },
    )).toBe(false);
  });

  it('does not let the unusable value into the renderable document', () => {
    // The conversion used for preview and storage stays strict: it never carries
    // a partial value forward, only the unsaved check reads raw input.
    expect(homeThemeDraftToConfig({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45' }).overrides.accentBg)
      .toBeNull();
    expect(resolveDraftProperties({ ...EMPTY_HOME_THEME_DRAFT, accentBg: '#B45' })['--home-accent-bg'])
      .toBeUndefined();
  });
});
