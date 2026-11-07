/** Type-aware policy covers repository scripts and every future workspace source. */
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import eslintConfigPrettier from 'eslint-config-prettier';

export default defineConfig(
  {
    // Build products and isolated fixtures are not maintained TypeScript sources.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/temp/**',
      'scratch/**',
      '.tmp/**',
      '.pnpm-store/**',
      '.cache/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Flat config uses ESLint's native unused-directive check; the plugin rule
    // remains enabled for consumers using its legacy verification path.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { '@eslint-community/eslint-comments': eslintComments },
    rules: {
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message: 'Maintained executable logic must be TypeScript.',
        },
      ],
    },
  },
  eslintConfigPrettier,
);
