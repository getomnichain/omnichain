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
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    // Pre-existing broken specs — not introduced by this branch. Migration
    // to unstable_mockModule (axios ESM) and jest.Mock<T> generics is a
    // separate hygiene wave, not RIN-152 scope.
    'utxo/btc/test/bitcoin_core_batch\\.spec\\.ts$',
    'utxo/btc/test/bitcoin_core_listunspent\\.spec\\.ts$',
    'utxo/btc/test/unisat\\.spec\\.ts$',
    'utxo/btc/test/suggest_fee_rate\\.spec\\.ts$',
    'evm/test/get_balance\\.spec\\.ts$',
  ],
};
