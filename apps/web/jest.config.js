/**
 * Unit tests for the parts of this app that are plain TypeScript — the API
 * client and its error mapping.
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
