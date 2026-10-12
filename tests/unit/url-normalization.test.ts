import { describe, expect, it } from 'vitest';

import { normalizeHttpUrl, validateLinkUrl } from '../../src/server/url.js';

/**
 * URL validation/normalization is a pure function, so it is unit-tested directly.
 * The rules come from PRODUCT §10 and the P3.2 mutation boundary.
 */
describe('normalizeHttpUrl — accepted schemes', () => {
  it('accepts https and http unchanged in scheme', () => {
    expect(normalizeHttpUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it('does not silently upgrade http to https', () => {
    expect(normalizeHttpUrl('http://example.com/path')).toBe('http://example.com/path');
  });

  it('completes a scheme-less host to https', () => {
    expect(normalizeHttpUrl('example.com')).toBe('https://example.com/');
    expect(normalizeHttpUrl('example.com/path')).toBe('https://example.com/path');
  });

  it('treats a scheme-less host with a port as https', () => {
    expect(normalizeHttpUrl('example.com:8080')).toBe('https://example.com:8080/');
    expect(normalizeHttpUrl('example.com:8080/path')).toBe('https://example.com:8080/path');
  });

  it('is case-insensitive for the scheme', () => {
    expect(normalizeHttpUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });
});

describe('normalizeHttpUrl — rejected input', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['ftp:', 'ftp://example.com'],
    ['mailto:', 'mailto:a@example.com'],
    ['vbscript:', 'vbscript:msgbox(1)'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeHttpUrl(input)).toBeNull();
  });

  /**
   * Regression (S1): a digit after `scheme:` must not reclassify an explicit
   * scheme as `host:port`. Previously `javascript:80` became `https://javascript:80/`.
   */
  it.each([
    ['javascript:80'],
    ['javascript:1/alert(1)'],
    ['data:1/text/html,x'],
    ['data:1/text/html,<script>alert(1)</script>'],
    ['file:80/etc/passwd'],
    ['ftp:21/path'],
    ['mailto:25/path'],
    ['vbscript:80'],
    ['custom:80/path'],
    ['httpx:80/path'],
  ])('rejects numeric-suffix scheme %s (S1 regression)', (input) => {
    expect(normalizeHttpUrl(input)).toBeNull();
    expect(validateLinkUrl(input)).toBeNull();
  });

  it('rejects a non-HTTP scheme carrying an authority', () => {
    expect(normalizeHttpUrl('ftp://example.com')).toBeNull();
    expect(normalizeHttpUrl('javascript://example.com')).toBeNull();
    expect(normalizeHttpUrl('httpx://example.com')).toBeNull();
    expect(normalizeHttpUrl('custom://example.com')).toBeNull();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(normalizeHttpUrl('')).toBeNull();
    expect(normalizeHttpUrl('   ')).toBeNull();
    expect(normalizeHttpUrl('\t\n')).toBeNull();
  });

  it('rejects embedded whitespace and control characters', () => {
    expect(normalizeHttpUrl('https://exa mple.com')).toBeNull();
    expect(normalizeHttpUrl('https://example.com/\npath')).toBeNull();
  });

  it('rejects non-URL text', () => {
    expect(normalizeHttpUrl('not a url')).toBeNull();
    expect(normalizeHttpUrl('://missing')).toBeNull();
  });

  it('rejects a scheme that only looks similar to http', () => {
    expect(normalizeHttpUrl('httpx://example.com')).toBeNull();
    expect(normalizeHttpUrl('javascript://example.com')).toBeNull();
  });
});

describe('normalizeHttpUrl — normalization scope', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeHttpUrl('  https://example.com/x  ')).toBe('https://example.com/x');
  });

  it('lowercases the hostname but preserves path case', () => {
    expect(normalizeHttpUrl('https://EXAMPLE.com/Path')).toBe('https://example.com/Path');
  });

  it('removes the fragment', () => {
    expect(normalizeHttpUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('preserves query parameters exactly, including tracking parameters', () => {
    expect(normalizeHttpUrl('https://example.com/p?utm_source=x&q=2')).toBe(
      'https://example.com/p?utm_source=x&q=2',
    );
    expect(normalizeHttpUrl('https://example.com/a?b=1&C=2#sec')).toBe(
      'https://example.com/a?b=1&C=2',
    );
  });

  it('preserves path and explicit port', () => {
    expect(normalizeHttpUrl('http://example.com:8080/path?q=1#frag')).toBe(
      'http://example.com:8080/path?q=1',
    );
  });

  it('is idempotent for an already-normalized URL', () => {
    const once = normalizeHttpUrl('https://example.com/a?b=1#frag');
    expect(once).not.toBeNull();
    expect(normalizeHttpUrl(once as string)).toBe(once);
  });

  it('performs no network access (pure, synchronous, deterministic)', () => {
    // A host that cannot resolve still normalizes: no DNS or fetch occurs.
    expect(normalizeHttpUrl('https://this-host-does-not-exist.invalid/path')).toBe(
      'https://this-host-does-not-exist.invalid/path',
    );
  });
});

describe('validateLinkUrl', () => {
  it('returns the trimmed original plus the server-normalized form', () => {
    expect(validateLinkUrl('  example.com/x#frag  ')).toEqual({
      url: 'example.com/x#frag',
      normalizedUrl: 'https://example.com/x',
    });
  });

  it('returns null for rejected input', () => {
    expect(validateLinkUrl('javascript:alert(1)')).toBeNull();
  });
});
