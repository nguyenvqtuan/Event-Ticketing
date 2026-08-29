import { CheckHealthUseCase } from './check-health.use-case.js';
import { type HealthProbe } from '../domain/health-probe.port.js';

/**
 * Note what this test does NOT need: no Nest testing module, no DI container,
 * no database. That is the payoff of keeping the inner layers framework-free.
 */
const probeReturning = (seconds: number): HealthProbe => ({
  uptimeSeconds: () => seconds,
});

describe('CheckHealthUseCase', () => {
  it('reports ok once the process has been up for at least a second', () => {
    const useCase = new CheckHealthUseCase(probeReturning(42.7));

    const status = useCase.execute();

    expect(status.state).toBe('ok');
    expect(status.isHealthy).toBe(true);
    expect(status.uptimeSeconds).toBe(42);
  });

  it('reports degraded while the process is still warming up', () => {
    const useCase = new CheckHealthUseCase(probeReturning(0.4));

    expect(useCase.execute().state).toBe('degraded');
  });

  it('rejects a nonsensical uptime rather than reporting a bogus status', () => {
    const useCase = new CheckHealthUseCase(probeReturning(-1));

    expect(() => useCase.execute()).toThrow(/non-negative/);
  });
});
