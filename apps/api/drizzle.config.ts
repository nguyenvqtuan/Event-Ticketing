import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only ever *generates* SQL here — it is never pointed at a
 * database to push a schema. Migrations are applied by scripts/migrate.ts so
 * that every change is a reviewed, versioned file.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/infrastructure/database/schema.ts',
  out: './migrations',
  casing: 'snake_case',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/event_ticketing',
  },
});
