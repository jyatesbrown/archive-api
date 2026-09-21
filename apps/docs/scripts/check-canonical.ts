/**
 * Build-time canonical URL enforcement over the emitted `dist/`.
 *
 * For every HTML file:
 *   - it lives at `<route>/index.html` (directory format), so the only URL is `<route>/`;
 *   - it has exactly one `<link rel="canonical">`, equal to `SITE_URL + <route>/`;
 *   - `og:url` agrees with it;
 *   - no internal link points at a non-canonical spelling (`/x`, `/x/index.html`, `/x.html`).
 * Also: no two pages share a canonical, and the root page exists.
 *
 * `pnpm build` runs this after `astro build`; `tests/canonical.test.ts` runs the same
 * function so the rules are covered with and without a real build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_URL } from '../src/config/site.ts';

export interface CanonicalReport {
  pages: number;
  problems: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const CANONICAL_RE = /<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/g;
const OG_URL_RE = /<meta\s+property="og:url"\s+content="([^"]*)"\s*\/?>/g;
const HREF_RE = /\shref="([^"]*)"/g;

export function checkCanonical(distDir: string, site: string = SITE_URL): CanonicalReport {
  const problems: string[] = [];
  const files = walk(distDir);
  const seen = new Map<string, string>();
  const origin = new URL(site).origin;

  for (const file of files) {
    const rel = relative(distDir, file).split(sep).join('/');
    const html = readFileSync(file, 'utf8');

    if (rel !== 'index.html' && !rel.endsWith('/index.html')) {
      problems.push(`${rel}: not in directory format (expected <route>/index.html)`);
      continue;
    }
    const route = rel === 'index.html' ? '/' : `/${rel.slice(0, -'index.html'.length)}`;
    const expected = `${origin}${route}`;

    const canonicals = [...html.matchAll(CANONICAL_RE)].map((m) => m[1]);
    if (canonicals.length !== 1) {
      problems.push(`${rel}: expected exactly one <link rel="canonical">, found ${canonicals.length}`);
    } else if (canonicals[0] !== expected) {
      problems.push(`${rel}: canonical is ${canonicals[0]}, expected ${expected}`);
    }

    const og = [...html.matchAll(OG_URL_RE)].map((m) => m[1]);
    if (og.length !== 1 || og[0] !== expected) problems.push(`${rel}: og:url must be ${expected}`);

    const prior = canonicals[0] === undefined ? undefined : seen.get(canonicals[0]);
    if (prior !== undefined) problems.push(`${rel}: canonical ${canonicals[0]} already claimed by ${prior}`);
    else if (canonicals[0] !== undefined) seen.set(canonicals[0], rel);

    for (const m of html.matchAll(HREF_RE)) {
      const href = m[1] ?? '';
      const internal = href.startsWith('/') || href.startsWith(origin);
      if (!internal || href.startsWith('//')) continue;
      const path = href.startsWith(origin) ? href.slice(origin.length) : href;
      const pathOnly = path.split(/[?#]/)[0] ?? '';
      if (pathOnly === '' || /\.[a-z0-9]+$/i.test(pathOnly) && !pathOnly.endsWith('.html')) continue; // assets
      if (pathOnly.endsWith('.html') || !pathOnly.endsWith('/')) {
        problems.push(`${rel}: link "${href}" is not a canonical spelling (must end in "/")`);
      }
    }
  }

  if (!files.some((f) => relative(distDir, f) === 'index.html')) problems.push('no root index.html');
  return { pages: files.length, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = process.argv[2] ?? 'dist';
  const report = checkCanonical(dist);
  if (report.problems.length > 0) {
    console.error(`canonical check failed (${report.problems.length} problem(s) across ${report.pages} page(s)):`);
    for (const p of report.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`canonical check ok: ${report.pages} page(s) under ${SITE_URL}`);
}
