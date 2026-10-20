/**
 * Home-page colour override cascade guards.
 *
 * These assertions exist because the failure they guard is **silent**: an
 * override that loses on specificity does not error, it simply renders the
 * automatic colour, and nothing else in the suite notices. A browser check
 * caught exactly this during T1 — the override rules tied with the brand rules
 * at class-level 4 and therefore lost purely on source order.
 *
 * The assertions read the real stylesheet, so they fail the moment a selector
 * loses a step or the brand rules gain one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HOME_THEME_COLOR_VARIABLE_NAMES } from '../../src/client/branding-theme.js';
import {
  HOME_THEME_PRESETS,
  HOME_THEME_SHAPE_PROPERTIES,
  homeThemePresetShapeProperties,
} from '../../src/client/home-theme-presets.js';

const CSS = readFileSync(fileURLToPath(new URL('../../src/client/styles/main.css', import.meta.url)), 'utf8');

/**
 * The same file with comments stripped.
 *
 * Several guards here assert that a *selector shape* does not appear — "no
 * preset rule may be gated on `:root`". Matching against the raw file would let
 * the explanation in a comment satisfy the assertion, and a guard that can be
 * satisfied by prose is not a guard.
 */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Class-level specificity: ids and inline styles are not involved in these selectors. */
function classLevel(selector: string): number {
  const withoutPseudoElements = selector.replace(/::?[a-z-]+(\([^)]*\))?/g, (match) => (match.startsWith('::') ? '' : match));
  const withoutIds = withoutPseudoElements.replace(/#[\w-]+/g, '');
  return (withoutIds.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length;
}

/**
 * Every selector in the stylesheet whose rule block opens on the next lines.
 *
 * Parsed from the whole file rather than line by line: a selector list is often
 * written across several lines, so a line-based scan yields empty fragments.
 */
function selectorsStartingWith(prefix: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gm');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(CSS)) !== null) {
    const start = match.index;
    const open = CSS.indexOf('{', start);
    if (open < 0) continue;
    const prelude = CSS.slice(start, open).trim();
    if (prelude.includes('}')) continue; // a previous block ended first
    found.push(...splitSelectorList(prelude));
  }

  return found;
}

/**
 * Split a selector list on commas that are not inside `:is(...)`/`:where(...)`.
 *
 * A naive `split(',')` breaks `:is(.a, .b)` into two nonsense fragments, which
 * would under-count the real brand rule and make this guard assert against a
 * fabricated rival.
 */
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of prelude) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);

    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);

  return parts.map((part) => part.trim().replace(/\s+/g, ' ')).filter((part) => part.length > 0);
}

/**
 * Every **per-slot colour** override selector in the stylesheet.
 *
 * T1.1 replaced the single shared `data-home-overrides` flag with one attribute
 * per slot, so this matches the family `:root[data-home-…='true']` rather than
 * one exact attribute — a new slot must be covered automatically, not by
 * editing this test.
 *
 * T3 added a second gate in the same namespace, `data-home-preset`, which is a
 * *value* gate rather than a boolean slot gate. It is excluded here explicitly
 * and covered by its own assertions below: folding the two families together
 * would make the boolean-slot rules appear to carry preset ids.
 */
const OVERRIDE_SELECTORS = CSS.split('\n')
  .map((line, index) => ({ line: line.trim(), index }))
  .filter(({ line }) => line.startsWith(':root[data-home-') && !line.startsWith(':root[data-home-preset='))
  .flatMap(({ index }) => selectorsStartingAtLine(index));

/** Parse the selector prelude that opens the block starting at `lineIndex`. */
function selectorsStartingAtLine(lineIndex: number): string[] {
  const lines = CSS.split('\n');
  let prelude = lines[lineIndex]!.trim();
  let cursor = lineIndex;
  while (!prelude.includes('{') && cursor + 1 < lines.length) {
    cursor += 1;
    prelude += ' ' + lines[cursor]!.trim();
  }
  const open = prelude.indexOf('{');
  if (open < 0) return [];
  return splitSelectorList(prelude.slice(0, open));
}

const BRAND_SELECTORS = selectorsStartingWith(":root[data-brand-colors");

describe('home page colour override cascade', () => {
  it('defines exactly the seven home-only properties on .app--home', () => {
    const block = CSS.match(/\.app--home \{([^}]*)\}/)?.[1] ?? '';
    for (const name of HOME_THEME_COLOR_VARIABLE_NAMES) {
      expect(block, `${name} must have an automatic default`).toContain(`${name}:`);
    }
    // No shared token may be redefined here: that would leak into the admin.
    for (const shared of ['--brand-primary:', '--brand-on-primary:', '--text:', '--text-muted:']) {
      expect(block).not.toContain(shared);
    }
  });

  it('gates every override rule on its own per-slot attribute', () => {
    const selectors = OVERRIDE_SELECTORS;
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toMatch(/^:root\[data-home-[a-z-]+='true'\]/);
    }
    // The shared flag is the T1 defect: one flag switched every rule together and
    // re-declared untouched slots. Its absence must be asserted, not assumed.
    expect(OVERRIDE_SELECTORS.some((selector) => selector.includes('data-home-overrides'))).toBe(false);
  });

  it('never lets two slots share one gate', () => {
    // A shared gate is what let one override repaint another slot; requiring a
    // distinct attribute per slot keeps that impossible by construction.
    const gates = OVERRIDE_SELECTORS.map((selector) => selector.match(/^:root\[([a-z-]+)='true'\]/)?.[1]);
    for (const gate of gates) {
      expect(gate, `unparsable gate in ${String(gate)}`).toBeTruthy();
    }
    // A gate may legitimately appear more than once (resting + hover), but the
    // distinct set must cover every slot that consumes a property.
    const distinct = new Set(gates);
    expect(distinct.size).toBeGreaterThanOrEqual(7);
  });

  it('beats every competing brand rule on specificity, not on source order', () => {
    const overrides = OVERRIDE_SELECTORS;
    const brands = BRAND_SELECTORS;
    expect(overrides.length).toBeGreaterThan(0);
    expect(brands.length).toBeGreaterThan(0);

    for (const override of overrides) {
      const overrideScore = classLevel(override);
      const overrideIsHover = /:hover/.test(override);

      // Only rules in the *same interaction state* can compete: a `:hover` brand
      // rule can never override a resting override rule, and vice versa. Pairing
      // them across states would invent a rivalry that cannot happen.
      const rivals = brands.filter((brand) => {
        const brandTerminal = brand.replace(/:hover.*$/, '').replace(/:focus-visible.*$/, '').trim();
        const overrideTerminal = override.replace(/:hover.*$/, '').replace(/:focus-visible.*$/, '').trim();
        const sharesTarget = brandTerminal.endsWith(overrideTerminal.split(/\s+/).pop() ?? '')
          || overrideTerminal.endsWith(brandTerminal.split(/\s+/).pop() ?? '');
        return sharesTarget && /:hover/.test(brand) === overrideIsHover;
      });

      for (const rival of rivals) {
        expect(
          overrideScore,
          `"${override}" (${String(overrideScore)}) must outrank "${rival}" (${String(classLevel(rival))})`,
        ).toBeGreaterThan(classLevel(rival));
      }
    }
  });

  it('scopes every override to .app--home so the admin can never be reached', () => {
    for (const selector of OVERRIDE_SELECTORS) {
      expect(selector, `${selector} must be scoped to .app--home`).toContain('.app--home');
    }
  });

  it('keeps a hover rule for each accent slot so an explicit colour survives interaction', () => {
    // The brand hover rule scores 6 at class level, so the override hover rules
    // must exist for both the background and the foreground or an explicit choice
    // reverts to the automatic pair the moment the button is hovered.
    expect(CSS).toContain(":root[data-home-accent-bg='true'] .app.app--home .personal__button--primary:hover:not(:disabled)");
    expect(CSS).toContain(":root[data-home-accent-ink='true'] .app.app--home .personal__button--primary:hover:not(:disabled)");
    expect(CSS).toContain(":root[data-home-accent-bg='true'] .app.app--home .personal__button--primary:focus-visible");
    expect(CSS).toContain(":root[data-home-accent-ink='true'] .app.app--home .personal__button--primary:focus-visible");
  });

  it('does not recolour a third-party raster icon, only its container', () => {
    // The `img` rule may set a background, but must never set `color` on the
    // image itself: CSS cannot recolour bitmap pixels and pretending otherwise
    // would be a promise the platform cannot keep.
    const imgRule = CSS.match(/:root\[data-home-icon-bg='true'\][^{]*\.destination-icon img \{([^}]*)\}/)?.[1] ?? '';
    expect(imgRule).toContain('background-color');
    expect(imgRule).not.toMatch(/^\s*color:/m);
  });

  it('gates the icon glyph separately from the icon tile', () => {
    // Under a brand colour the automatic glyph is --brand-ink on a *transparent*
    // tile. A shared gate turned that into a filled --surface-muted tile, which
    // is the T1 partial-override defect; the two must stay independent.
    expect(CSS).toContain(":root[data-home-icon-ink='true'] .app.app--home .destination-icon {");
    expect(CSS).toContain(":root[data-home-icon-bg='true'] .app.app--home .destination-icon {");
    const inkRule = CSS.match(/:root\[data-home-icon-ink='true'\][^{]*\.destination-icon \{([^}]*)\}/)?.[1] ?? '';
    const bgRule = CSS.match(/:root\[data-home-icon-bg='true'\][^{]*\.destination-icon \{([^}]*)\}/)?.[1] ?? '';
    // Match whole declarations: a bare `color:` substring test would also match
    // inside `background-color:`.
    expect(inkRule).toMatch(/^\s*color:/m);
    expect(inkRule).not.toMatch(/^\s*background-color:/m);
    expect(bgRule).toMatch(/^\s*background-color:/m);
    expect(bgRule).not.toMatch(/^\s*color:/m);
  });
});

/*
 * ── Preset shape ────────────────────────────────────────────────────────────
 *
 * The failure mode here is the same silent one as above: a preset that declares a
 * custom property nothing reads renders exactly like no preset at all, and a
 * preset rule that loses on specificity is overridden by the plain `.app--home`
 * declaration without a word. Both are asserted structurally, against the real
 * stylesheet, so they fail the moment the CSS and the preset module drift apart.
 */
describe('home page preset shape', () => {
  const PRESET_RULE = /\.app\.app--home\[data-home-preset='([a-z-]+)'\](?:\[([^\]]+)\])? \{([^}]*)\}/g;

  /** Every preset rule in the file: id, the optional `[data-home-basis]` condition, body. */
  function presetRules(): { id: string; condition: string; body: string }[] {
    return Array.from(CSS.matchAll(PRESET_RULE), (match) => ({
      id: match[1]!,
      condition: match[2] ?? '',
      body: match[3]!,
    }));
  }

  it('covers every shipped preset and nothing else', () => {
    const ids = new Set(presetRules().map((rule) => rule.id));
    for (const preset of HOME_THEME_PRESETS) {
      expect(ids, `preset "${preset.id}" has no stylesheet rule`).toContain(preset.id);
    }
    // A rule for an id the module does not ship would be unreachable CSS that
    // nobody notices rotting.
    for (const id of ids) {
      expect(HOME_THEME_PRESETS.map((preset) => preset.id)).toContain(id);
    }
  });

  it('declares every shape property the preset module emits, with the same value', () => {
    for (const preset of HOME_THEME_PRESETS) {
      for (const basis of ['light', 'dark'] as const) {
        const rules = presetRules().filter((rule) => rule.id === preset.id);
        // The cascade a base actually sees: the unconditioned rule, plus the
        // `[data-home-basis='dark']` override when that is the base in question.
        // A preset whose two bases agree ships one rule, which is why this must
        // overlay rather than demand two.
        const applicable = [
          ...rules.filter((rule) => rule.condition === ''),
          ...(basis === 'dark' ? rules.filter((rule) => rule.condition.includes("'dark'")) : []),
        ];
        const declarations = new Map<string, string>();
        for (const rule of applicable) {
          for (const line of rule.body.split(';')) {
            const match = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/);
            if (match !== null) declarations.set(match[1]!, match[2]!);
          }
        }
        for (const [property, value] of Object.entries(homeThemePresetShapeProperties(preset, basis))) {
          expect(
            declarations.get(property),
            `${preset.id}/${basis} must declare ${property}: ${value}`,
          ).toBe(value);
        }
      }
    }
  });

  it('reads every shape property it writes — a write nobody reads is a no-op', () => {
    for (const name of Object.values(HOME_THEME_SHAPE_PROPERTIES)) {
      expect(CSS, `${name} is declared but never read`).toContain(`var(${name})`);
    }
  });

  it('keeps the preset-less defaults equal to the pre-T3 literals', () => {
    // AC5: a site with no preset must render exactly as before. These are the
    // values B2-Compact had inline on the panel and the link blocks.
    const block = CSS.match(/\.app--home \{([^}]*)\}/)?.[1] ?? '';
    expect(block).toContain('--home-panel-radius: 1rem;');
    expect(block).toContain('--home-block-radius: 0.55rem;');
    expect(block).toContain('--home-chip-radius: 0.6rem;');
    expect(block).toContain('--home-panel-shadow: none;');
  });

  it('scopes every preset rule to the home element and to the home basis', () => {
    // T3 gated on `:root[data-home-preset='…']`. T3.1 moved it onto the element
    // that is actually styled, because a root gate carrying the *saved* basis
    // outranked anything an unsaved draft could declare in the admin preview —
    // the preview showed the saved theme's shadow over the draft's colours.
    // A gate drifting back to `:root` would silently restore that defect.
    for (const rule of presetRules()) {
      expect(CSS).toContain(`.app.app--home[data-home-preset='${rule.id}']`);
    }
    expect(RULES, 'no preset rule may be gated on :root').not.toMatch(/:root\[data-home-preset/);

    // And the dark variants must key off the home basis, never `data-theme`:
    // `data-theme` also drives the admin, and a preview must not be able to pull
    // the whole backend onto another basis.
    const darkRules = presetRules().filter((rule) => rule.condition !== '');
    for (const rule of darkRules) {
      expect(rule.condition, `${rule.id} must gate on the home basis`).toContain('data-home-basis');
    }
    expect(RULES).not.toMatch(/data-home-preset='[a-z-]+'\]\[data-theme=/);
  });

  it('makes the two theme bases element-scoped so a preview can carry its own', () => {
    // Without this the preview resolves `--surface`, `--shadow-soft`,
    // `color-scheme` and the `--theme-*` fallbacks against the *saved* basis.
    expect(RULES).toMatch(/\[data-theme='light'\] \{/);
    expect(RULES).toMatch(/\[data-theme='dark'\] \{/);
    expect(RULES).not.toMatch(/:root\[data-theme=/);

    // The `--theme-*` snapshots must follow, or an unbranded draft still falls
    // back to the saved basis's text and border.
    expect(RULES).toMatch(/:root,\s*\[data-theme\] \{/);
  });

  it('never lets the preview re-declare the surface token mapping', () => {
    // T3 added a block re-declaring `--text` / `--border` on `.branding-home-preview`
    // as surface values. The preview element carries `.app`, which maps those same
    // tokens to the **page** values the real home panel uses; the extra block
    // overrode that and the miniature's panel border came out a different colour
    // than the real panel's — measured, not assumed.
    const block = CSS.match(/\.branding-home-preview \{([^}]*)\}/)?.[1] ?? '';
    for (const token of ['--text:', '--border:', '--border-input:', '--surface-raised:', '--brand-ink:']) {
      expect(block, `.branding-home-preview must not re-declare ${token}`).not.toContain(token);
    }
    // The miniature's link rows must, however, resolve surface tokens like real
    // link blocks do — they are the one place the page switches area.
    expect(RULES).toMatch(/\.app :is\([^)]*\.branding-home-preview__link\)/s);
  });

  it('restores the preview button opacity at every width', () => {
    // `.personal__button:disabled` halves opacity and T2 only undid it inside the
    // phone media query, so the desktop preview showed a ghosted button. The undo
    // must be unscoped, and must stay scoped to this one element so real business
    // buttons keep their disabled styling.
    const matches = RULES.match(/\.branding-home-preview__button:disabled \{[^}]*\}/g) ?? [];
    expect(matches, 'exactly one opacity reset').toHaveLength(1);
    expect(matches[0]).toMatch(/opacity: 1/);

    // And it must not sit inside an `@media` block. Brace depth at the rule's
    // position is exactly that question: an at-rule block is a `{ … }` pair, so
    // depth 0 means top level. `indexOf('@media')` would find the first media
    // query in the document, which has nothing to do with this rule.
    const at = RULES.indexOf('.branding-home-preview__button:disabled');
    let depth = 0;
    for (let i = 0; i < at; i += 1) {
      if (RULES[i] === '{') depth += 1;
      if (RULES[i] === '}') depth -= 1;
    }
    expect(depth, 'the rule must sit at the top level, not inside a media query').toBe(0);
  });

  it('consumes every shape variable only under .app--home', () => {
    // The scoping is what keeps a theme out of the admin, including its danger
    // styling. Checking it per consumption is stricter than checking the preset
    // rules alone, because a later edit could add a consumer outside the scope.
    const lines = CSS.split('\n');
    const shapeNames = Object.values(HOME_THEME_SHAPE_PROPERTIES);
    const consumed = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => shapeNames.some((name) => line.includes(`var(${name})`)));
    expect(consumed.length).toBeGreaterThan(0);

    /*
     * The one legitimate exception, named rather than pattern-matched away: the
     * admin preview panel. It reads the same variables so the miniature cannot
     * drift from the page, and it is safe because the *preview root* carries
     * `class="app app--home"` — asserted in `admin-branding-view.test.tsx`. A
     * second exception would mean a real scope leak, so this stays a list of one.
     */
    const ALLOWED_NON_HOME_SCOPE = ['.branding-home-preview'];

    for (const { line, index } of consumed) {
      if (line.startsWith('--home-')) continue; // a declaration, guarded above
      /*
       * Walk back to the brace that opened this block; everything after the
       * previous `}` is the selector prelude. Two details matter:
       *
       *  - the current line is truncated at the first `var(--home-…)`, because a
       *    one-line rule (`.x:hover { border-color: var(--home-…) }`) opens its
       *    brace on the *same* line as the consumption and would otherwise look
       *    like it had no selector at all;
       *  - a fixed line window instead of brace scanning would silently skip a
       *    long selector list — the same parsing mistake the file already
       *    documents for `selectorsStartingWith`.
       */
      const firstUse = shapeNames
        .map((name) => line.indexOf(`var(${name})`))
        .filter((at) => at >= 0)
        .sort((a, b) => a - b)[0];
      const head = firstUse === undefined
        ? lines.slice(0, index).join('\n')
        : lines.slice(0, index).concat([line.slice(0, firstUse)]).join('\n');
      const open = head.lastIndexOf('{');
      const prelude = (open < 0 ? '' : head.slice(head.lastIndexOf('}') + 1, open)).trim();
      if (ALLOWED_NON_HOME_SCOPE.some((scope) => prelude.startsWith(scope))) continue;
      expect(prelude, `"${line}" must be consumed under .app--home`).toContain('.app--home');
    }
  });

  it('never lets a preset declare a home colour slot', () => {
    // The seven slots are the administrator's; a preset that declared one would
    // silently outrank an explicit colour with a themed default.
    for (const name of HOME_THEME_COLOR_VARIABLE_NAMES) {
      for (const rule of presetRules()) {
        expect(rule.body, `${rule.id} must not declare ${name}`).not.toContain(`${name}:`);
      }
    }
  });
});