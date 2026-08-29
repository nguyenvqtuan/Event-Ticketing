import coreWebVitals from 'eslint-config-next/core-web-vitals';
import base from '@repo/eslint-config/next';

/**
 * `coreWebVitals` comes first so the shared base's parser + projectService
 * settings win for .ts/.tsx — otherwise Next's own parser shadows them and
 * type-aware rules lose their type information.
 */
const config = [...coreWebVitals, ...base, { ignores: ['.next/**', 'next-env.d.ts'] }];

export default config;
