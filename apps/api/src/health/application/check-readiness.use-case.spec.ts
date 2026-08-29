import { CheckReadinessUseCase } from './check-readiness.use-case.js';
import { type MigrationsProbe } from '../domain/migrations-probe.port.js';
import { type ReadinessProbe } from '../domain/readiness-probe.port.js';

const database = (reachable: boolean): ReadinessProbe => ({
  isReachable: () => Promise.resolve(reachable),
});

const migrations = (pending: string[]): MigrationsProbe => ({
  pendingVersions: () => Promise.resolve(pending),
});

describe('CheckReadinessUseCase', () => {
  it('reports ready when the database is reachable and the schema is current', async () => {
    const status = await new CheckReadinessUseCase(database(true), migrations([])).execute();

    expect(status.ready).toBe(true);
    expect(status.dependencies).toEqual({ database: 'up', migrations: 'up' });
    expect(status.pendingMigrations).toEqual([]);
  });

  it('reports not ready when the database is unreachable', async () => {
    const status = await new CheckReadinessUseCase(database(false), migrations([])).execute();

    expect(status.ready).toBe(false);
    expect(status.dependencies).toEqual({ database: 'down', migrations: 'down' });
  });

  it('does not ask about migrations it cannot read — the ledger is a table', async () => {
    let asked = false;
    const probe: MigrationsProbe = {
      pendingVersions: () => {
        asked = true;
        return Promise.resolve([]);
      },
    };

    await new CheckReadinessUseCase(database(false), probe).execute();

    expect(asked).toBe(false);
  });

  it('reports not ready when this build ships migrations the database lacks', async () => {
    const pending = ['0004_ledger_append_only'];

    const status = await new CheckReadinessUseCase(database(true), migrations(pending)).execute();

    expect(status.ready).toBe(false);
    expect(status.dependencies).toEqual({ database: 'up', migrations: 'down' });
    // Named, so an operator reads which migration to run rather than guessing.
    expect(status.pendingMigrations).toEqual(pending);
  });

  it('exposes an immutable dependency map', async () => {
    const status = await new CheckReadinessUseCase(database(true), migrations([])).execute();

    expect(Object.isFrozen(status.dependencies)).toBe(true);
    expect(Object.isFrozen(status.pendingMigrations)).toBe(true);
  });
});
