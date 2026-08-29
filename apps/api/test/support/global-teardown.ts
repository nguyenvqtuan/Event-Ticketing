/**
 * Stops the container started by global setup. When `TEST_DATABASE_URL` was
 * supplied there is nothing to stop — the databases are left in place, which
 * is useful for inspecting a failure and harmless because the next run drops
 * and recreates them.
 */
export default async function globalTeardown(): Promise<void> {
  await globalThis.__POSTGRES_CONTAINER__?.stop();
}
