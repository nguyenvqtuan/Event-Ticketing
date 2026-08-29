import type { Config } from 'jest';

/**
 * ESM config — required because NestJS 12 is ESM-only. Jest needs
 * `NODE_OPTIONS=--experimental-vm-modules` (set in the package scripts).
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  // ESM source imports './x.js'; on disk it is './x.ts'.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  /**
   * Coverage measures the layers unit tests are responsible for: `domain/`
   * (the rules) and `application/` (the use cases orchestrating them), both
   * framework-free by design and testable with plain fakes.
   *
   * `infrastructure/` and `interface/` are deliberately absent. Repositories,
   * filters and controllers are exercised by the integration suite against a
   * real Postgres, where the constraints and transactions they exist to drive
   * actually run — counting them here would either report them as untested or
   * invite mock-heavy unit tests that assert the mock.
   *
   * `*.port.ts` files hold an interface and a DI token: no logic to cover.
   */
  collectCoverageFrom: [
    '**/domain/**/*.ts',
    '**/application/**/*.ts',
    '!**/*.port.ts',
    '!**/*.spec.ts',
  ],
  coverageDirectory: '../coverage',
  // `text` for the terminal, `lcov` for an HTML report and for CI to archive.
  coverageReporters: ['text', 'lcov'],
  /**
   * Not a number to chase — a floor that fails the build when the rules stop
   * being tested. The domain carries the higher bar because a gap there is a
   * business rule nobody checks; `ledger.ts` keeps one uncoverable line, a
   * zero-amount guard no valid entry can reach, which is why it is 95 and not
   * 100.
   */
  coverageThreshold: {
    global: { statements: 95, branches: 95, functions: 95, lines: 95 },
    '**/domain/**/*.ts': { statements: 95, branches: 90, functions: 95, lines: 95 },
  },
  testEnvironment: 'node',
};

export default config;
