/** Immutable result of a readiness check. Plain TypeScript, as ever. */
export class ReadinessStatus {
  private constructor(
    readonly ready: boolean,
    readonly dependencies: Readonly<Record<string, 'up' | 'down'>>,
  ) {}

  static from(dependencies: Record<string, 'up' | 'down'>): ReadinessStatus {
    const ready = Object.values(dependencies).every((state) => state === 'up');

    return new ReadinessStatus(ready, Object.freeze({ ...dependencies }));
  }
}
