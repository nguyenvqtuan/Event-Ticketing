/**
 * Evaluated before anything else so that Nest's ESM packages are finished
 * loading by the time a suite links `@nestjs/terminus`, whose CommonJS build
 * `require()`s them. Jest's ESM runtime rejects `require()` of an ESM module
 * that is still being linked ("a cycle involving require(esm)"); real Node
 * evaluates the same graph without complaint, which is why this is confined
 * to the test harness rather than worked around in the application.
 */
import '@nestjs/common';
import '@nestjs/core';

/**
 * Runs before any test module is imported (jest `setupFiles`).
 *
 * This matters because `ConfigModule.forRoot({ validate })` executes when
 * `config.module.ts` is *imported*, not when the module is compiled — so any
 * suite that imports AppModule needs a valid environment already in place.
 * Setting it inside a `beforeAll` would be far too late.
 *
 * The databases were created by `test/support/global-setup.ts`; this only
 * claims the one belonging to *this* worker, so parallel suites cannot see
 * each other's rows — and `resetDatabase()` is safe to call.
 */
const published = process.env.TEST_WORKER_DATABASE_URLS;

if (!published) {
  throw new Error(
    'No test databases were published — run the integration suites through ' +
      '`pnpm test:e2e`, which loads test/support/global-setup.ts.',
  );
}

const urls = JSON.parse(published) as string[];
const worker = Number(process.env.JEST_WORKER_ID ?? 1);

process.env.DATABASE_URL = urls[(worker - 1) % urls.length];
process.env.NODE_ENV ??= 'test';
