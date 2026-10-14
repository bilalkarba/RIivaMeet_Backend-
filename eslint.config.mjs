import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src/generated/**',
      'prisma/migrations/**',
      '.tmp/**',
      '.pgdata/**',
      // The Angular app is a separate project with its own toolchain (Angular CLI /
      // `ng`). This config lints the backend, so its sources and build output are not
      // inspected here - otherwise `.angular/cache` and `dist` bundles dominate the run.
      'frontend/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // The API itself must use the structured logger, but CLI tooling legitimately
      // talks to the terminal.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // Migration/dev scripts, the seed and the test suite print to stdout by design.
    files: ['scripts/**/*.ts', 'prisma/seed.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
