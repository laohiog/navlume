import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../db/schema.js';
import type { Auth } from '../db/auth.js';
import type { FirstRunSetup } from './first-run-setup.js';
import { getPublicNavigation, getSiteAccessMode } from './public-navigation.js';
import {
  DataPortabilityError,
  applyPersonalImport,
  applySiteImport,
  exportPersonalData,
  exportSiteData,
  previewPersonalImport,
  previewSiteImport,
} from './data-portability.js';
import {
  BrandingError,
  getBranding,
  getPublicBranding,
  readBrandAsset,
  removeBrandAsset,
  resolveUploadsDir,
  storeBrandAsset,
  updateBranding,
  validateAssetUpload,
  type AssetKind,
} from './branding.js';
import {
  PublicMutationError,
  createPublicCategory,
  createPublicLink,
  deletePublicCategory,
  deletePublicLink,
  getAdminPublicNavigation,
  reorderPublicCategories,
  reorderPublicLinks,
  updatePublicCategory,
  updatePublicLink,
} from './public-mutations.js';
import { getPersonalNavigation } from './personal-navigation.js';
import {
  PersonalMutationError,
  createCategory,
  createLink,
  deleteCategory,
  deleteLink,
  reorderCategories,
  reorderLinks,
  updateCategory,
  updateLink,
} from './personal-mutations.js';

/** Dependencies the Hono application needs. Passed explicitly, no DI framework. */
export interface AppDependencies {
  db: BetterSQLite3Database<typeof schema>;
  auth: Auth;
  setup?: FirstRunSetup;
  /**
   * Absolute path to the built client assets to serve in production.
   *
   * Omitted in development (Vite serves the client) and in unit tests, where the
   * application keeps its JSON-404 behaviour for unmatched routes.
   */
  staticRoot?: string;
}

/**
 * Public health endpoint.
 *
 * A healthy running process already holds an open SQLite connection, so a trivial
 * `SELECT 1` is enough to detect a database that has become unusable (for example
 * a deleted or read-only file). Deliberately returns no database path, environment
 * values, counts, or stack traces — this is a deployment readiness probe, not a
 * monitoring subsystem.
 */
function registerHealthRoute(app: Hono, deps: AppDependencies): void {
  app.get('/api/health', (c) => {
    try {
      // A trivial real query, so a database that has become unusable (deleted,
      // locked, or read-only) is reported as unhealthy rather than appearing fine.
      deps.db.get(sql`SELECT 1`);

      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unhealthy' }, 503);
    }
  });
}

/**
 * Build the Hono application.
 *
 * Dependencies are injected so tests can supply an isolated temporary database
 * and its own auth instance. This function has no import-time side effects and
 * never opens, migrates, or seeds a database on its own.
 */
export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();
  deps.setup?.register(app);

  /**
   * Public navigation.
   *
   * `site_settings.access_mode` is enforced here, on the server:
   * - no site row / `public`  -> served to anyone (guest included)
   * - `login_required`        -> requires a server-validated Better Auth session
   *
   * The access decision is taken from the session cookie via `auth.api
   * .getSession`. Nothing client-supplied (userId, query string, localStorage,
   * custom header) participates in authorization. The 401 response is returned
   * before any navigation rows are read, so none can leak.
   *
   * Write routes do not exist yet; they belong to a later admin phase.
   */
  app.get('/api/public/navigation', async (c) => {
    try {
      const accessMode = getSiteAccessMode(deps.db);

      if (accessMode === 'login_required') {
        const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });

        if (session === null) {
          return c.json({ error: 'Authentication Required' }, 401);
        }
      }

      return c.json(getPublicNavigation(deps.db));
    } catch (error) {
      // Never leak stack traces, SQL, or database paths to clients.
      console.error('[api] GET /api/public/navigation failed:', error);
      return c.json({ error: 'Internal Server Error' }, 500);
    }
  });

  /**
   * Personal navigation — read-only in P3.1.
   *
   * Ownership comes exclusively from the Better Auth session resolved from the
   * request cookie. Any `userId`/`username` in the query string or any
   * `x-user-id`-style header is ignored; there is no code path that reads them.
   * A guest receives 401 before any personal row is read.
   *
   * Admin has no elevated access here: an admin sees only their own personal
   * navigation, because the query is bound to their session user id like any
   * other user.
   *
   * Mutation routes (create/update/delete/reorder) belong to P3.2.
   */
  app.get('/api/personal/navigation', async (c) => {
    try {
      const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });

      if (session === null) {
        return c.json({ error: 'Authentication Required' }, 401);
      }

      return c.json(getPersonalNavigation(deps.db, session.user.id));
    } catch (error) {
      // Never leak stack traces, SQL, user ids, or database paths to clients.
      console.error('[api] GET /api/personal/navigation failed:', error);
      return c.json({ error: 'Internal Server Error' }, 500);
    }
  });

  registerPersonalMutationRoutes(app, deps);
  registerAdminPublicRoutes(app, deps);
  registerBrandingRoutes(app, deps);
  registerDataPortabilityRoutes(app, deps);
  registerHealthRoute(app, deps);

  // Better Auth owns the whole /api/auth/* surface (sign-in, sign-out, session).
  // Registered before the catch-all 404 so it is reachable.
  app.all('/api/auth/*', (c) => deps.auth.handler(c.req.raw));

  /**
   * Production static client.
   *
   * Only wired when `staticRoot` is configured, which is the production server
   * entry point. Development keeps using Vite, and unit tests keep their existing
   * JSON-404 behaviour for unmatched routes.
   *
   * Registered **after** every API route so `/api/*` always wins, and before the
   * catch-all 404 so a real asset is served rather than 404ed.
   */
  if (deps.staticRoot !== undefined) {
    app.use('*', serveStatic({ root: deps.staticRoot }));
  }

  app.notFound(async (c) => {
    // An unmatched API path must stay a JSON 404. Returning the SPA shell here
    // would hand HTML to an API client and mask genuine routing errors.
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not Found' }, 404);
    }

    // Any other unmatched path is treated as a client-side route and falls back to
    // the SPA shell. Without a static root (development, unit tests) the previous
    // JSON 404 behaviour is preserved.
    if (deps.staticRoot !== undefined) {
      const shell = await serveStatic({ root: deps.staticRoot, path: 'index.html' })(
        c,
        () => Promise.resolve(),
      );

      if (shell !== undefined) {
        return shell;
      }
    }

    return c.json({ error: 'Not Found' }, 404);
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Personal mutation routes (P3.2)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the caller's own user id, or return the 401 response to send.
 *
 * This is the single authorization entry point for every personal mutation.
 * Nothing else in these routes reads identity from the body, query string, or
 * headers, so an admin has no elevated personal-data access either.
 */
async function requireSessionUserId(
  deps: AppDependencies,
  c: Context,
): Promise<{ userId: string } | { response: Response }> {
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });

  if (session === null) {
    return { response: c.json({ error: 'Authentication Required' }, 401) };
  }

  return { userId: session.user.id };
}

/**
 * Exact JSON media type required on every personal mutation request.
 *
 * Compared by media-type essence (the part before `;`), so parameters such as
 * `charset=utf-8` are allowed while lookalikes are not. A substring test would
 * wrongly accept `text/plain; foo=application/json`.
 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * Enforce the JSON media-type contract for a mutation request.
 *
 * Applied to all eight personal mutation routes — including DELETE, which has no
 * body — so the contract is uniform: a cookie-authenticated mutation must declare
 * itself as JSON. This is a media-type requirement, not a CSRF token system.
 *
 * Returns the 415 response when the request does not qualify, otherwise `null`.
 */
function requireJsonContentType(c: Context): Response | null {
  const header = c.req.header('content-type') ?? '';
  const essence = header.split(';', 1)[0]?.trim().toLowerCase() ?? '';

  if (essence !== JSON_MEDIA_TYPE) {
    return c.json({ error: 'Unsupported Media Type' }, 415);
  }

  return null;
}

/**
 * Parse a JSON body after enforcing the media-type contract.
 *
 * The origin boundary for these routes is the same-origin architecture (no
 * permissive CORS) together with this JSON requirement and the session cookie —
 * no CSRF token framework is used.
 */
async function readJsonBody(
  c: Context,
): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const mediaTypeError = requireJsonContentType(c);
  if (mediaTypeError !== null) {
    return { response: mediaTypeError };
  }

  try {
    const parsed: unknown = await c.req.json();

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { response: c.json({ error: 'Invalid Request Body' }, 400) };
    }

    return { body: parsed as Record<string, unknown> };
  } catch {
    return { response: c.json({ error: 'Invalid Request Body' }, 400) };
  }
}

/**
 * Map a service error to an HTTP response.
 *
 * `not_found` is returned for unknown ids *and* for ids owned by another user,
 * so responses cannot be used to probe existence or ownership. Unexpected errors
 * become a generic 500 with no SQL or stack detail.
 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof PersonalMutationError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
    return c.json({ error: error.message }, status as 400);
  }

  console.error('[api] personal mutation failed:', error);
  return c.json({ error: 'Internal Server Error' }, 500);
}

function registerPersonalMutationRoutes(app: Hono, deps: AppDependencies): void {
  app.post('/api/personal/categories', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json(createCategory(deps.db, auth.userId, json.body), 201);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.patch('/api/personal/categories/:id', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      return c.json(updateCategory(deps.db, auth.userId, id, json.body));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.delete('/api/personal/categories/:id', async (c) => {
    try {
      const mediaTypeError = requireJsonContentType(c);
      if (mediaTypeError !== null) return mediaTypeError;

      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      deleteCategory(deps.db, auth.userId, id);
      return c.body(null, 204);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.put('/api/personal/categories/order', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json({ categories: reorderCategories(deps.db, auth.userId, json.body) });
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.post('/api/personal/links', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json(createLink(deps.db, auth.userId, json.body), 201);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.patch('/api/personal/links/:id', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      return c.json(updateLink(deps.db, auth.userId, id, json.body));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.delete('/api/personal/links/:id', async (c) => {
    try {
      const mediaTypeError = requireJsonContentType(c);
      if (mediaTypeError !== null) return mediaTypeError;

      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      deleteLink(deps.db, auth.userId, id);
      return c.body(null, 204);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.put('/api/personal/links/order', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json({ links: reorderLinks(deps.db, auth.userId, json.body) });
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Admin public-navigation routes (P5.1)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the caller's admin identity, or return the response to send.
 *
 * This is the **only** authorization boundary for the `/api/admin/*` surface.
 * Identity and role both come from the Better Auth session resolved against the
 * request cookie; nothing is read from the body, query string, or headers, so
 * `?role=admin`, `body.role`, `x-role`, `x-user-id`, and similar spoofing all
 * have no effect.
 *
 * Status codes are deliberate:
 *  - no valid session      -> 401 (caller is not authenticated)
 *  - authenticated non-admin -> 403 (caller is known but not permitted)
 *
 * The 403 is only reachable by a caller who has already proven a valid session,
 * so it discloses nothing to an anonymous visitor.
 */
async function requireAdminUserId(
  deps: AppDependencies,
  c: Context,
): Promise<{ userId: string } | { response: Response }> {
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });

  if (session === null) {
    return { response: c.json({ error: 'Authentication Required' }, 401) };
  }

  const role = (session.user as { role?: string | null }).role;

  if (role !== 'admin') {
    return { response: c.json({ error: 'Forbidden' }, 403) };
  }

  return { userId: session.user.id };
}

/** Map a public mutation error onto an HTTP response without leaking internals. */
function toPublicErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof PublicMutationError) {
    return c.json({ error: error.message }, error.code === 'not_found' ? 404 : 400);
  }

  console.error('[api] public mutation failed:', error);
  return c.json({ error: 'Internal Server Error' }, 500);
}

/**
 * Admin management of Public Navigation.
 *
 * Route naming follows the personal-navigation convention already established in
 * this file (`…/order` as a sub-resource with `PUT`), rather than inventing a
 * second ordering convention for the admin surface.
 */
function registerAdminPublicRoutes(app: Hono, deps: AppDependencies): void {
  app.get('/api/admin/public-navigation', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      return c.json(getAdminPublicNavigation(deps.db));
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.post('/api/admin/public/categories', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json(createPublicCategory(deps.db, json.body), 201);
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.patch('/api/admin/public/categories/:id', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      return c.json(updatePublicCategory(deps.db, id, json.body));
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.delete('/api/admin/public/categories/:id', async (c) => {
    try {
      // Authorization runs first. The admin session/role check is the security
      // boundary for every /api/admin route, so request media-type syntax must
      // not decide the response before it: an unauthorized caller must always
      // receive 401/403, never a 415 leak of the mutation contract.
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      // DELETE has no body, but the media-type contract is uniform across the
      // admin mutation surface, matching the personal mutation routes.
      const mediaTypeError = requireJsonContentType(c);
      if (mediaTypeError !== null) return mediaTypeError;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      deletePublicCategory(deps.db, id);
      return c.body(null, 204);
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.put('/api/admin/public/categories/order', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json({ categories: reorderPublicCategories(deps.db, json.body) });
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.post('/api/admin/public/links', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json(createPublicLink(deps.db, json.body), 201);
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.patch('/api/admin/public/links/:id', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      return c.json(updatePublicLink(deps.db, id, json.body));
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.delete('/api/admin/public/links/:id', async (c) => {
    try {
      // Authorization first, for the same reason as the category DELETE route:
      // the admin session/role check is the boundary, and media-type validation
      // is a post-authorization concern.
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const mediaTypeError = requireJsonContentType(c);
      if (mediaTypeError !== null) return mediaTypeError;

      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Not Found' }, 404);
      }

      deletePublicLink(deps.db, id);
      return c.body(null, 204);
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });

  app.put('/api/admin/public/links/order', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json({ links: reorderPublicLinks(deps.db, json.body) });
    } catch (error) {
      return toPublicErrorResponse(c, error);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Branding routes (P5.2)                                                      */
/* -------------------------------------------------------------------------- */

/** Map a branding error onto a response without leaking internals. */
function toBrandingErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof BrandingError) {
    return c.json({ error: error.message }, error.code === 'not_found' ? 404 : 400);
  }

  console.error('[api] branding request failed:', error);
  return c.json({ error: 'Internal Server Error' }, 500);
}

/**
 * Require `multipart/form-data` on an upload route.
 *
 * Checked **after** authorization, so an unauthorized caller never learns the
 * upload contract. Returns the 415 response when the request does not qualify.
 */
function requireMultipartContentType(c: Context): Response | null {
  const essence = (c.req.header('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';

  if (essence !== 'multipart/form-data') {
    return c.json({ error: 'Unsupported Media Type' }, 415);
  }

  return null;
}

/**
 * Handle one asset upload with the required processing order:
 *
 *  1. admin authorization
 *  2. multipart media-type validation
 *  3. body/file parsing
 *  4. size/type/signature validation
 *  5. filesystem write
 *  6. database path update
 *
 * Authorization is first because it is the security boundary: media-type syntax
 * must not determine the response before it.
 */
async function handleBrandAssetUpload(
  c: Context,
  deps: AppDependencies,
  kind: AssetKind,
): Promise<Response> {
  try {
    const auth = await requireAdminUserId(deps, c);
    if ('response' in auth) return auth.response;

    const mediaTypeError = requireMultipartContentType(c);
    if (mediaTypeError !== null) return mediaTypeError;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody({ all: kind === 'background' })) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid Request Body' }, 400);
    }

    const file = body['file'];

    if (!(file instanceof File)) {
      return c.json({ error: 'A file field is required' }, 400);
    }

    if (kind === 'background' && Object.values(body).flat().filter((value) => value instanceof File).length !== 1) {
      return c.json({ error: 'Exactly one file is required' }, 400);
    }

    const asset = await validateAssetUpload(kind, file);
    const settings = storeBrandAsset(deps.db, kind, asset);

    return c.json(settings, 201);
  } catch (error) {
    return toBrandingErrorResponse(c, error);
  }
}

/** Handle detaching an asset. Authorization precedes the media-type check. */
async function handleBrandAssetRemoval(
  c: Context,
  deps: AppDependencies,
  kind: AssetKind,
): Promise<Response> {
  try {
    const auth = await requireAdminUserId(deps, c);
    if ('response' in auth) return auth.response;

    const mediaTypeError = requireJsonContentType(c);
    if (mediaTypeError !== null) return mediaTypeError;

    return c.json(removeBrandAsset(deps.db, kind));
  } catch (error) {
    return toBrandingErrorResponse(c, error);
  }
}

function registerBrandingRoutes(app: Hono, deps: AppDependencies): void {
  /**
   * Public branding.
   *
   * Intentionally unauthenticated and independent of `access_mode`: it carries no
   * navigation, user, or admin data, and it is what keeps the `login_required`
   * login screen branded. It is *not* gated by the access policy, unlike
   * `/api/public/navigation`.
   */
  app.get('/api/public/branding', (c) => {
    try {
      return c.json(getPublicBranding(deps.db));
    } catch (error) {
      return toBrandingErrorResponse(c, error);
    }
  });

  /**
   * Serve a stored brand asset.
   *
   * Only server-generated filenames resolve; anything else is a 404. The MIME type
   * comes from the validated stored extension, never from the original upload, and
   * `nosniff` prevents content-type sniffing. Assets are public presentation data,
   * so this route is available regardless of `access_mode`.
   */
  app.get('/api/public/brand-assets/:filename', (c) => {
    try {
      const asset = readBrandAsset(c.req.param('filename'), resolveUploadsDir());

      if (asset === null) {
        return c.json({ error: 'Not Found' }, 404);
      }

      return c.body(asset.bytes, 200, {
        'content-type': asset.mime,
        'x-content-type-options': 'nosniff',
        // Generated filenames are unique per upload, so a long immutable cache is
        // safe and avoids stale logos after a replacement.
        'cache-control': 'public, max-age=31536000, immutable',
      });
    } catch (error) {
      return toBrandingErrorResponse(c, error);
    }
  });

  app.get('/api/admin/branding', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      return c.json(getBranding(deps.db));
    } catch (error) {
      return toBrandingErrorResponse(c, error);
    }
  });

  app.put('/api/admin/branding', async (c) => {
    try {
      // Authorization first, then media type, then body.
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readJsonBody(c);
      if ('response' in json) return json.response;

      return c.json(updateBranding(deps.db, json.body));
    } catch (error) {
      return toBrandingErrorResponse(c, error);
    }
  });

  app.post('/api/admin/branding/logo', (c) => handleBrandAssetUpload(c, deps, 'logo'));
  app.delete('/api/admin/branding/logo', (c) => handleBrandAssetRemoval(c, deps, 'logo'));
  app.post('/api/admin/branding/favicon', (c) => handleBrandAssetUpload(c, deps, 'favicon'));
  app.delete('/api/admin/branding/favicon', (c) => handleBrandAssetRemoval(c, deps, 'favicon'));
  app.post('/api/admin/branding/background', (c) => handleBrandAssetUpload(c, deps, 'background'));
  app.delete('/api/admin/branding/background', (c) => handleBrandAssetRemoval(c, deps, 'background'));
}

/* -------------------------------------------------------------------------- */
/* Data portability routes (P6.1)                                              */
/* -------------------------------------------------------------------------- */

/** Map a portability error onto a response without leaking internals. */
function toPortabilityErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof DataPortabilityError) {
    return c.json({ error: error.message }, 400);
  }

  // A database-level failure: the transaction already rolled back, so report a
  // generic failure rather than the SQL text.
  console.error('[api] data portability failed:', error);
  return c.json({ error: 'Import Failed' }, 500);
}

/**
 * Require the explicit confirmation flag on an import apply request.
 *
 * Apply is destructive, so selection or preview alone must never be sufficient.
 * Returns the 400 response when `confirm !== true`.
 */
function requireConfirmation(c: Context, body: Record<string, unknown>): Response | null {
  if (body['confirm'] !== true) {
    return c.json({ error: 'Confirmation Required' }, 400);
  }

  return null;
}

/**
 * Read the JSON body for a portability request.
 *
 * Enforces the same JSON media-type contract as the other mutation surfaces.
 */
async function readPortabilityBody(
  c: Context,
): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const json = await readJsonBody(c);
  if ('response' in json) return json;
  return json;
}

function registerDataPortabilityRoutes(app: Hono, deps: AppDependencies): void {
  /**
   * Site export — Admin only.
   *
   * Authorization precedes any read, so a non-admin never causes the data to be
   * assembled. The document contains no asset paths, auth records, or personal data.
   */
  app.get('/api/admin/data-export/site', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      return c.json(exportSiteData(deps.db));
    } catch (error) {
      return toPortabilityErrorResponse(c, error);
    }
  });

  app.post('/api/admin/data-import/site/preview', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readPortabilityBody(c);
      if ('response' in json) return json.response;

      // Pure validation + counts: zero writes.
      return c.json(previewSiteImport(deps.db, json.body['document']));
    } catch (error) {
      return toPortabilityErrorResponse(c, error);
    }
  });

  app.post('/api/admin/data-import/site/apply', async (c) => {
    try {
      const auth = await requireAdminUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readPortabilityBody(c);
      if ('response' in json) return json.response;

      const confirmationError = requireConfirmation(c, json.body);
      if (confirmationError !== null) return confirmationError;

      // `applySiteImport` revalidates and performs the whole replacement atomically.
      return c.json(applySiteImport(deps.db, json.body['document']));
    } catch (error) {
      return toPortabilityErrorResponse(c, error);
    }
  });

  /**
   * Personal export — the authenticated caller's own navigation only.
   *
   * Ownership comes from the session, so an admin exporting "personal" data still
   * gets only their own navigation.
   */
  app.get('/api/personal/data-export', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      return c.json(exportPersonalData(deps.db, auth.userId));
    } catch (error) {
      return toPortabilityErrorResponse(c, error);
    }
  });

  app.post('/api/personal/data-import/preview', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readPortabilityBody(c);
      if ('response' in json) return json.response;

      return c.json(previewPersonalImport(deps.db, auth.userId, json.body['document']));
    } catch (error) {
      return toPortabilityErrorResponse(c, error);
    }
  });

  app.post('/api/personal/data-import/apply', async (c) => {
    try {
      const auth = await requireSessionUserId(deps, c);
      if ('response' in auth) return auth.response;

      const json = await readPortabilityBody(c);
      if ('response' in json) return json.response;

      const confirmationError = requireConfirmation(c, json.body);
      if (confirmationError !== null) return confirmationError;

      return c.json(applyPersonalImport(deps.db, auth.userId, json.body['document']));
    } catch (error) {
      return toPortabilityErrorResponse(c, error);
    }
  });
}
