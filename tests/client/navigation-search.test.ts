import { describe, expect, it } from 'vitest';

import {
  countMatchingLinks,
  filterCategoriesByQuery,
  linkMatchesQuery,
  normalizeSearchQuery,
  splitHighlight,
} from '../../src/client/navigation-search.js';

/** A personal-style link: has `normalizedUrl`, no `description`. */
interface PersonalLink {
  id: number;
  title: string;
  url: string;
  normalizedUrl: string;
}

/** A public-style link: has `description`, no `normalizedUrl`. */
interface PublicLink {
  id: number;
  title: string;
  url: string;
  description: string | null;
}

interface Category<Link> {
  id: number;
  name: string;
  links: Link[];
}

const PERSONAL: Category<PersonalLink>[] = [
  {
    id: 1,
    name: '⭐ 我的常用',
    links: [
      { id: 10, title: 'Supplier Portal', url: 'example.com:8080/path', normalizedUrl: 'https://example.com:8080/path' },
      { id: 11, title: '中文链接', url: 'https://cn.example.com', normalizedUrl: 'https://cn.example.com/' },
    ],
  },
  {
    id: 2,
    name: '采购',
    links: [
      { id: 20, title: 'Invoice System', url: 'https://invoice.example.org', normalizedUrl: 'https://invoice.example.org/' },
    ],
  },
];

const PUBLIC: Category<PublicLink>[] = [
  {
    id: 5,
    name: 'Example',
    links: [
      { id: 50, title: 'Example Domain', url: 'https://example.com', description: 'A sample link' },
      { id: 51, title: 'Docs', url: 'https://docs.example.net', description: null },
    ],
  },
];

describe('normalizeSearchQuery', () => {
  it('trims and lower-cases', () => {
    expect(normalizeSearchQuery('  ExAmPle  ')).toBe('example');
  });

  it('maps whitespace-only input to the empty query', () => {
    expect(normalizeSearchQuery('   ')).toBe('');
    expect(normalizeSearchQuery('\t\n')).toBe('');
  });
});

describe('linkMatchesQuery', () => {
  it('matches personal title, raw url, and normalizedUrl', () => {
    const link = PERSONAL[0]!.links[0]!;

    expect(linkMatchesQuery(link, 'supplier')).toBe(true);
    expect(linkMatchesQuery(link, 'example.com:8080')).toBe(true);
    // Only present on `normalizedUrl`, not on the raw `url`.
    expect(linkMatchesQuery(link, 'https://example.com')).toBe(true);
  });

  it('matches public title, url, and description', () => {
    const titled = PUBLIC[0]!.links[0]!;
    const described = PUBLIC[0]!.links[0]!;

    expect(linkMatchesQuery(titled, 'example domain')).toBe(true);
    expect(linkMatchesQuery(titled, 'docs.example')).toBe(false);
    expect(linkMatchesQuery(described, 'sample link')).toBe(true);
  });

  it('treats a null description as absent rather than as a match', () => {
    const noDescription = PUBLIC[0]!.links[1]!;

    expect(linkMatchesQuery(noDescription, 'null')).toBe(false);
    expect(linkMatchesQuery(noDescription, 'docs')).toBe(true);
  });

  it('matches CJK titles by substring', () => {
    const link = PERSONAL[0]!.links[1]!;

    expect(linkMatchesQuery(link, '中文')).toBe(true);
    expect(linkMatchesQuery(link, '链接')).toBe(true);
    expect(linkMatchesQuery(link, '英文')).toBe(false);
  });

  it('is case-insensitive through the public normalization path', () => {
    // `linkMatchesQuery` takes an already-normalized query by contract, so
    // case-insensitivity comes from `normalizeSearchQuery`.
    expect(linkMatchesQuery(PERSONAL[0]!.links[0]!, normalizeSearchQuery('SUPPLIER'))).toBe(true);
    expect(linkMatchesQuery(PERSONAL[0]!.links[0]!, normalizeSearchQuery('supplier'))).toBe(true);
  });

  it('matches everything for an empty query', () => {
    expect(linkMatchesQuery(PERSONAL[0]!.links[0]!, '')).toBe(true);
  });
});

describe('filterCategoriesByQuery', () => {
  it('returns the navigation unchanged for an empty query', () => {
    const result = filterCategoriesByQuery(PUBLIC, '');

    expect(result).toEqual(PUBLIC);
  });

  it('returns the navigation unchanged for a whitespace-only query', () => {
    expect(filterCategoriesByQuery(PUBLIC, '   ')).toEqual(PUBLIC);
  });

  it('keeps only matching links and drops categories with none', () => {
    const result = filterCategoriesByQuery(PUBLIC, 'sample link');

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Example');
    expect(result[0]?.links.map((link) => link.id)).toEqual([50]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterCategoriesByQuery(PUBLIC, 'zzzz-no-match')).toEqual([]);
  });

  it('preserves category and link order', () => {
    // Both personal categories match "example" via their URLs.
    const result = filterCategoriesByQuery(PERSONAL, 'example');

    expect(result.map((category) => category.name)).toEqual(['⭐ 我的常用', '采购']);
    expect(result[0]?.links.map((link) => link.id)).toEqual([10, 11]);
    expect(result[1]?.links.map((link) => link.id)).toEqual([20]);
  });

  it('does not mutate the source payload', () => {
    const snapshot = JSON.stringify(PERSONAL);

    filterCategoriesByQuery(PERSONAL, 'supplier');

    expect(JSON.stringify(PERSONAL)).toBe(snapshot);
  });

  it('does not return shared link array references for the filtered result', () => {
    const result = filterCategoriesByQuery(PUBLIC, 'sample link');

    expect(result[0]?.links).not.toBe(PUBLIC[0]?.links);
    // The source still holds both links; only the projection is filtered.
    expect(PUBLIC[0]?.links).toHaveLength(2);
  });

  it('filters each source independently so personal and public stay separate', () => {
    const personalResult = filterCategoriesByQuery(PERSONAL, 'example');
    const publicResult = filterCategoriesByQuery(PUBLIC, 'example');

    expect(personalResult).toHaveLength(2);
    expect(publicResult).toHaveLength(1);
    // A personal-only term yields nothing from the public payload, which is what
    // keeps guest search from ever surfacing personal content.
    expect(filterCategoriesByQuery(PUBLIC, 'supplier')).toEqual([]);
  });
});

describe('countMatchingLinks', () => {
  it('counts matches across both scopes', () => {
    expect(countMatchingLinks([PUBLIC, PERSONAL], 'example')).toBeGreaterThan(0);
    expect(countMatchingLinks([PUBLIC, PERSONAL], 'supplier')).toBe(1);
  });

  it('is zero for a non-matching query', () => {
    expect(countMatchingLinks([PUBLIC, PERSONAL], 'zzzz-no-match')).toBe(0);
  });

  it('is zero for an empty query so callers do not show a no-results state', () => {
    expect(countMatchingLinks([PUBLIC, PERSONAL], '')).toBe(0);
    expect(countMatchingLinks([PUBLIC, PERSONAL], '   ')).toBe(0);
  });

  it('counts only public links when only public data is supplied', () => {
    expect(countMatchingLinks([PUBLIC], 'supplier')).toBe(0);
    expect(countMatchingLinks([PUBLIC], 'example domain')).toBe(1);
  });
});

/**
 * T4.6 — the highlight projection.
 *
 * These assert only what the row renders. Filtering is covered above and must not
 * change: `splitHighlight` never decides whether a link is a result.
 */
describe('splitHighlight', () => {
  /** Rebuild the original text from the segments, ignoring the hit flags. */
  const joined = (segments: { text: string }[]) => segments.map((segment) => segment.text).join('');

  it('returns one untouched segment for an empty query', () => {
    expect(splitHighlight('Notion', '')).toEqual([{ text: 'Notion', hit: false }]);
    expect(splitHighlight('Notion', '   ')).toEqual([{ text: 'Notion', hit: false }]);
  });

  it('wraps only the matching run and keeps the rest intact', () => {
    expect(splitHighlight('Notion', 'no')).toEqual([
      { text: 'No', hit: true },
      { text: 'tion', hit: false },
    ]);
  });

  it('matches case-insensitively without changing the original case', () => {
    const segments = splitHighlight('Snowflake', 'SNO');
    expect(segments).toEqual([
      { text: 'Sno', hit: true },
      { text: 'wflake', hit: false },
    ]);
    expect(joined(segments)).toBe('Snowflake');
  });

  it('uses the same normalization as the filter, so " NO " marks what "no" marked', () => {
    expect(splitHighlight('Notion', ' NO ')).toEqual(splitHighlight('Notion', 'no'));
  });

  it('handles several matches in one field', () => {
    expect(splitHighlight('notion notion', 'no')).toEqual([
      { text: 'no', hit: true },
      { text: 'tion ', hit: false },
      { text: 'no', hit: true },
      { text: 'tion', hit: false },
    ]);
  });

  it('treats regular-expression characters as literal text', () => {
    expect(splitHighlight('a.b', '.')).toEqual([
      { text: 'a', hit: false },
      { text: '.', hit: true },
      { text: 'b', hit: false },
    ]);
    // A query of ".*" must not become a wildcard that marks everything.
    expect(splitHighlight('abc', '.*')).toEqual([{ text: 'abc', hit: false }]);
    expect(splitHighlight('a(b)c', '(')).toEqual([
      { text: 'a', hit: false },
      { text: '(', hit: true },
      { text: 'b)c', hit: false },
    ]);
  });

  it('handles CJK without splitting characters', () => {
    expect(splitHighlight('常用工具', '工具')).toEqual([
      { text: '常用', hit: false },
      { text: '工具', hit: true },
    ]);
  });

  it('returns something for a non-matching query and never loses text', () => {
    const segments = splitHighlight('Linear', 'zzz');
    expect(segments).toEqual([{ text: 'Linear', hit: false }]);
  });

  it('reconstructs long mixed text exactly at every query', () => {
    const text = '  AWS 控制台 · us-east-1.console.aws.amazon.com  ';
    for (const query of ['', 'aws', ' AWS ', 'console', 'zzz', '.', '·']) {
      expect(joined(splitHighlight(text, query))).toBe(text);
    }
  });

  it('returns no segments for empty text', () => {
    expect(splitHighlight('', 'no')).toEqual([]);
  });
});

/**
 * T4.6 review fix — the highlight must use the same case mapping as the filter.
 *
 * The filter is `field.toLowerCase().includes(query.toLowerCase())`. A
 * case-insensitive regular expression is *not* the same predicate: `/i/i` misses
 * `İ`, `/k/i` misses `K`, and `/ß/i` misses `ẞ`, while `toLowerCase()` matches all
 * three. These cases pin the projection to the filter's semantics.
 */
describe('splitHighlight — Unicode case mapping', () => {
  const joined = (segments: { text: string }[]) => segments.map((segment) => segment.text).join('');

  it.each<[string, string, string]>([
    ['İstanbul', 'i', 'İ'],
    ['İstanbul', 'İ', 'İ'],
    ['Kelvin', 'k', 'K'],
    ['ẞ', 'ß', 'ẞ'],
  ])('marks %s for query %s, which the filter also accepts', (text, query, expected) => {
    // The filter is the authority: it matched, so the field has to be marked.
    expect(linkMatchesQuery({ title: text, url: 'https://example.com' }, normalizeSearchQuery(query))).toBe(true);

    const segments = splitHighlight(text, query);
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual([expected]);
    expect(joined(segments)).toBe(text);
  });

  it('marks the whole original character when lower-casing expands it', () => {
    // `İ` lower-cases to `i` + a combining dot: one character, two code units.
    expect(splitHighlight('İstanbul', 'i')).toEqual([
      { text: 'İ', hit: true },
      { text: 'stanbul', hit: false },
    ]);
  });

  it('agrees with the filter when contextual casing changes the character instead', () => {
    // Greek final sigma: 'ΟΔΟΣ'.toLowerCase() is 'οδος', so 'σ' does not match.
    expect(linkMatchesQuery({ title: 'ΟΔΟΣ', url: 'https://example.com' }, normalizeSearchQuery('σ'))).toBe(false);
    expect(splitHighlight('ΟΔΟΣ', 'σ').some((segment) => segment.hit)).toBe(false);
  });

  it('keeps segments ordered, non-overlapping and gap-free across mixed text', () => {
    const text = 'İstanbul Kelvin ẞ Notion';

    for (const query of ['i', 'İ', 'k', 'ß', 'no', 'stanbul', ' ', 'zzz']) {
      const segments = splitHighlight(text, query);
      expect(joined(segments)).toBe(text);

      let offset = 0;
      for (const segment of segments) {
        expect(text.slice(offset, offset + segment.text.length)).toBe(segment.text);
        offset += segment.text.length;
      }
      expect(offset).toBe(text.length);
    }
  });

  it('still handles the plain ASCII case', () => {
    expect(splitHighlight('Notion', 'no')).toEqual([
      { text: 'No', hit: true },
      { text: 'tion', hit: false },
    ]);
  });
});
