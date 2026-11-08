import js from '@eslint/js'

/**
 * TypeScript sources are checked by `test/security-surface.test.ts` (module
 * boundaries) and `pnpm typecheck`. typescript-eslint does not yet support
 * TypeScript 7 (peer range ends at <6.1.0), so ESLint here covers JS/MJS and
 * the package scripts surface.
 */
export default [
  {
    ignores: [
      'out/**',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'server/dist/**',
      'server/node_modules/**',
      '**/*.{ts,tsx}',
      'src/main/services/processGroup.mjs'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['eslint.config.mjs', 'scripts/**/*.{js,mjs,cjs}', 'test/**/*.{js,mjs,cjs}'],
    rules: {
      'no-console': 'off'
    }
  }
]
