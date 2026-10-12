/**
 * Client-side access to the Branding API.
 *
 * Mirrors `src/server/branding.ts`. Declared locally: the client must not import
 * server modules.
 *
 * Authorization is entirely server-side. This module never sends a role or user
 * id — only the session cookie. Client-side visibility of the admin form is
 * convenience, not permission.
 */

/** Branding settings as returned by the admin read/write endpoints. */
export interface BrandingSettings {
  siteName: string;
  tagline: string | null;
  logoPath: string | null;
  faviconPath: string | null;
  primaryColor: string | null;
  pageBackgroundColor: string | null;
  surfaceColor: string | null;
  backgroundImagePath: string | null;
  defaultTheme: 'light' | 'dark';
  footerText: string | null;
  accessMode: 'public' | 'login_required';
}

/**
 * Public branding as returned by `GET /api/public/branding`.
 *
 * Deliberately has no `accessMode`: the public endpoint exposes only presentation
 * data, and the access policy is not part of it.
 */
export type PublicBranding = Omit<BrandingSettings, 'accessMode'>;

/** Safe fallback used when branding cannot be loaded. Never blocks navigation. */
export const FALLBACK_BRANDING: PublicBranding = {
  siteName: '导航',
  tagline: null,
  logoPath: null,
  faviconPath: null,
  primaryColor: null,
  pageBackgroundColor: null,
  surfaceColor: null,
  backgroundImagePath: null,
  defaultTheme: 'light',
  footerText: null,
};

export const PUBLIC_BRANDING_ENDPOINT = '/api/public/branding';
export const ADMIN_BRANDING_ENDPOINT = '/api/admin/branding';

/** Outcome of reading public branding. */
export type PublicBrandingResult =
  | { status: 'ok'; data: PublicBranding }
  | { status: 'error' };

/** Outcome of reading admin branding. */
export type AdminBrandingResult =
  | { status: 'ok'; data: BrandingSettings }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' };

/** Outcome of an admin branding mutation. */
export type BrandingMutationOutcome =
  | { status: 'ok'; data: BrandingSettings }
  | { status: 'invalid' }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' };

/** Read public branding. Never throws; callers fall back to `FALLBACK_BRANDING`. */
export async function fetchPublicBranding(signal?: AbortSignal): Promise<PublicBrandingResult> {
  let response: Response;

  try {
    response = await fetch(PUBLIC_BRANDING_ENDPOINT, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { status: 'error' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  try {
    return { status: 'ok', data: (await response.json()) as PublicBranding };
  } catch {
    return { status: 'error' };
  }
}

/** Read admin branding settings. */
export async function fetchAdminBranding(signal?: AbortSignal): Promise<AdminBrandingResult> {
  let response: Response;

  try {
    response = await fetch(ADMIN_BRANDING_ENDPOINT, {
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

  try {
    return { status: 'ok', data: (await response.json()) as BrandingSettings };
  } catch {
    return { status: 'error' };
  }
}

/** Classify a branding mutation response. */
function classify(response: Response, data: BrandingSettings | null): BrandingMutationOutcome {
  if (response.ok && data !== null) {
    return { status: 'ok', data };
  }

  switch (response.status) {
    case 400:
      return { status: 'invalid' };
    case 401:
      return { status: 'unauthenticated' };
    case 403:
      return { status: 'forbidden' };
    default:
      return { status: 'error' };
  }
}

/**
 * Save the full editable settings state.
 *
 * `logoPath`/`faviconPath`/`backgroundImagePath` are intentionally absent: asset paths may only change
 * through the upload/remove endpoints, so a JSON body cannot point the site at
 * an arbitrary path.
 */
export async function updateAdminBranding(input: {
  siteName: string;
  tagline: string | null;
  primaryColor: string | null;
  pageBackgroundColor?: string | null;
  surfaceColor?: string | null;
  defaultTheme: 'light' | 'dark';
  footerText: string | null;
  accessMode: 'public' | 'login_required';
}): Promise<BrandingMutationOutcome> {
  let response: Response;

  try {
    response = await fetch(ADMIN_BRANDING_ENDPOINT, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { status: 'error' };
  }

  if (!response.ok) {
    return classify(response, null);
  }

  try {
    return { status: 'ok', data: (await response.json()) as BrandingSettings };
  } catch {
    return { status: 'error' };
  }
}

/** Upload a managed brand asset as multipart form data. */
async function uploadBrandAsset(
  kind: 'logo' | 'favicon' | 'background',
  file: File,
): Promise<BrandingMutationOutcome> {
  const form = new FormData();
  form.append('file', file);

  let response: Response;

  try {
    // No explicit Content-Type: the browser must set the multipart boundary.
    response = await fetch(`${ADMIN_BRANDING_ENDPOINT}/${kind}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      body: form,
    });
  } catch {
    return { status: 'error' };
  }

  if (!response.ok) {
    return classify(response, null);
  }

  try {
    return { status: 'ok', data: (await response.json()) as BrandingSettings };
  } catch {
    return { status: 'error' };
  }
}

/** Upload a logo. */
export function uploadBrandLogo(file: File): Promise<BrandingMutationOutcome> {
  return uploadBrandAsset('logo', file);
}

/** Upload a favicon. */
export function uploadBrandFavicon(file: File): Promise<BrandingMutationOutcome> {
  return uploadBrandAsset('favicon', file);
}

/** Upload a background image; rendering is handled by a later UI task. */
export function uploadBrandBackground(file: File): Promise<BrandingMutationOutcome> {
  return uploadBrandAsset('background', file);
}

/** Remove an asset. DELETE carries a JSON content type, matching the server contract. */
async function removeBrandAsset(kind: 'logo' | 'favicon' | 'background'): Promise<BrandingMutationOutcome> {
  let response: Response;

  try {
    response = await fetch(`${ADMIN_BRANDING_ENDPOINT}/${kind}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
  } catch {
    return { status: 'error' };
  }

  if (!response.ok) {
    return classify(response, null);
  }

  try {
    return { status: 'ok', data: (await response.json()) as BrandingSettings };
  } catch {
    return { status: 'error' };
  }
}

/** Remove the logo. */
export function removeBrandLogo(): Promise<BrandingMutationOutcome> {
  return removeBrandAsset('logo');
}

/** Remove the favicon. */
export function removeBrandFavicon(): Promise<BrandingMutationOutcome> {
  return removeBrandAsset('favicon');
}

/** Remove the instance's managed background image. */
export function removeBrandBackground(): Promise<BrandingMutationOutcome> {
  return removeBrandAsset('background');
}
