// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['www/', 'android/', 'node_modules/', '.angular/', '.test-dist/', 'runner/dist/'] },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      ...angular.configs.tsRecommended,
      prettier,
    ],
    languageOptions: { parserOptions: { project: './tsconfig.check.json', tsconfigRootDir: import.meta.dirname } },
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'app', style: 'kebab-case' }],
      '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'app', style: 'camelCase' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Las respuestas de las APIs externas se leen como `Record<string, unknown>`: la notación con corchetes es la
      // que exige `noPropertyAccessFromIndexSignature`-style y deja claro que el campo no está tipado.
      '@typescript-eslint/dot-notation': 'off',
      // Los hooks de Angular (ngOnInit…) pueden ser async: Angular ignora la promesa a propósito.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { inheritedMethods: false } }],
      // En el código que valida datos externos, las guardas explícitas (`!x || x.y !== z`) se leen mejor.
      '@typescript-eslint/prefer-optional-chain': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
  {
    files: ['test/**/*.mjs', '*.mjs'],
    extends: [eslint.configs.recommended, prettier],
    languageOptions: { globals: { process: 'readonly', globalThis: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
