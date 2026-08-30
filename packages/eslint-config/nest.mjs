import tseslint from 'typescript-eslint';
import base from './base.mjs';

/** Flat config for the NestJS API. */
export default tseslint.config(...base, {
  files: ['**/*.ts'],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: process.cwd(),
    },
  },
  rules: {
    // Nest controllers/providers are instantiated by the DI container, and
    // decorator metadata legitimately relies on types these rules flag.
    '@typescript-eslint/no-extraneous-class': 'off',
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
  },
});
