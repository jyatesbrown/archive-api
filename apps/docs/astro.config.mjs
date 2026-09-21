// @ts-check
import { defineConfig } from 'astro/config';

import { SITE_URL } from './src/config/site.ts';

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  // Exactly one URL per page: `/sources/fixture_registry/`, never `/sources/fixture_registry`
  // or `/sources/fixture_registry/index.html`. Pages 301s the other spellings to this one;
  // `scripts/check-canonical.ts` verifies every built page declares it.
  trailingSlash: 'always',
  build: { format: 'directory' },
});
