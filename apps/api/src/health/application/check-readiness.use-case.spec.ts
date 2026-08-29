import { CheckReadinessUseCase } from './check-readiness.use-case.js';
import { type ReadinessProbe } from '../domain/readiness-probe.port.js';

const probe = (reachable: boolean | (() => Promise<never>)): ReadinessProbe => ({
  isReachable: typeof reachable === 'function' ? reachable : () => Promise.resolve(reachable),
});

describe('CheckReadinessUseCase', () => {
  it('reports ready when the database is reachable', async () => {
    const status = await new CheckReadinessUseCase(probe(true)).execute();

    expect(status.ready).toBe(true);
    expect(status.dependencies).toEqual({ database: 'up' });
  });

  it('reports not ready when the database is unreachable', async () => {
    const status = await new CheckReadinessUseCase(probe(false)).execute();

    expect(status.ready).toBe(false);
    expect(status.dependencies).toEqual({ database: 'down' });
  });

  it('exposes an immutable dependency map', async () => {
    const status = await new CheckReadinessUseCase(probe(true)).execute();

    expect(Object.isFrozen(status.dependencies)).toBe(true);
  });
});
