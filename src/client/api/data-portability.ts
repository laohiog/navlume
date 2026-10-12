/**
 * Client-side access to the JSON data portability API (P6.1).
 *
 * Mirrors `src/server/data-portability.ts`. Declared locally on purpose: the
 * client must not import server modules.
 *
 * Flow the UI must follow: **export → (edit elsewhere) → validate/preview →
 * explicit confirm → apply**. `preview` is read-only; only `apply` writes, and
 * the server additionally requires `confirm: true` in the body, so a UI mistake
 * cannot turn a preview into a destructive write.
 *
 * Authorization is entirely server-side. This module never sends an identity
 * field — only the session cookie, which the server resolves itself.
 */

/** The document version this build produces and accepts. */
export const PORTABLE_SCHEMA_VERSION = 1;

export const SITE_EXPORT_ENDPOINT = '/api/admin/data-export/site';
export const SITE_IMPORT_PREVIEW_ENDPOINT = '/api/admin/data-import/site/preview';
export const SITE_IMPORT_APPLY_ENDPOINT = '/api/admin/data-import/site/apply';
export const PERSONAL_EXPORT_ENDPOINT = '/api/personal/data-export';
export const PERSONAL_IMPORT_PREVIEW_ENDPOINT = '/api/personal/data-import/preview';
export const PERSONAL_IMPORT_APPLY_ENDPOINT = '/api/personal/data-import/apply';

/** A parsed JSON document of unknown shape; the server is the only validator. */
export type PortableDocument = Record<string, unknown>;

/** Summary returned by both preview and apply. */
export interface SiteImportSummary {
  scope: 'site';
  incomingCategories: number;
  incomingLinks: number;
  currentCategories: number;
  currentLinks: number;
  brandingUpdated: boolean;
  assetsPreserved: boolean;
  replacementWarning: string;
}

export interface PersonalImportSummary {
  scope: 'personal';
  incomingCategories: number;
  incomingLinks: number;
  currentCategories: number;
  currentLinks: number;
  replacementWarning: string;
}

/**
 * Outcome of downloading an export.
 *
 * `unauthenticated` and `forbidden` are kept distinct from `error`: the UI must
 * not present a retry as though it could succeed without a different identity.
 */
export type ExportResult =
  | { status: 'ok'; document: PortableDocument }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' };

/** Outcome of previewing an import. `invalid` carries the server's message. */
export type PreviewResult<T> =
  | { status: 'ok'; summary: T }
  | { status: 'invalid'; message: string }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' };

/** Outcome of applying an import. */
export type ApplyResult<T> = PreviewResult<T>;

/** Read the server's `{ error }` message when it is a string. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Non-JSON error bodies fall through to the generic message.
  }

  return '请求未能完成，请稍后重试。';
}

/** Download a document, returning the raw text so the UI can save it verbatim. */
export async function downloadDocument(
  endpoint: string,
  signal?: AbortSignal,
): Promise<
  | { status: 'ok'; document: PortableDocument; text: string }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' }
> {
  let response: Response;

  try {
    response = await fetch(endpoint, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { status: 'error' };
  }

  if (response.status === 401) {
    return { status: 'unauthenticated' };
  }

  if (response.status === 403) {
    return { status: 'forbidden' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  let text: string;

  try {
    text = await response.text();
  } catch {
    return { status: 'error' };
  }

  try {
    return { status: 'ok', document: JSON.parse(text) as PortableDocument, text };
  } catch {
    return { status: 'error' };
  }
}

/** Export the site's portable data. Admin only; the server rejects other callers. */
export function exportSiteDocument(signal?: AbortSignal) {
  return downloadDocument(SITE_EXPORT_ENDPOINT, signal);
}

/** Export the caller's own personal navigation. */
export function exportPersonalDocument(signal?: AbortSignal) {
  return downloadDocument(PERSONAL_EXPORT_ENDPOINT, signal);
}

/**
 * Parse pasted or uploaded JSON text.
 *
 * A syntax error is reported as `invalid` so the UI can show it inline; it never
 * reaches the server and never counts as a preview.
 */
export function parseDocumentText(text: string): { status: 'ok'; document: PortableDocument } | { status: 'invalid'; message: string } {
  if (text.trim().length === 0) {
    return { status: 'invalid', message: '内容为空，请粘贴或选择 JSON 文件。' };
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'invalid', message: 'JSON 顶层必须是一个对象。' };
    }

    return { status: 'ok', document: parsed as PortableDocument };
  } catch {
    return { status: 'invalid', message: 'JSON 解析失败，请检查格式。' };
  }
}

/** Send a preview or apply request. */
async function sendDocument(
  endpoint: string,
  document: PortableDocument,
  confirm: boolean,
): Promise<{ response: Response } | { status: 'error' }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(confirm ? { confirm: true, document } : { document }),
    });

    return { response };
  } catch {
    return { status: 'error' };
  }
}

/** Classify a preview/apply response into the shared result shape. */
async function classifyDocument<T>(result: { response: Response } | { status: 'error' }): Promise<PreviewResult<T>> {
  if ('status' in result) {
    return { status: 'error' };
  }

  const { response } = result;

  if (response.status === 401) {
    return { status: 'unauthenticated' };
  }

  if (response.status === 403) {
    return { status: 'forbidden' };
  }

  if (response.status === 400) {
    return { status: 'invalid', message: await readErrorMessage(response) };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  try {
    return { status: 'ok', summary: (await response.json()) as T };
  } catch {
    return { status: 'error' };
  }
}

/** Validate a site document and summarize the change. Writes nothing. */
export async function previewSiteImport(document: PortableDocument): Promise<PreviewResult<SiteImportSummary>> {
  return classifyDocument<SiteImportSummary>(await sendDocument(SITE_IMPORT_PREVIEW_ENDPOINT, document, false));
}

/** Replace public navigation and portable settings. Destructive; requires confirm. */
export async function applySiteImport(document: PortableDocument): Promise<ApplyResult<SiteImportSummary>> {
  return classifyDocument<SiteImportSummary>(await sendDocument(SITE_IMPORT_APPLY_ENDPOINT, document, true));
}

/** Validate a personal document and summarize the change. Writes nothing. */
export async function previewPersonalImport(
  document: PortableDocument,
): Promise<PreviewResult<PersonalImportSummary>> {
  return classifyDocument<PersonalImportSummary>(
    await sendDocument(PERSONAL_IMPORT_PREVIEW_ENDPOINT, document, false),
  );
}

/** Replace the caller's personal navigation. Destructive; requires confirm. */
export async function applyPersonalImport(
  document: PortableDocument,
): Promise<ApplyResult<PersonalImportSummary>> {
  return classifyDocument<PersonalImportSummary>(
    await sendDocument(PERSONAL_IMPORT_APPLY_ENDPOINT, document, true),
  );
}

/**
 * Trigger a browser download of already-serialized JSON text.
 *
 * Uses a Blob object URL. Deliberately **not** a `data:` URL: a `data:` URL is a
 * navigation rather than a download source in some contexts, and would become a
 * same-origin document if the text were ever navigated to.
 *
 * The object URL is released on a later task instead of synchronously. Revoking
 * in the same task as `click()` can race the browser's own read of the blob and
 * abort the download it just started, so the revoke is deferred — long enough for
 * the download to be handed off, short enough not to pin the blob for the session.
 */
export function saveJsonFile(filename: string, text: string): void {
  if (typeof URL?.createObjectURL !== 'function') {
    // Without blob URL support there is nothing safe to fall back to; failing
    // silently is better than navigating to a `data:` URL.
    return;
  }

  const blob = new Blob([text], { type: 'application/json' });

  // A Blob URL is same-origin and inert; it cannot execute script.
  const url = URL.createObjectURL(blob);

  try {
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    window.document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Deferred so the browser has already taken ownership of the blob.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}

/** Recommended filename for an exported document. */
export function exportFilename(scope: 'site' | 'personal', now: Date = new Date()): string {
  const stamp = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  return scope === 'site' ? `navigation-site-${stamp}.json` : `navigation-personal-${stamp}.json`;
}
