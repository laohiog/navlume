/**
 * Server-side URL validation and normalization.
 *
 * Pure functions only: no network access, no DNS lookup, no metadata fetch.
 * This is deliberate — the product forbids the server from requesting
 * user-supplied URLs (SSRF), so a link's metadata is never resolved here.
 */

/** Schemes the MVP accepts. Everything else is rejected outright. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Absolute HTTP(S) URL with an authority: `http://…` / `https://…`. */
const HTTP_ABSOLUTE = /^https?:\/\//i;

/** Any `scheme://` prefix, used to reject non-HTTP schemes that carry an authority. */
const HAS_SCHEME_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** RFC 3986 scheme prefix: `scheme:`. */
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** A plausible port: digits only, ending the string or the next URL delimiter. */
const VALID_PORT_TAIL = /^[0-9]+(?:[/?#]|$)/;

/**
 * Characters that are never valid inside a URL: whitespace and control codes.
 *
 * Written as explicit code-point comparisons rather than a character class so the
 * intent is unambiguous and no control-character range appears in a regex.
 */
function hasForbiddenChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * True when `host:port` may be read as a hostname with a port rather than as a
 * scheme.
 *
 * Security rule: a numeric suffix alone must NOT turn a scheme into a host. The
 * host part therefore has to positively look like a DNS name — it must contain a
 * dot. That keeps `example.com:8080` working while every single-label scheme
 * (`javascript:80`, `data:1/x`, `file:80/…`, `ftp:21/…`, `custom:80/…`) is
 * treated as a scheme and rejected.
 *
 * The MVP deliberately does not accept exotic single-label intranet hosts with
 * ports (e.g. `localhost:8080`); safety wins over that convenience.
 */
function looksLikeHostWithPort(input: string, hostPart: string, remainder: string): boolean {
  return hostPart.includes('.') && VALID_PORT_TAIL.test(remainder) && !input.includes('//');
}

/**
 * Validate and normalize a user-supplied URL.
 *
 * Order of decisions (safety first):
 *  1. `http://` / `https://` absolute URLs are parsed directly.
 *  2. any other `scheme://…` is rejected;
 *  3. a bare `scheme:` prefix is rejected unless it is really `host:port`,
 *     which requires a dotted host (see `looksLikeHostWithPort`);
 *  4. anything else is a scheme-less host and is completed with `https://`.
 *
 * Normalization is intentionally conservative: trim, scheme/host normalization
 * via the standard URL parser, and fragment removal. Query parameters, path, and
 * port are preserved exactly — tracking parameters are never stripped, and an
 * `http://` URL is never silently upgraded to `https://`.
 */
export function normalizeHttpUrl(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed.length === 0 || hasForbiddenChars(trimmed)) {
    return null;
  }

  let candidate: string;

  if (HTTP_ABSOLUTE.test(trimmed)) {
    candidate = trimmed;
  } else if (HAS_SCHEME_AUTHORITY.test(trimmed)) {
    // e.g. `ftp://example.com`, `javascript://x` — an explicit non-HTTP scheme.
    return null;
  } else {
    const schemeMatch = trimmed.match(SCHEME_PREFIX);

    if (schemeMatch !== null) {
      const hostPart = schemeMatch[1] ?? '';
      const remainder = trimmed.slice(schemeMatch[0].length);

      if (!looksLikeHostWithPort(trimmed, hostPart, remainder)) {
        // Explicit non-HTTP scheme (`javascript:80`, `data:1/x`, `custom:80/path`).
        return null;
      }

      candidate = `https://${trimmed}`;
    } else {
      candidate = `https://${trimmed}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  // Final guard: the parsed protocol must still be HTTP(S).
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  if (parsed.hostname.length === 0) {
    return null;
  }

  parsed.hash = '';

  return parsed.toString();
}

/**
 * Validate a user-supplied URL and return both the stored original and the
 * server-generated canonical form.
 *
 * The original is preserved (trimmed) for display; `normalizedUrl` is what the
 * server derives and is never taken from client input. Because `normalizeHttpUrl`
 * rejects every non-HTTP scheme, the returned `url` can never carry one either.
 */
export function validateLinkUrl(input: string): { url: string; normalizedUrl: string } | null {
  const normalizedUrl = normalizeHttpUrl(input);

  if (normalizedUrl === null) {
    return null;
  }

  return { url: input.trim(), normalizedUrl };
}
