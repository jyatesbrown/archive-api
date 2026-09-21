/**
 * Site-wide constants. Both the Astro config (build time) and the pages read
 * them, so they must stay dependency-free and importable from plain Node.
 *
 * `PUBLIC_SITE_URL` / `PUBLIC_API_URL` override at build time (Pages env
 * vars); the defaults are the production hosts.
 */
const env = typeof process !== 'undefined' ? process.env : {};

function origin(v: string | undefined, fallback: string): string {
  const u = new URL(v && v.trim() !== '' ? v : fallback);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error(`site/api URL must be https: ${u.href}`);
  }
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`site/api URL must be a bare origin: ${u.href}`);
  return u.origin;
}

export const SITE_URL: string = origin(env['PUBLIC_SITE_URL'], 'https://docs.archive-api.dev');
export const API_URL: string = origin(env['PUBLIC_API_URL'], 'https://api.archive-api.dev');
export const PRICING_PATH = '/pricing/';
export const SITE_NAME = 'Archive API';
export const TAGLINE = 'The historical state the publisher deleted, served as an API.';
