/**
 * Jest — the "pytest" of this repo. Pure TypeScript runs under Node; native
 * modules are replaced by test doubles in __mocks__/ and jest.setup.ts.
 * SQLite is NOT mocked away: @op-engineering/op-sqlite is backed by
 * better-sqlite3 (with FTS5), so every SQL statement is executed for real.
 */
module.exports = {
  preset: 'react-native',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  transformIgnorePatterns: [
    'node_modules/(?!(@react-native|react-native|@react-native-async-storage|cactus-react-native|react-native-nitro-modules|@op-engineering)/)',
  ],
  moduleNameMapper: {
    '^@op-engineering/op-sqlite$': '<rootDir>/__mocks__/@op-engineering/op-sqlite.ts',
    '^@dr.pogodin/react-native-fs$': '<rootDir>/__mocks__/@dr.pogodin/react-native-fs.ts',
    '^cactus-react-native$': '<rootDir>/__mocks__/cactus-react-native.ts',
    '^react-native-nitro-modules$': '<rootDir>/__mocks__/react-native-nitro-modules.ts',
  },
  collectCoverageFrom: [
    'src/agent/**/*.ts',
    'src/inference/**/*.ts',
    'src/tools/**/*.ts',
    'src/memory/**/*.ts',
    'src/skills/**/*.ts',
    'src/scheduler/**/*.ts',
    'src/observability/**/*.ts',
    'src/security/**/*.ts',
    'src/storage/**/*.ts',
    'src/mcp/**/*.ts',
    'src/meetings/**/*.ts',
    'src/tasks/**/*.ts',
  ],
};
