import { describe, expect, it } from 'vitest';

import {
  countMatchingLinks,
  filterCategoriesByQuery,
  linkMatchesQuery,
  normalizeSearchQuery,
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
