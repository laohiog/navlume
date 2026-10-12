/**
 * Pure helpers for the Quick Add flow.
 *
 * Quick Add exists so a logged-in user can save a URL without typing a title:
 * the URL is the primary input and the title is optional. These helpers supply a
 * best-effort display title and resolve the default target category.
 *
 * ## Not an authority
 *
 * Nothing here is a security or validation boundary. `suggestQuickAddTitle` does
 * a local, best-effort parse purely to fill a label; it performs **no** network
 * access and does not claim the URL is valid. The server remains the only URL
 * validation and normalization authority, and a link is only ever created through
 * the existing `POST /api/personal/links` contract.
 *
 * This deliberately does not reimplement the server's normalization rules. It
 * uses the same standard URL parser for a hostname, and anything it cannot parse
 * simply yields no suggestion — the server then rejects the URL on submit.
 */

/** `http://` / `https://` prefix, matched case-insensitively. */
const HTTP_ABSOLUTE = /^https?:\/\//i;

/**
 * Best-effort hostname for a URL the user typed or pasted.
 *
 * Returns `''` when no hostname can be derived. Input is trimmed, and a
 * scheme-less value is completed with `https://` for parsing only — the same
 * convenience the server applies — so `example.com/path` yields `example.com`.
 */
export function suggestQuickAddTitle(urlInput: string): string {
  const trimmed = urlInput.trim();

  if (trimmed.length === 0) {
    return '';
  }

  const candidate = HTTP_ABSOLUTE.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    return new URL(candidate).hostname;
  } catch {
    // Unparseable input: no suggestion. The server makes the real decision.
    return '';
  }
}

/**
 * Resolve the title to submit.
 *
 * A user-supplied title always wins; a blank one falls back to the hostname
 * suggestion. May return `''` when neither is available (for example a
 * non-HTTP scheme), in which case the server still rejects the URL and the UI
 * shows the URL error — which is more useful than silently doing nothing.
 */
export function resolveQuickAddTitle(titleInput: string, urlInput: string): string {
  const title = titleInput.trim();

  if (title.length > 0) {
    return title;
  }

  return suggestQuickAddTitle(urlInput);
}

/**
 * Choose the category a Quick Add should target by default.
 *
 * Prefers the user's `isDefault` category (normally `⭐ 我的常用`) and otherwise
 * falls back to the first category the server returned. Returns `null` when the
 * user has no categories at all, in which case Quick Add cannot be offered.
 *
 * The client never fabricates a default category: ownership and existence come
 * from the server payload.
 */
export function resolveQuickAddCategoryId(
  categories: readonly { id: number; isDefault: boolean }[],
): number | null {
  const preferred = categories.find((category) => category.isDefault);

  if (preferred !== undefined) {
    return preferred.id;
  }

  return categories.at(0)?.id ?? null;
}

/**
 * Whether a Quick Add submission should reset and close its form.
 *
 * Only a successful create may close the form. On any failure the form must stay
 * open with the user's input so an invalid URL can be corrected and retried; the
 * failure is reported separately as a safe message. Closing on failure would
 * silently discard what the user typed and force them to start over.
 *
 * Kept as a named predicate because this is the exact rule that regressed during
 * P4.1 development, and it is not observable from a static render.
 */
export function shouldCloseQuickAdd(status: string): boolean {
  return status === 'ok';
}

/**
 * Acceptable HTTP(S) schemes. Mirrors the server's allow-list.
 *
 * This is a *gate for pre-filling a form*, not a validation authority: it decides
 * whether pasted/clipboard text is worth offering in Quick Add, so an obviously
 * unusable paste does not open a confirmation that cannot be submitted. The
 * server still performs the real validation and normalization on confirm.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Any `scheme:` prefix. */
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** Any `scheme://` prefix, which is always an explicit scheme. */
const SCHEME_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Digits followed by the end of the string or a URL delimiter. */
const PORT_TAIL = /^[0-9]+(?:[/?#]|$)/;

/**
 * Whether `host:port` should be read as a hostname rather than as a scheme.
 *
 * Mirrors the server's `looksLikeHostWithPort` exactly, including the `//`
 * condition. The first three checks establish that the value *could* be a
 * `host:port`; the `//` check is what decides that it should not be treated as
 * one, because a bare `something:digits` prefix containing `//` is not a
 * scheme-less host:port at all.
 *
 * That last condition is only consulted while classifying a **bare scheme
 * prefix**. Absolute HTTP(S) URLs are handled by the earlier `scheme://` branch,
 * so `https://example.com:8080/?q=//x` is unaffected by this rule.
 *
 * Duplicating this classification keeps the pre-fill gate from offering a form
 * for a value the server will refuse.
 */
function looksLikeHostWithPort(input: string, hostPart: string, remainder: string): boolean {
  return hostPart.includes('.') && PORT_TAIL.test(remainder) && !input.includes('//');
}

/**
 * Whether any character is one the server forbids: code point `<= 0x20` or `0x7f`.
 *
 * Mirrors `hasForbiddenChars` in `src/server/url.ts`. This must be an explicit
 * code-point scan rather than a `\s` regex: `\s` misses C0 control characters
 * such as NUL and `\u001f`, which the server rejects.
 *
 * The raw text is checked (not the parsed form) because the URL parser
 * percent-encodes C0 controls inside a path instead of rejecting them, so a
 * trailing NUL in `https://example.com/path\u0000` would otherwise slip through.
 */
function hasForbiddenControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * Decide whether `text` is plausibly an HTTP(S) URL worth offering in Quick Add.
 *
 * Used by the clipboard and paste entry points. This is a **pre-fill gate**, not
 * the validation authority, but it must never be more permissive than the server:
 * whatever it returns is offered to the user and submittable, so it must be a
 * value the server would also accept.
 *
 * It rejects empty text, the server's forbidden control-character class, and
 * every explicit non-HTTP scheme — including the numeric-suffix forms such as
 * `javascript:80` that a naive `host:port` reading would let through.
 *
 * The classification above is necessary but not sufficient: a dotted host with a
 * numeric port is still not necessarily valid (`example.com:99999` exceeds the
 * port range). Acceptance is therefore decided by one final parse, using the same
 * standard URL parser the server uses, which rejects malformed and out-of-range
 * inputs. This is what makes the client/server invariant hold.
 *
 * Accepts scheme-less hosts (`example.com`, `example.com:8080/path`), matching the
 * server's completion behaviour and P4.1's title suggestion.
 *
 * Deliberately conservative: it does not scan arbitrary prose for embedded URLs,
 * so pasting a sentence does not unexpectedly open the form. It may reject values
 * the server would accept (for example a single-label intranet host); those remain
 * reachable by typing into the manual form.
 */
export function acceptQuickAddUrl(text: string): string | null {
  const trimmed = text.trim();

  if (trimmed.length === 0 || hasForbiddenControlChars(trimmed)) {
    return null;
  }

  const schemeMatch = trimmed.match(SCHEME_PREFIX);

  if (schemeMatch !== null) {
    if (SCHEME_AUTHORITY.test(trimmed)) {
      // An explicit `scheme://…` is HTTP(S) or nothing.
      const scheme = `${schemeMatch[1]?.toLowerCase() ?? ''}:`;

      if (!ALLOWED_SCHEMES.has(scheme)) {
        return null;
      }
    } else {
      // A bare `scheme:` is rejected unless it is really `host:port`.
      const hostPart = schemeMatch[1] ?? '';
      const remainder = trimmed.slice(schemeMatch[0].length);

      if (!looksLikeHostWithPort(trimmed, hostPart, remainder)) {
        return null;
      }
    }
  } else if (!suggestQuickAddTitle(trimmed).includes('.')) {
    // Scheme-less input must contain a dot. This keeps a pasted sentence or a bare
    // word from opening the form, while every realistic host qualifies. The final
    // parse below would reject these anyway; this check keeps the intent explicit.
    return null;
  }

  // Final compatibility check. Parse exactly as the server will: absolute HTTP(S)
  // URLs as-is, everything else completed with `https://`. A standard-URL-parser
  // failure (malformed input, out-of-range port) or a non-HTTP protocol rejects.
  const candidate = SCHEME_AUTHORITY.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol) || parsed.hostname.length === 0) {
    return null;
  }

  return trimmed;
}

/** The three ways the Quick Add form can be opened. */
export type QuickAddSource = 'manual' | 'clipboard' | 'paste';

/**
 * Initial state for the Quick Add form.
 *
 * All three P4.2 entry points converge on this single shape, which is what keeps
 * them from becoming three separate implementations.
 */
export interface QuickAddIntent {
  source: QuickAddSource;
  /** Pre-filled URL, or `''` for manual entry. */
  url: string;
  /** Preselected category, or `null` to fall back to the default category. */
  categoryId: number | null;
}

/**
 * How long to wait for a clipboard read before falling back to manual entry.
 *
 * A denied read normally rejects quickly, but browsers that surface a permission
 * prompt leave `readText()` pending until the user answers. Without a bound, an
 * unanswered prompt would leave the primary Add button doing nothing at all. The
 * wait is short enough to feel immediate and long enough for a fast granted read.
 */
const CLIPBOARD_TIMEOUT_MS = 1000;

/**
 * Read a usable URL from the clipboard for an explicit user action.
 *
 * Only ever called from a click handler, so the browser's user-activation
 * requirement is satisfied. Returns `null` for every failure mode — API absent,
 * permission denied, a prompt left unanswered, empty clipboard, or content that is
 * not an acceptable URL — because the caller's response is identical in all of
 * them: show the manual form. The underlying browser error is deliberately
 * discarded rather than surfaced, since `NotAllowedError` and friends mean
 * nothing to an ordinary user.
 *
 * The read is bounded by `CLIPBOARD_TIMEOUT_MS` so a stalled permission prompt
 * degrades into manual entry instead of an unresponsive button.
 *
 * The raw clipboard text is never logged, stored, or sent anywhere; only the
 * accepted URL string is returned and it goes straight into the form field.
 */
export async function readClipboardUrl(): Promise<string | null> {
  try {
    const clipboard = globalThis.navigator?.clipboard;

    if (clipboard === undefined || typeof clipboard.readText !== 'function') {
      return null;
    }

    const text = await Promise.race([
      clipboard.readText(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('clipboard read timed out'));
        }, CLIPBOARD_TIMEOUT_MS);
      }),
    ]);

    return acceptQuickAddUrl(text);
  } catch {
    // Denied, unanswered, or unavailable: degrade silently to manual entry.
    return null;
  }
}

/**
 * Whether a paste target is an editable control.
 *
 * Structural rather than `instanceof` so it works with any element-like object
 * and is unit-testable without a DOM. When this returns true the global paste
 * shortcut must stay out of the way and let the browser paste normally.
 */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') {
    return false;
  }

  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';

  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }

  return element.isContentEditable === true;
}
