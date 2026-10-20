/**
 * Home-page theme configuration: the versioned, strictly whitelisted contract.
 *
 * This module is the **only** place that decides what a stored/requested home
 * theme document may contain. It lives beside the other server-side validators
 * because it shares their invariant: nothing an administrator types may ever
 * reach a CSS custom property unless it has been reduced to a known key and a
 * known value shape.
 *
 * Why a single JSON document rather than seven columns: the product has no
 * query, filter or report by colour, so SQL-queryability buys nothing, while
 * seven columns would multiply the schema, import/export and test surface for
 * every future appearance tweak. A whitelist keeps the same safety story as
 * seven validated scalars — an unknown key is rejected, never forwarded.
 *
 * What this is deliberately **not**: an arbitrary CSS property system. Keys are
 * a closed enum, values are `#RRGGBB` or `null`, and there is no place to put a
 * property name, a CSS expression, a script, or a URL.
 */

/** Current document version. Bump only when the meaning of a key changes. */
export const HOME_THEME_CONFIG_VERSION = 1;

/**
 * The seven independently overridable home-page colour slots.
 *
 * Names describe the *role*, not the CSS variable, so the storage contract does
 * not leak into presentation. Each maps to exactly one `--home-*` token in
 * `branding-theme.ts`.
 */
export const HOME_THEME_COLOR_KEYS = [
  'accentBg',
  'accentInk',
  'linkTitle',
  'linkMeta',
  'iconInk',
  'iconBg',
  'categoryTitle',
] as const;

export type HomeThemeColorKey = (typeof HOME_THEME_COLOR_KEYS)[number];

/**
 * Explicit per-slot overrides.
 *
 * `null` is a meaningful value, not "absent": it means "use the automatic
 * contrast-derived colour for this slot". A slot absent from the JSON behaves
 * identically, so a stored document may omit slots it has not overridden.
 */
export type HomeThemeOverrides = Partial<Record<HomeThemeColorKey, string | null>>;

/** The validated, storable shape. Unknown keys cannot survive parsing. */
export interface HomeThemeConfig {
  version: typeof HOME_THEME_CONFIG_VERSION;
  overrides: HomeThemeOverrides;
}

/** Whitelist of the theme presets this build can identify. */
export const HOME_THEME_PRESET_IDS = [
  'nordic-frost',
  'warm-paper',
  'deep-sea',
  'forest-mist',
  'high-contrast',
] as const;

export type HomeThemePresetId = (typeof HOME_THEME_PRESET_IDS)[number];

/**
 * Stored document: the validated config plus optional preset identity.
 *
 * `presetId` records which preset the administrator started from so the
 * appearance intent survives a round-trip; it never overrides an explicit
 * colour, because an explicit colour is always the more specific instruction.
 */
export interface StoredHomeThemeConfig extends HomeThemeConfig {
  presetId?: HomeThemePresetId;
}

/** Largest accepted serialized document. Generous for seven colours, tiny in absolute terms. */
export const HOME_THEME_CONFIG_MAX_BYTES = 2048;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one `#RRGGBB` colour without importing the branding validator.
 *
 * Duplicated rather than imported on purpose: `branding.ts` owns the persisted
 * branding row and importing it here would create a cycle, and this contract
 * must stay independently testable. The rule is identical — a strict six-digit
 * hex literal, which cannot carry `var()`, `url()`, `!important` or a CSS
 * expression.
 */
function requireHexColor(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    fail(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    fail(`${field} must be a #RRGGBB hex color`);
  }
  return `#${trimmed.slice(1).toUpperCase()}`;
}

/**
 * Validate an arbitrary unknown value into a `HomeThemeConfig`.
 *
 * Throws on: non-object input, a wrong/missing version, unknown keys, a
 * non-object `overrides`, an unknown colour key, or an illegal colour value.
 * Unknown keys are **rejected rather than dropped** — silently discarding them
 * would let an administrator believe a setting took effect when it did not.
 */
export function validateHomeThemeConfig(value: unknown): StoredHomeThemeConfig {
  if (!isRecord(value)) {
    fail('homeThemeConfig must be an object');
  }

  if (value['version'] !== HOME_THEME_CONFIG_VERSION) {
    fail(`homeThemeConfig.version must be ${String(HOME_THEME_CONFIG_VERSION)}`);
  }

  const known = new Set<string>(['version', 'presetId', 'overrides']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      fail(`homeThemeConfig contains unknown field "${key}"`);
    }
  }

  const rawPreset = value['presetId'];
  let presetId: HomeThemePresetId | undefined;
  if (rawPreset !== undefined && rawPreset !== null) {
    if (typeof rawPreset !== 'string' || !(HOME_THEME_PRESET_IDS as readonly string[]).includes(rawPreset)) {
      fail('homeThemeConfig.presetId is not a known theme preset');
    }
    presetId = rawPreset as HomeThemePresetId;
  }

  const rawOverrides = value['overrides'];
  if (!isRecord(rawOverrides)) {
    fail('homeThemeConfig.overrides must be an object');
  }

  const allowed = new Set<string>(HOME_THEME_COLOR_KEYS);
  const overrides: HomeThemeOverrides = {};
  for (const [key, entry] of Object.entries(rawOverrides)) {
    if (!allowed.has(key)) {
      fail(`homeThemeConfig.overrides contains unknown colour "${key}"`);
    }
    // `null` is the explicit "use the automatic colour" instruction and is kept.
    overrides[key as HomeThemeColorKey] = entry === null ? null : requireHexColor(entry, `homeThemeConfig.overrides.${key}`);
  }

  return presetId === undefined
    ? { version: HOME_THEME_CONFIG_VERSION, overrides }
    : { version: HOME_THEME_CONFIG_VERSION, presetId, overrides };
}

/**
 * Parse and validate a stored column value.
 *
 * `null`/`undefined` column contents mean "no explicit configuration" and yield
 * `null` — the backward-compatible state in which every slot is automatic.
 * A column that *is* present but malformed is an error rather than a silent
 * reset: silently discarding a stored document would quietly revert an
 * administrator's saved appearance without any signal.
 */
export function parseStoredHomeThemeConfig(raw: string | null | undefined): StoredHomeThemeConfig | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (raw.length > HOME_THEME_CONFIG_MAX_BYTES) {
    fail('homeThemeConfig is too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('homeThemeConfig must be valid JSON');
  }

  return validateHomeThemeConfig(parsed);
}

/** Serialize for storage, or `null` to clear the column entirely. */
export function serializeHomeThemeConfig(config: StoredHomeThemeConfig | null): string | null {
  if (config === null) {
    return null;
  }
  // Re-validate on the way out so an invalid document can never be persisted,
  // regardless of which code path assembled it.
  const validated = validateHomeThemeConfig(config);
  const serialized = JSON.stringify(validated);
  if (serialized.length > HOME_THEME_CONFIG_MAX_BYTES) {
    fail('homeThemeConfig is too large');
  }
  return serialized;
}