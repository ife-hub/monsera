// The ported tests assume UTC (WAT day boundaries are computed explicitly).
process.env.TZ = 'UTC';

/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.(spec|test)\\.ts$',
  // Integration tests need a real database: npm run test:integration.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '\\.int\\.test\\.ts$'],
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest'), { isolatedModules: true, diagnostics: false }],
  },
};
