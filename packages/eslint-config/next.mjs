import tseslint from 'typescript-eslint';
import base from './base.mjs';

/**
 * Flat config for the Next.js app.
 *
 * `eslint-config-next` is intentionally not pulled in here: it is versioned
 * with Next itself, so `apps/web` composes it on top of this base locally.
 */
export default tseslint.config(...base, {
  files: ['**/*.ts', '**/*.tsx'],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: process.cwd(),
    },
  },
});
