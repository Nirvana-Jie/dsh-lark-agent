import {defineConfig} from 'vitest/config';

const clientTests = ['tests/client-*.test.tsx'];
const compatibilityTests = [
  'tests/client-modern-host.test.tsx',
  'tests/dsh-runtime-modern.test.ts',
  'tests/dsh-runtime-model-native.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {test: {
        name: 'host',
        environment: 'node',
        include: ['tests/**/*.test.{ts,tsx}'],
        exclude: [...clientTests, ...compatibilityTests],
      }},
      {test: {
        name: 'client',
        environment: 'jsdom',
        include: clientTests,
        exclude: compatibilityTests,
        setupFiles: ['tests/client-setup.ts'],
      }},
      {test: {
        // These tests use isolated real host packages or the installed App's
        // public modules. Their existing guards skip unavailable prerequisites.
        name: 'compat',
        environment: 'node',
        include: compatibilityTests,
        testTimeout: 30_000,
      }},
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
