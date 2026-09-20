/**
 * Canonical URL enforcement: the checker's rules on synthetic trees, then the
 * real build output (built here if `pnpm build` has not run yet).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { checkCanonical } from '../scripts/check-canonical.ts';
import { SITE_URL } from '../src/config/site.ts';
import { SOURCES } from '../src/config/sources.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

function page(route: string, canonical = `${SITE_URL}${route}`, extra = ''): string {
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}"></head><body><a href="/docs/">x</a>${extra}</body></html>`;
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-'));
  for (const [rel, html] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), html);
  }
  return dir;
}

describe('checkCanonical() rules', () => {
  it('accepts a directory-format tree where every page declares its own URL', () => {
    const dir = tree({ 'index.html': page('/'), 'docs/index.html': page('/docs/'), 'sources/a/index.html': page('/sources/a/') });
    try {
      expect(checkCanonical(dir)).toEqual({ pages: 3, problems: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a wrong canonical, a missing one, a duplicate, a flat file and a non-canonical link', () => {
    const dir = tree({
      'index.html': page('/'),
      'docs/index.html': page('/docs/', `${SITE_URL}/docs`),
      'pricing/index.html': '<html><head></head><body></body></html>',
      'a/index.html': page('/a/', `${SITE_URL}/`),
      'flat.html': page('/flat/'),
      'b/index.html': page('/b/', `${SITE_URL}/b/`, '<a href="/docs">bad</a><a href="/x/index.html">bad</a><a href="https://elsewhere.example/p">fine</a>'),
    });
    try {
      const r = checkCanonical(dir);
      expect(r.pages).toBe(6);
      expect(r.problems).toEqual(
        expect.arrayContaining([
          expect.stringContaining('docs/index.html: canonical is'),
          expect.stringContaining('pricing/index.html: expected exactly one'),
          expect.stringMatching(/^(a\/)?index\.html: canonical https:\/\/docs\.archive-api\.dev\/ already claimed by (a\/)?index\.html$/),
          expect.stringContaining('flat.html: not in directory format'),
          expect.stringContaining('link "/docs" is not a canonical spelling'),
          expect.stringContaining('link "/x/index.html" is not a canonical spelling'),
        ]),
      );
      expect(r.problems.some((p) => p.includes('elsewhere.example'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours the site origin it is given', () => {
    const dir = tree({ 'index.html': page('/', 'https://other.example/') });
    try {
      expect(checkCanonical(dir, 'https://other.example').problems).toEqual([]);
      expect(checkCanonical(dir).problems).toHaveLength(2); // canonical + og:url
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the real build', () => {
  beforeAll(() => {
    if (!existsSync(join(dist, 'index.html'))) {
      execFileSync('pnpm', ['exec', 'astro', 'build'], { cwd: root, stdio: 'inherit' });
    }
  });

  it('passes the canonical check and contains every expected page', () => {
    const r = checkCanonical(dist);
    expect(r.problems).toEqual([]);
    expect(r.pages).toBe(4 + SOURCES.length);
    for (const s of SOURCES) expect(existsSync(join(dist, 'sources', s.name, 'index.html'))).toBe(true);
    for (const p of ['docs', 'pricing', 'sources']) expect(existsSync(join(dist, p, 'index.html'))).toBe(true);
  });
});
