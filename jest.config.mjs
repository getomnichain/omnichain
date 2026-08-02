export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  injectGlobals: true,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.ts$': '$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(rpc-websockets|uuid)/)',
  ],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.jest.json',
        diagnostics: { ignoreCodes: [151002, 2694, 2345, 2322] },
      },
    ],
  },
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
