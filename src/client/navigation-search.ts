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
