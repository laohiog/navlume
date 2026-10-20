/**
 * Draft preview for the home-page theme.
 *
 * **Reuses the real cascade rather than reimplementing it.** Every T1 colour rule
 * is written as `:root[data-home-<slot>='true'] .app.app--home <target>`, and the
 * T3 shape rules as `.app.app--home[data-home-preset='…']`, so this preview only
 * has to do four things to inherit them verbatim:
 *
 *  1. render its container with `class="app app--home"`,
 *  2. carry the draft's preset and basis as attributes on that container,
 *  3. have the matching `data-home-*` colour attributes on the document element
 *     (`AdminBrandingView` mirrors those), and
 *  4. carry the draft's derived `--brand-*` values inline.
 *
 * The admin container carries `.app` but never `.app--home`, so step 1 is what
 * confines these rules to the preview — and steps 1–3 cannot leak onto admin
 * surfaces, because none of them match `.app.app--home`. That is why this file
 * contains no colour or geometry declarations of its own: a hand-written
 * approximation would be free to drift from production, which is the exact defect
 * being avoided.
 *
 * **The scope wrapper exists for the basis.** `data-theme` is declared on any
 * element carrying it (see `main.css`), so the wrapper gives the draft its own
 * light or dark token set — and hosts the `--theme-*` snapshots the `.app` remap
 * falls back to, which cannot live on the `.app` element itself without the two
 * rules referencing each other. Without it those tokens resolve against the
 * *saved* site basis, which is exactly what T3.1 measured.
 *
 * Preview only — it holds no state and writes nothing. Values reach the server
 * when the form is submitted, never from here.
 */

import type { CSSProperties } from 'react';

import {
  homeThemeDraftGates,
  resolveDraftProperties,
  type HomeThemeDraft,
} from './admin-home-theme-draft.js';
import {
  HOME_THEME_BASIS_ATTRIBUTE,
  HOME_THEME_PRESET_ATTRIBUTE,
  type ThemeBasis,
} from './home-theme-presets.js';
import type { HomeThemePresetId } from './api/admin-branding.js';

/** One representative link row: title, meta line, and a letter tile. */
const SAMPLE_LINKS = [
  { title: '团队文档', domain: 'docs.example.com', letter: 'D' },
  { title: '设计资源', domain: 'design.example.com', letter: 'D' },
  { title: '项目协作', domain: 'work.example.com', letter: 'P' },
];

/**
 * A miniature of the home page's link panel.
 *
 * Uses the page's real class names (`.link-card__title`, `.destination-icon`,
 * `.personal__button--primary`, `.category__title`) so the home stylesheet
 * applies unchanged — including the panel radius, the block radius, the panel
 * shadow and the primary button's chip radius, which now come from the preset
 * attributes set below. Only the content is fake.
 */
export function HomeThemePreview({
  draft,
  brandProperties,
  presetId,
  basis,
}: {
  draft: HomeThemeDraft;
  /**
   * The draft's derived `--brand-*` custom properties, from the same
   * `brandingThemeProperties()` the real page runs. Written inline because the
   * document element holds the *saved* values.
   */
  brandProperties: Record<string, string>;
  /** The draft's preset, or `undefined` while none is chosen. */
  presetId: HomeThemePresetId | undefined;
  /** The draft's basis. Never the saved one — that is the whole point. */
  basis: ThemeBasis;
}) {
  const attributes: Record<string, string> = {};
  if (presetId !== undefined) {
    attributes[HOME_THEME_PRESET_ATTRIBUTE] = presetId;
  }
  attributes[HOME_THEME_BASIS_ATTRIBUTE] = basis;

  return (
    <div className="branding-home-preview-scope" data-theme={basis}>
      <div
        className="branding-home-preview app app--home"
        data-preview="home-theme"
        {...homeThemeDraftGates(draft)}
        {...attributes}
        /*
         * Two families of inline values, both required for the same reason the
         * real page writes them inline on `.app--home`: `main.css` declares the
         * `--home-*` defaults on that same element, and the surrounding admin panel
         * resolves its own tokens on itself, so a value set anywhere else would be
         * shadowed or simply never seen. Resolving through
         * `resolveDraftProperties()` and `brandingThemeProperties()` — the same
         * functions the home page runs — is what makes the preview and the page
         * agree by construction (AC2).
         */
        style={{
          ...brandProperties,
          ...resolveDraftProperties(draft),
        } as CSSProperties}
      >
        <div className="branding-home-preview__panel">
          <span className="category__title branding-home-preview__heading">常用工具</span>
          <div className="branding-home-preview__links">
            {SAMPLE_LINKS.map((link) => (
              <span className="link-card__anchor branding-home-preview__link" key={link.title}>
                <span className="destination-icon">{link.letter}</span>
                <span className="branding-home-preview__text">
                  <strong className="link-card__title">{link.title}</strong>
                  <span className="destination-secondary">{link.domain}</span>
                </span>
              </span>
            ))}
          </div>
          <button
            className="personal__button personal__button--primary branding-home-preview__button"
            type="button"
            disabled
          >
            ＋ 添加网址
          </button>
        </div>
      </div>
    </div>
  );
}
