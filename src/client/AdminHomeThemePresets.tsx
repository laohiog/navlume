/**
 * The five home-page theme preset cards.
 *
 * **What the thumbnail is, and is not.** It is a *legend*: three literal swatches
 * from `home-theme-presets.ts` (canvas, panel, accent) plus the preset's own
 * panel radius, shown once per base. It deliberately does **not** try to render a
 * miniature home page — a hand-built fake is exactly the kind of preview that
 * looks right in the admin and wrong on the site, and T1 already paid for that
 * lesson once. The thing that must agree with production is
 * `<HomeThemePreview>`, which inherits the real cascade; these cards only have
 * to be *identifiable* and honest about what will change.
 *
 * Presentational and stateless: the parent owns the draft, and clicking a card
 * only edits that draft. Nothing here writes to the server.
 */

import { HOME_THEME_PRESETS, type ThemeBasis } from './home-theme-presets.js';
import type { HomeThemePresetId } from './api/admin-branding.js';

/** One mini panel per base: canvas, the preset's panel radius, the accent. */
function BasisSwatch({
  basis,
  palette,
  panelRadius,
  active,
}: {
  basis: ThemeBasis;
  palette: { pageBackgroundColor: string; surfaceColor: string; primaryColor: string };
  panelRadius: string;
  /** The base the site is currently on — ringed so comparison is against it. */
  active: boolean;
}) {
  return (
    <span
      className="branding-preset-card__swatch"
      data-basis={basis}
      data-active={active ? 'true' : undefined}
      style={{ background: palette.pageBackgroundColor }}
      aria-hidden="true"
    >
      <span
        className="branding-preset-card__panel"
        style={{ background: palette.surfaceColor, borderRadius: panelRadius }}
      >
        <span className="branding-preset-card__accent" style={{ background: palette.primaryColor }} />
        <span className="branding-preset-card__line" style={{ background: palette.primaryColor }} />
      </span>
    </span>
  );
}

/** The preset card grid. `role="radiogroup"` + `role="radio"` keeps it one choice. */
export function HomeThemePresetCards({
  selected,
  disabled,
  basis,
  onSelect,
  onClear,
}: {
  /** The draft's current preset, or `undefined` for "no preset". */
  selected: HomeThemePresetId | undefined;
  disabled: boolean;
  /** The site's current base, so the matching swatch can be ringed. */
  basis: ThemeBasis;
  onSelect(id: HomeThemePresetId): void;
  onClear(): void;
}) {
  return (
    <div className="branding-presets" role="radiogroup" aria-label="首页主题预设">
      <p className="branding__asset-hint">
        主题预设会同时决定配色与形态（圆角、边框、阴影）。选择只修改当前草稿，点击下方「保存」后才对所有访客生效。
      </p>

      <div className="branding-presets__grid">
        {HOME_THEME_PRESETS.map((preset) => {
          const isSelected = selected === preset.id;
          return (
            <button
              className={`branding-preset-card${isSelected ? ' branding-preset-card--selected' : ''}`}
              type="button"
              role="radio"
              aria-checked={isSelected}
              key={preset.id}
              disabled={disabled}
              onClick={() => { onSelect(preset.id); }}
            >
              {/*
                Two swatches, one per base, so the choice is made with the whole
                theme in view rather than only the base that happens to be active.
                The radius is the same literal the stylesheet reads. The swatch
                matching the site's current base is ringed — comparing a card
                against the theme that is live right now is the common case.
              */}
              <span className="branding-preset-card__swatches" aria-hidden="true">
                <BasisSwatch
                  basis="light"
                  palette={preset.palette.light}
                  panelRadius={preset.shape.panelRadius}
                  active={basis === 'light'}
                />
                <BasisSwatch
                  basis="dark"
                  palette={preset.palette.dark}
                  panelRadius={preset.shape.panelRadius}
                  active={basis === 'dark'}
                />
              </span>
              <span className="branding-preset-card__head">
                <span className="branding-preset-card__name">{preset.name}</span>
                {/*
                  A radio dot, not colour alone: the selected card already carries
                  a border, a heavier weight and a text flag, and this is the one
                  signal that reads as "one choice" at a glance.
                */}
                <span className="branding-preset-card__dot" data-checked={isSelected ? 'true' : undefined} aria-hidden="true" />
              </span>
              <span className="branding-preset-card__note">{preset.positioning}</span>
              {isSelected ? <span className="branding-preset-card__flag">当前选择</span> : null}
            </button>
          );
        })}
      </div>

      {/*
        Dropping the preset is a real choice, not a reset: it returns the *form*
        to B2's shape while leaving the three colour fields exactly as they are.
        Without it an administrator who tried a theme could not get back to the
        original look without first memorising its colours.
      */}
      <div className="branding-presets__clear">
        <button
          className="branding__button"
          type="button"
          role="radio"
          aria-checked={selected === undefined}
          disabled={disabled}
          onClick={onClear}
        >
          不使用主题预设
        </button>
        <span className="branding__color-hint">
          取消预设只还原形态（圆角／边框／阴影），保留当前的品牌主色、页面背景色与面板色。
        </span>
      </div>
    </div>
  );
}
