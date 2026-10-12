import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acceptQuickAddUrl,
  isEditableTarget,
  readClipboardUrl,
  resolveQuickAddCategoryId,
  resolveQuickAddTitle,
  shouldCloseQuickAdd,
  suggestQuickAddTitle,
} from '../../src/client/quick-add.js';
// Test-only import of the server URL authority. Used to prove the client pre-fill
// gate is never more permissive than the server. Production browser code must not
// depend on server modules; this dependency exists solely in the test.
import { normalizeHttpUrl } from '../../src/server/url.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('suggestQuickAddTitle — hostname derivation', () => {
  it.each([
    ['https://example.com/path', 'example.com'],
    ['http://example.com/path', 'example.com'],
    ['https://example.com', 'example.com'],
    ['example.com/path', 'example.com'],
    ['example.com', 'example.com'],
    ['  example.com/path  ', 'example.com'],
    ['example.com:8080/path', 'example.com'],
    ['https://sub.example.co.uk/deep/path?q=1#frag', 'sub.example.co.uk'],
  ])('derives %s -> %s', (input, expected) => {
    expect(suggestQuickAddTitle(input)).toBe(expected);
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(suggestQuickAddTitle('')).toBe('');
    expect(suggestQuickAddTitle('   ')).toBe('');
  });

  it('returns an empty string when no hostname can be derived', () => {
    // Unparseable input yields no suggestion; the server makes the real call.
    expect(suggestQuickAddTitle('not a url at all')).toBe('');
    expect(suggestQuickAddTitle('http://')).toBe('');
  });

  /**
   * The suggestion carries no URL policy.
   *
   * A forbidden scheme is never *accepted* here — this helper has no authority.
   * `javascript:` and `data:` yield no suggestion because they do not parse as a
   * host. `file:///…` does parse to a hostname, so it yields `file`; that is only
   * a cosmetic placeholder, and the server rejects the URL on submit so no link
   * with that title is ever created.
   *
   * Deliberately not fixed by blocklisting schemes in the client: duplicating
   * server validation rules here would give two sources of URL truth.
   */
  it('never implies that a forbidden scheme is valid', () => {
    expect(suggestQuickAddTitle('javascript:alert(1)')).toBe('');
    expect(suggestQuickAddTitle('data:text/html,x')).toBe('');

    // Parses to a hostname, but the server rejects the URL — so this suggestion
    // never reaches stored data.
    expect(suggestQuickAddTitle('file:///etc/passwd')).toBe('file');
  });

  it('never returns a full URL, only a hostname', () => {
    for (const input of ['https://example.com/path', 'example.com/path', 'example.com:8080/x']) {
      const title = suggestQuickAddTitle(input);
      expect(title).not.toContain('://');
      expect(title).not.toContain('/');
    }
  });
});

describe('resolveQuickAddTitle — blank title falls back to hostname', () => {
  it('uses the hostname when the title is blank', () => {
    expect(resolveQuickAddTitle('', 'https://example.com/path')).toBe('example.com');
    expect(resolveQuickAddTitle('   ', 'example.com/path')).toBe('example.com');
  });

  it('prefers a user-supplied title', () => {
    expect(resolveQuickAddTitle('我的链接', 'https://example.com/path')).toBe('我的链接');
    expect(resolveQuickAddTitle('  Trimmed  ', 'example.com')).toBe('Trimmed');
  });

  it('returns an empty string when neither title nor hostname is available', () => {
    // An explicit forbidden scheme: no title, and the server will reject the URL.
    expect(resolveQuickAddTitle('', 'javascript:alert(1)')).toBe('');
  });
});

describe('suggestQuickAddTitle — no network access', () => {
  it('never calls fetch, even with a suspicious input', () => {
    const fetchStub = vi.fn(() => {
      throw new Error('network access is not allowed in quick-add helpers');
    });
    vi.stubGlobal('fetch', fetchStub);

    for (const input of ['https://example.com/path', 'example.com', 'javascript:alert(1)', '']) {
      suggestQuickAddTitle(input);
      resolveQuickAddTitle('', input);
    }

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('resolveQuickAddCategoryId', () => {
  it('prefers the default category', () => {
    expect(
      resolveQuickAddCategoryId([
        { id: 5, isDefault: false },
        { id: 1, isDefault: true },
        { id: 9, isDefault: false },
      ]),
    ).toBe(1);
  });

  it('falls back to the first category when no default is present', () => {
    expect(
      resolveQuickAddCategoryId([
        { id: 7, isDefault: false },
        { id: 8, isDefault: false },
      ]),
    ).toBe(7);
  });

  it('returns null when the user has no categories', () => {
    // The client never fabricates a default category; absence means no Quick Add.
    expect(resolveQuickAddCategoryId([])).toBeNull();
  });

  it('does not mutate the input array', () => {
    const categories = [
      { id: 5, isDefault: false },
      { id: 1, isDefault: true },
    ];
    const snapshot = JSON.stringify(categories);

    resolveQuickAddCategoryId(categories);

    expect(JSON.stringify(categories)).toBe(snapshot);
  });
});

describe('shouldCloseQuickAdd — form closes only on success', () => {
  it('closes after a successful create', () => {
    expect(shouldCloseQuickAdd('ok')).toBe(true);
  });

  it.each(['invalid', 'unauthenticated', 'notfound', 'conflict', 'error'])(
    'stays open after %s so the input can be corrected and retried',
    (status) => {
      expect(shouldCloseQuickAdd(status)).toBe(false);
    },
  );
});

describe('acceptQuickAddUrl — pre-fill gate', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'https://example.com/path?q=1#f',
    'example.com',
    'example.com/path',
    'example.com:8080',
    'example.com:8080/path',
    'HTTPS://EXAMPLE.COM',
  ])('accepts %s', (input) => {
    expect(acceptQuickAddUrl(input)).toBe(input);
  });

  it('trims surrounding whitespace', () => {
    expect(acceptQuickAddUrl('  example.com/path  ')).toBe('example.com/path');
  });

  it.each([
    ['javascript:alert(1)'],
    ['javascript:80'],
    ['javascript:1/alert(1)'],
    ['data:text/html,x'],
    ['data:1/text/html,x'],
    ['file:///etc/passwd'],
    ['file:80/etc/passwd'],
    ['ftp://example.com'],
    ['ftp:21/path'],
    ['mailto:a@example.com'],
    ['mailto:25/path'],
    ['vbscript:80'],
    ['custom:80/path'],
    ['httpx:80/path'],
    ['https://'],
    ['http://'],
    [''],
    ['   '],
    ['https://ex ample.com'],
  ])('rejects %s', (input) => {
    expect(acceptQuickAddUrl(input)).toBeNull();
  });

  /**
   * Regression (P4.2 TARGETED FIX #1): an out-of-range port is not a valid URL.
   * The old gate accepted these because it only checked "dotted host + digits".
   */
  it.each([['example.com:99999'], ['example.com:65536'], ['example.com:999999']])(
    'rejects out-of-range port %s',
    (input) => {
      expect(acceptQuickAddUrl(input)).toBeNull();
    },
  );

  /**
   * Regression (P4.2 TARGETED FIX #1): the server forbids code points `<= 0x20`
   * and `0x7f`. The old `\s` test missed C0 controls such as NUL and `\u001f`.
   *
   * Only characters that survive trimming are listed here. TAB/LF/CR/SPACE are
   * stripped by both the client and the server, so both accept the remainder —
   * that case is covered by the server-compatibility test below rather than by an
   * assertion of rejection.
   */
  it.each([
    ['https://example.com\u0000'],
    ['example.com\u001f'],
    ['example.com\u007f'],
    ['https://example.com\u0001'],
    ['example.com\u000e'],
  ])('rejects forbidden control character in %j', (input) => {
    expect(acceptQuickAddUrl(input)).toBeNull();
  });

  it('trims surrounding whitespace exactly as the server does', () => {
    // Both sides trim, so the gate returns the trimmed value and the server
    // accepts the original. Neither may reject the other's behaviour.
    for (const code of [0x09, 0x0a, 0x0d, 0x20]) {
      const input = `example.com${String.fromCharCode(code)}`;

      expect(acceptQuickAddUrl(input)).toBe('example.com');
      expect(normalizeHttpUrl(input)).not.toBeNull();
    }
  });

  it('still accepts an in-range port (boundary check)', () => {
    expect(acceptQuickAddUrl('example.com:65535')).toBe('example.com:65535');
    expect(acceptQuickAddUrl('example.com:8080')).toBe('example.com:8080');
  });

  /**
   * Regression (P4.2 TARGETED FIX #2): a bare `host:port` prefix containing `//`
   * must not be classified as a scheme-less host:port. The server has always
   * rejected these; the client helper was missing that condition.
   */
  it.each([
    ['example.com:8080//path'],
    ['example.com:80/a//b'],
    ['example.com:8080/?q=//x'],
    ['example.com:8080#//x'],
    ['example.com:8080//'],
    ['example.com:80//'],
  ])('rejects bare host:port containing // in %j', (input) => {
    expect(acceptQuickAddUrl(input)).toBeNull();
    expect(normalizeHttpUrl(input)).toBeNull();
  });

  /**
   * The `//` condition applies only to the bare `host:port` classification. An
   * absolute HTTP(S) URL legitimately contains `://`, so normal URL parsing must
   * still govern it — the fix must not become a global `//` ban.
   */
  it.each([
    ['https://example.com:8080/path'],
    ['https://example.com:8080/?q=//x'],
    ['https://example.com//path'],
    ['http://example.com:8080/a//b'],
  ])('still accepts absolute URL containing // in %j', (input) => {
    expect(acceptQuickAddUrl(input)).toBe(input);
    expect(normalizeHttpUrl(input)).not.toBeNull();
  });

  it('still accepts normal scheme-less host:port cases', () => {
    for (const input of ['example.com:8080', 'example.com:8080/path', 'example.com:65535/path']) {
      expect(acceptQuickAddUrl(input), input).toBe(input);
      expect(normalizeHttpUrl(input), input).not.toBeNull();
    }
  });

  it('rejects arbitrary prose so pasting a sentence does not open the form', () => {
    expect(acceptQuickAddUrl('this is just a sentence')).toBeNull();
    expect(acceptQuickAddUrl('hello')).toBeNull();
  });

  /**
   * The gate must never pre-fill a value the server will refuse.
   *
   * This asserts the real invariant against the **actual server validator**, not
   * a proxy: anything `acceptQuickAddUrl` returns must also be accepted by
   * `normalizeHttpUrl`. The previous version of this test only checked that a
   * hostname could be derived, which is why out-of-range ports and control
   * characters slipped through.
   *
   * The gate is allowed to be stricter than the server (those values stay
   * reachable through manual entry); it must never be more permissive.
   */
  it('never accepts a value the server validator would reject', () => {
    const samples = [
      // valid
      'https://example.com',
      'http://example.com',
      'https://example.com/path?q=1#f',
      'example.com',
      'example.com/path',
      'example.com:8080',
      'example.com:8080/path',
      'example.com:65535',
      // out-of-range / malformed ports — the confirmed defect
      'example.com:99999',
      'example.com:65536',
      'example.com:0',
      'example.com:abc',
      'example.com:',
      // control characters — the second confirmed defect
      'https://example.com\u0000',
      'example.com\u001f',
      'example.com\u007f',
      'https://example.com\u0001',
      // bare host:port containing `//` — the third confirmed defect
      'example.com:8080//path',
      'example.com:80/a//b',
      'example.com:8080/?q=//x',
      'example.com:8080#//x',
      // absolute URLs containing `//` must still be governed by URL parsing
      'https://example.com:8080/?q=//x',
      // forbidden schemes
      'javascript:alert(1)',
      'javascript:80',
      'data:1/text/html,x',
      'file:80/etc/passwd',
      'ftp:21/path',
      'custom:80/path',
      'httpx:80/path',
      // malformed / prose
      'https://',
      'http://',
      '',
      '   ',
      'https://ex ample.com',
      'this is a sentence',
      'hello',
    ];

    const accepted = samples.filter((sample) => acceptQuickAddUrl(sample) !== null);

    for (const sample of accepted) {
      // The real invariant, checked against the real authority.
      expect(normalizeHttpUrl(sample), `gate accepted ${JSON.stringify(sample)}`).not.toBeNull();
    }

    // Sanity: the corpus exercises both outcomes, so this is not vacuous.
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThan(samples.length);
  });

  /**
   * Deterministic exchange-matrix compatibility proof.
   *
   * Enumerates hosts × ports × tails and asserts the one-directional invariant
   * against the real server validator. This is the regression guard for
   * TARGETED FIX #2: the hand-picked corpus and the port sweep both missed the
   * `//` branch, whereas this matrix enumerates the tail shapes that expose it.
   *
   * Deliberately deterministic — no randomized fuzzing.
   */
  it('agrees with the server across a host/port/tail matrix', () => {
    const hosts = ['example.com', 'a.b', 'sub.example.com'];
    const ports = ['0', '80', '443', '8080', '65535', '65536', '99999'];
    const tails = ['', '/path', '//path', '/a//b', '?q=x', '?q=//x', '#x', '#//x', '/?q=//x'];

    const candidates = hosts.flatMap((host) =>
      ports.flatMap((port) => tails.map((tail) => `${host}:${port}${tail}`)),
    );

    expect(candidates).toHaveLength(hosts.length * ports.length * tails.length);

    let accepted = 0;
    for (const candidate of candidates) {
      if (acceptQuickAddUrl(candidate) !== null) {
        accepted += 1;
        expect(normalizeHttpUrl(candidate), `gate accepted ${JSON.stringify(candidate)}`).not.toBeNull();
      }
    }

    // Non-vacuity: the matrix must actually exercise acceptance.
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(candidates.length);
  });

  /**
   * Exhaustive port sweep: every port the gate accepts must be one the server
   * accepts too. This is the regression guard for the confirmed defect, which the
   * earlier proxy assertion could not catch.
   */
  it('agrees with the server across a port range sweep', () => {
    for (let port = 0; port <= 70000; port += 991) {
      const candidate = `example.com:${String(port)}`;

      if (acceptQuickAddUrl(candidate) !== null) {
        expect(normalizeHttpUrl(candidate), `gate accepted port ${String(port)}`).not.toBeNull();
      }
    }
  });

  /**
   * Control-character sweep across the server's forbidden class and the DEL
   * boundary, so a future change to `\s`-based checking cannot silently regress.
   */
  it('agrees with the server across control characters', () => {
    const codes = [
      ...Array.from({ length: 0x30 }, (_, code) => code), // 0x00–0x2f
      ...Array.from({ length: 3 }, (_, index) => 0x7d + index), // 0x7d–0x7f
    ];

    for (const code of codes) {
      const candidate = `example.com${String.fromCharCode(code)}`;

      if (acceptQuickAddUrl(candidate) !== null) {
        expect(normalizeHttpUrl(candidate), `gate accepted U+${code.toString(16)}`).not.toBeNull();
      }
    }
  });
});

describe('readClipboardUrl — explicit action only, safe fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an accepted URL from the clipboard', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { readText: () => Promise.resolve('https://example.com/path') },
    });

    await expect(readClipboardUrl()).resolves.toBe('https://example.com/path');
  });

  it('returns null for clipboard content that is not an acceptable URL', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { readText: () => Promise.resolve('javascript:alert(1)') },
    });

    await expect(readClipboardUrl()).resolves.toBeNull();
  });

  it('returns null when the clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    await expect(readClipboardUrl()).resolves.toBeNull();
  });

  it('returns null when the clipboard read is rejected (permission denied)', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      },
    });

    // The browser error must not escape; the caller falls back to manual entry.
    await expect(readClipboardUrl()).resolves.toBeNull();
  });

  it('does not throw when readText throws synchronously', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: () => {
          throw new Error('sync failure');
        },
      },
    });

    await expect(readClipboardUrl()).resolves.toBeNull();
  });

  it('returns null for empty clipboard content', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { readText: () => Promise.resolve('   ') },
    });

    await expect(readClipboardUrl()).resolves.toBeNull();
  });
});

describe('isEditableTarget — paste shortcut exclusion', () => {
  it.each([['INPUT'], ['TEXTAREA'], ['SELECT']])('treats %s as editable', (tagName) => {
    expect(isEditableTarget({ tagName })).toBe(true);
  });

  it('is case-insensitive about the tag name', () => {
    expect(isEditableTarget({ tagName: 'input' })).toBe(true);
  });

  it('treats a contenteditable element as editable', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it.each([[null], [undefined], ['string'], [42], [{}]])(
    'treats %s as not editable',
    (target) => {
      expect(isEditableTarget(target)).toBe(false);
    },
  );

  it('treats an ordinary element as not editable', () => {
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget({ tagName: 'BODY', isContentEditable: false })).toBe(false);
  });
});

describe('readClipboardUrl — a stalled permission prompt never blocks the form', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('falls back to null when readText never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      // Never resolves: simulates an unanswered permission prompt.
      clipboard: { readText: () => new Promise(() => {}) },
    });

    const pendingRead = readClipboardUrl();
    await vi.advanceTimersByTimeAsync(1500);

    await expect(pendingRead).resolves.toBeNull();
  });

  it('still returns a fast successful read well within the bound', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      clipboard: { readText: () => Promise.resolve('https://example.com') },
    });

    const pendingRead = readClipboardUrl();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pendingRead).resolves.toBe('https://example.com');
  });
});

describe('shouldCloseQuickAdd — shared by all three link forms', () => {
  /**
   * P4.3 reuses this predicate for the category-local create form and the inline
   * edit form, not just Quick Add. A duplicate is a 409/conflict, so all three
   * must keep their form open so the user can correct the URL.
   */
  it('keeps every form open on a duplicate conflict', () => {
    expect(shouldCloseQuickAdd('conflict')).toBe(false);
  });

  it('closes every form only on success', () => {
    expect(shouldCloseQuickAdd('ok')).toBe(true);
    for (const failure of ['conflict', 'invalid', 'unauthenticated', 'notfound', 'error']) {
      expect(shouldCloseQuickAdd(failure), failure).toBe(false);
    }
  });
});

describe('paste exclusion — the Search input is an editable control', () => {
  /**
   * P4.4 regression: Search is a plain `<input type="search">`, so the existing
   * generic editable-target rule must already keep the global paste Quick Add
   * shortcut out of the way. No Search-specific special case is needed — this test
   * pins that behaviour so a future change cannot silently special-case it.
   */
  it('classifies a search input as editable so the global shortcut ignores it', () => {
    expect(isEditableTarget({ tagName: 'INPUT', type: 'search' })).toBe(true);
  });

  it('classifies every text-entry control as editable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isEditableTarget({ tagName }), tagName).toBe(true);
    }
  });

  it('does not classify the surrounding container or body as editable', () => {
    // Pastes outside the field must still reach the global shortcut.
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isEditableTarget({ tagName: 'BODY' })).toBe(false);
  });
});
