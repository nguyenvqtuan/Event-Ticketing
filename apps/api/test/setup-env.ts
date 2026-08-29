/**
 * Runs before any test module is imported (jest `setupFiles`).
 *
 * This matters because `ConfigModule.forRoot({ validate })` executes when
 * `config.module.ts` is *imported*, not when the module is compiled — so any
 * suite that imports AppModule needs a valid environment already in place.
 * Setting it inside a `beforeAll` would be far too late.
 */
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/event_ticketing';
process.env.NODE_ENV ??= 'test';
