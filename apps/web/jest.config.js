/**
 * Unit tests for the API client, its error mapping, and the booking flow.
 *
 * `testEnvironment` stays `node`; the component suites opt into jsdom with a
 * `@jest-environment jsdom` docblock. Paying for a DOM in every suite would
 * slow the pure-logic ones down for nothing.
 *
 * ESM, like the API's suite and for the same reason: the code under test is
 * ESM and `@repo/contracts` is an ESM package, so `--experimental-vm-modules`
 * (set in the package scripts) is the honest way to run it rather than
 * transpiling both down to CommonJS and testing something other than what
 * ships.
 *
 * No jsdom and no React Testing Library yet — there are no components worth
 * testing until TICK-F2 draws the seat map. Adding the DOM harness then, with
 * something to point it at, beats configuring it now against nothing.
 */
module.exports = {
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.tsx?$',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  // jest-dom's matchers (toBeDisabled, toHaveTextContent) for the component
  // tests. Harmless for the pure-logic suites, which simply do not use them.
  setupFilesAfterEnv: ['<rootDir>/../jest.setup.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/../tsconfig.jest.json' }],
  },
  // Source imports './x.js'; on disk it is './x.ts'.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['lib/**/*.ts', '!**/*.spec.ts'],
  coverageDirectory: '../coverage',
  coverageReporters: ['text', 'lcov'],
};
