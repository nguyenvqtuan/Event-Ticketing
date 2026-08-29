/**
 * A port for "is the schema this build expects actually in the database?".
 *
 * Reachability is a different question. A database that answers `SELECT 1`
 * while two migrations behind will reject every query the new code makes, so
 * an instance pointed at one is not ready — even though it is perfectly alive.
 */
export interface MigrationsProbe {
  /**
   * Versions shipped with this build that the database has not recorded as
   * applied. Empty means the schema is where this build expects it.
   *
   * Total by contract: an unreadable ledger is reported as "everything is
   * pending", never as a thrown error, because a readiness check that throws
   * turns a 503 into a 500.
   */
  pendingVersions(): Promise<readonly string[]>;
}

/** DI token — interfaces do not survive compilation. */
export const MIGRATIONS_PROBE = Symbol('MIGRATIONS_PROBE');
