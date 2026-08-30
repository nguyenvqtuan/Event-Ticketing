/**
 * Where the API lives, and nowhere else.
 *
 * Two variables, because a Next app calls the API from two places and they are
 * not always the same address:
 *
 *   - `NEXT_PUBLIC_API_URL` is inlined into the browser bundle at build time,
 *     so it must be an address a *browser* can reach.
 *   - `API_URL` is read on the server at run time, for server components and
 *     route handlers. In a container network that is often an internal name
 *     (`http://api:3000`) the browser could never resolve.
 *
 * Server-side reads prefer `API_URL` and fall back to the public one, so a
 * single-address deployment configures only `NEXT_PUBLIC_API_URL` and works.
 */

/** Only for local development, where both sides really are localhost:3000. */
const DEVELOPMENT_FALLBACK = 'http://localhost:3000';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * `process.env.NEXT_PUBLIC_*` is substituted at build time, so it must be
 * written out in full — destructuring or dynamic lookup defeats the inlining
 * and yields `undefined` in the browser.
 */
export function apiBaseUrl(): string {
  const fromServer = typeof window === 'undefined' ? process.env.API_URL : undefined;
  const configured = fromServer ?? process.env.NEXT_PUBLIC_API_URL;

  if (configured) return trimTrailingSlash(configured);

  // Failing loudly in production beats silently calling localhost from a
  // deployed browser, which looks like the API is down.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not set. The web app has no API to call — see docs/runbook.md.',
    );
  }

  return DEVELOPMENT_FALLBACK;
}
