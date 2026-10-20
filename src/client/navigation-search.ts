/**
 * Pure client-side search over navigation payloads.
 *
 * Search is a **view projection**: it filters data that is already loaded in the
 * page and never mutates it, fetches anything, or touches the server. There is no
 * `/api/search`, no database work, and no request per keystroke.
 *
 * Matching is deliberately simple and deterministic — trimmed, case-insensitive
 * substring matching with no token ranking or fuzzy logic — so results are
 * predictable for both ASCII and CJK titles.
 */

/** Minimal shape needed to search a link. Both personal and public links satisfy it. */
export interface SearchableLink {
  title: string;
  url: string;
  /** Public links only. */
  description?: string | null;
  /** Personal links only: the server-canonical URL. */
  normalizedUrl?: string;
}

/** Minimal shape needed to search a category. */
export interface SearchableCategory<Link> {
  links: Link[];
}

/**
 * Normalize a raw query for comparison.
 *
 * Only `trim` and lower-casing — no stemming, no accent folding, no tokenizing.
 */
export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Whether a link matches an already-normalized query.
 *
 * Searches the fields the product requires: title and URL for every link, plus
 * `description` for public links and `normalizedUrl` for personal links. An empty
 * normalized query matches everything, which is what makes "empty query => normal
 * navigation" fall out of the same code path.
 */
export function linkMatchesQuery(link: SearchableLink, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }

  const fields: Array<string | null | undefined> = [
    link.title,
    link.url,
    link.normalizedUrl,
    link.description,
  ];

  return fields.some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(normalizedQuery),
  );
}

/**
 * Filter categories to only the links matching `query`.
 *
 * Returns a new array of new category objects, so the source payload is never
 * mutated. Category order and link order are preserved exactly — matches are not
 * re-ranked — and categories left with no matching links are omitted.
 *
 * An empty or whitespace-only query returns the categories unchanged (as a copy),
 * so callers can use one code path for "searching" and "not searching".
 */
export function filterCategoriesByQuery<
  Category extends { links: readonly unknown[] },
  Link extends SearchableLink = Category['links'][number] & SearchableLink,
>(categories: readonly Category[], query: string): Category[] {
  const normalizedQuery = normalizeSearchQuery(query);

  if (normalizedQuery.length === 0) {
    return [...categories];
  }

  const filtered: Category[] = [];

  for (const category of categories) {
    const links = (category.links as readonly Link[]).filter((link) =>
      linkMatchesQuery(link, normalizedQuery),
    );

    if (links.length > 0) {
      filtered.push({ ...category, links });
    }
  }

  return filtered;
}

/** Count matching links across several category collections. */
export function countMatchingLinks(
  categoryGroups: readonly (readonly SearchableCategory<SearchableLink>[])[],
  query: string,
): number {
  const normalizedQuery = normalizeSearchQuery(query);

  if (normalizedQuery.length === 0) {
    return 0;
  }

  let total = 0;

  for (const categories of categoryGroups) {
    for (const category of categories) {
      for (const link of category.links) {
        if (linkMatchesQuery(link, normalizedQuery)) {
          total += 1;
        }
      }
    }
  }

  return total;
}

/** One run of text: either a literal match, or the text between matches. */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Where one original character lands in `text.toLowerCase()`.
 *
 * `from`/`to` are UTF-16 indices into the original text; `lowerFrom`/`lowerTo`
 * are indices into its lower-cased form. They differ because lower-casing is not
 * length-preserving: `İ` (U+0130) becomes `i` + a combining dot.
 */
interface LowerCaseRun {
  from: number;
  to: number;
  lowerFrom: number;
  lowerTo: number;
}

/**
 * Map every original character to its range in the lower-cased text.
 *
 * JavaScript applies only the non-locale case mappings, whose length effects are
 * per-character (the one unconditional expansion is U+0130), so summing the
 * per-character lengths reproduces the whole-string length. Only lengths are read
 * here; the string itself is still lower-cased as a whole, because that is
 * exactly what the filter does.
 */
function lowerCaseRuns(text: string): { runs: LowerCaseRun[]; lowered: string } {
  const runs: LowerCaseRun[] = [];
  let from = 0;
  let lowerFrom = 0;

  for (const character of text) {
    const to = from + character.length;
    const lowerTo = lowerFrom + character.toLowerCase().length;
    runs.push({ from, to, lowerFrom, lowerTo });
    from = to;
    lowerFrom = lowerTo;
  }

  return { runs, lowered: text.toLowerCase() };
}

/**
 * Split `text` into alternating plain and matching runs, for `<mark>` rendering.
 *
 * A **view projection only**: it never filters, ranks, or rewrites anything, and
 * concatenating the returned segments always reproduces `text` exactly.
 *
 * Matching runs on `text.toLowerCase()` — the exact expression `linkMatchesQuery`
 * uses — so "the filter kept this row" and "the field is marked" cannot disagree.
 * A case-insensitive regular expression over the original string cannot promise
 * that: `/i/i` does not match `İ`, and `/k/i` does not match `K`, while
 * `toLowerCase()` matches both. The price is that a hit index is only valid in
 * the lower-cased string, so it is mapped back through `lowerCaseRuns` and a mark
 * always covers whole original characters — a character that expands into two
 * lower-cased code points is highlighted in full rather than sliced in half.
 *
 * An empty (or whitespace-only) query yields a single non-matching segment, so
 * callers render highlighted and plain text through one code path and no stale
 * mark survives clearing the search.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const normalizedQuery = normalizeSearchQuery(query);

  if (text.length === 0) {
    return [];
  }

  if (normalizedQuery.length === 0) {
    return [{ text, hit: false }];
  }

  const { runs, lowered } = lowerCaseRuns(text);
  const segments: HighlightSegment[] = [];
  let lowerCursor = 0;
  let originalCursor = 0;
  let matched = false;

  while (lowerCursor < lowered.length) {
    const hitStart = lowered.indexOf(normalizedQuery, lowerCursor);

    if (hitStart < 0) {
      break;
    }

    const hitEnd = hitStart + normalizedQuery.length;

    // Every original character whose lower-cased range overlaps the hit.
    let firstRun = -1;
    let lastRun = -1;

    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];

      if (run.lowerTo <= hitStart) {
        continue;
      }
      if (run.lowerFrom >= hitEnd) {
        break;
      }
      if (firstRun < 0) {
        firstRun = index;
      }
      lastRun = index;
    }

    // A hit outside the table means the two lower-casings disagreed in length;
    // marking nothing is better than slicing the wrong characters.
    if (firstRun < 0) {
      break;
    }

    const start = runs[firstRun].from;
    const end = runs[lastRun].to;

    if (start > originalCursor) {
      segments.push({ text: text.slice(originalCursor, start), hit: false });
    }

    segments.push({ text: text.slice(start, end), hit: true });
    originalCursor = end;
    // Never re-scan text already covered by this mark, and step past the whole
    // lower-cased range of the last consumed character so hits cannot overlap.
    lowerCursor = Math.max(hitEnd, runs[lastRun].lowerTo);
    matched = true;
  }

  if (!matched) {
    return [{ text, hit: false }];
  }

  if (originalCursor < text.length) {
    segments.push({ text: text.slice(originalCursor), hit: false });
  }

  return segments;
}
